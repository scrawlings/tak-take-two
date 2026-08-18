// PTN: parse a record into typed moves (validated by replay from an empty
// board) and generate PTN text for a game or a replayable prefix.
// Pure module — no I/O, no framework dependencies, no exceptions.
// Every failure path returns a neverthrow Result. Syntax follows the USTak
// portable tak notation spec (ustak.org).

import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import { applyMove, createGame } from './game';
import type {
  BoardSize,
  Direction,
  File,
  Move,
  Player,
  Rank,
  ResultCode,
  Square,
  StoneKind,
} from './types';
import type { PtnError, PtnGame, PtnOptions } from './types';

const RESULT_CODES: readonly ResultCode[] = [
  'R-0',
  '0-R',
  'F-0',
  '0-F',
  '1-0',
  '0-1',
  '1/2-1/2',
  '*',
];

/** Informational marks that may trail a move: crush `*`, tak `'`, tinuë `''`, evaluation `! ?`. */
const MARK_CHARS = new Set(['*', "'", '!', '?']);

/** A tag group: `[Key "Value"]` (value may contain escaped quotes). */
const TAG_RE = /^\s*\[([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]/;

/** A place move: `(stone)?(square)`; flat is assumed when the stone is omitted. */
const PLACE_RE = /^([SCFscf]?)([a-f][1-6])$/;

/**
 * A stack move: `(count)?(square)(direction)(drops)?(stone)?`.
 * The lift count may be omitted when 1; the drop counts may be omitted when
 * all stones land on the square adjacent to the source; the trailing stone
 * letter records the top stone of the moved stack and is informational.
 * The `↑ ↓ ← →` arrows are the alternate direction identifiers.
 */
const STACK_RE = /^(?:(\d+))?([a-f][1-6])([<>+\-↑↓←→])(?:(\d+))?([SCFscf]?)$/;

/** A move number token: `N.`. */
const NUMBER_RE = /^(\d+)\.$/;

/** The PGN-style `N...` form, which PTN does not define. */
const ELLIPSIS_RE = /^(\d+)\.\.\.$/;

function ptnError(code: PtnError['code'], message: string, extra: Partial<PtnError> = {}): PtnError {
  return { code, message, ...extra };
}

/** Remove `{ ... }` comments (spec: anything but `}` inside), replacing each with a space. */
function stripComments(text: string): Result<string, PtnError> {
  let out = '';
  let inComment = false;
  for (const ch of text) {
    if (inComment) {
      if (ch === '}') inComment = false;
    } else if (ch === '{') {
      inComment = true;
      out += ' ';
    } else {
      out += ch;
    }
  }
  if (inComment) {
    return err(ptnError('ptn-unterminated-comment', 'a comment is missing its closing }'));
  }
  return ok(out);
}

/** Parse the leading `[Key "Value"]` tag groups (which may share lines). */
function parseTags(text: string): Result<{ tags: Map<string, string>; rest: string }, PtnError> {
  const tags = new Map<string, string>();
  let rest = text;
  for (;;) {
    const match = TAG_RE.exec(rest);
    if (match === null) break;
    tags.set(match[1]!, match[2]!.replace(/\\(.)/g, '$1'));
    rest = rest.slice(match[0].length);
  }
  if (rest.trimStart().startsWith('[')) {
    return err(
      ptnError('ptn-bad-tag', `malformed tag near "${rest.trimStart().slice(0, 40)}"`),
    );
  }
  return ok({ tags, rest });
}

/** Read the board size from the `[Size]` tag (required for replay). */
function parseSize(tags: Map<string, string>): Result<BoardSize, PtnError> {
  let sizeText: string | undefined;
  for (const [key, value] of tags) {
    if (key.toLowerCase() === 'size') sizeText = value;
  }
  if (sizeText === undefined) {
    return err(
      ptnError('ptn-missing-size', 'no [Size] tag; a board size of 5 or 6 is required to validate the moves'),
    );
  }
  if (sizeText !== '5' && sizeText !== '6') {
    return err(ptnError('ptn-bad-size', `[Size] "${sizeText}" is not a supported board size (5 or 6)`));
  }
  return ok(sizeText === '5' ? 5 : 6);
}

function parseSquare(text: string): Square {
  return [text[0] as File, Number(text[1]) as Rank] as unknown as Square;
}

function stoneKind(letter: string | undefined): StoneKind {
  switch (letter?.toLowerCase()) {
    case 's':
      return 'standing';
    case 'c':
      return 'capstone';
    default:
      return 'flat';
  }
}

function parseDirection(s: string): Direction {
  switch (s) {
    case '<':
      return '<';
    case '>':
      return '>';
    case '+':
      return '+';
    case '-':
      return '-';
    case '↑':
      return '+';
    case '↓':
      return '-';
    case '←':
      return '<';
    default:
      return '>'; // '→'
  }
}

/** Parse one move token into a typed move; no board context is needed here. */
function parseMoveToken(token: string): Result<Move, PtnError> {
  const place = PLACE_RE.exec(token);
  if (place !== null) {
    return ok({ type: 'place', square: parseSquare(place[2]!), stone: stoneKind(place[1]) });
  }

  const stack = STACK_RE.exec(token);
  if (stack !== null) {
    const count = stack[1] === undefined ? 1 : Number(stack[1]);
    let drops: number[];
    if (stack[4] === undefined) {
      drops = [count];
    } else {
      drops = [...stack[4]].map((d) => Number(d));
      if (drops.some((d) => d === 0)) {
        return err(
          ptnError('ptn-bad-drops', `"${token}": a drop count of 0 is not allowed (drop at least one stone per square)`, {
            token,
          }),
        );
      }
    }
    const sum = drops.reduce((a, b) => a + b, 0);
    if (sum !== count) {
      return err(
        ptnError(
          'ptn-drops-mismatch',
          `"${token}": drop counts sum to ${sum}, but the lift count is ${count}`,
          { token },
        ),
      );
    }
    return ok({
      type: 'move',
      square: parseSquare(stack[2]!),
      direction: parseDirection(stack[3]!),
      drops,
    });
  }

  return err(ptnError('ptn-invalid-token', `"${token}" is not a valid PTN move`, { token }));
}

/** Drop a trailing run of informational marks (`* ' ! ?`). */
function stripMarks(token: string): string {
  let end = token.length;
  while (end > 0 && MARK_CHARS.has(token[end - 1]!)) end--;
  return token.slice(0, end);
}

/** Whether `token` is one of the PTN result codes (including the open `*`). */
export function isResultCode(token: string): token is ResultCode {
  return (RESULT_CODES as readonly string[]).includes(token);
}

/** Replay the moves from an empty board, rejecting the first illegal move. */
function validateByReplay(size: BoardSize, moves: readonly Move[]): Result<null, PtnError> {
  let state = createGame(size);
  for (let i = 0; i < moves.length; i++) {
    const applied = applyMove(state, moves[i]!);
    if (applied.isErr()) {
      const moveNumber = Math.floor(i / 2) + 1;
      const player: Player = i % 2 === 0 ? 1 : 2;
      return err(
        ptnError(
          'ptn-illegal-move',
          `move ${moveNumber} (player ${player}) is illegal: ${applied.error.message}`,
          { moveNumber, player, ruleError: applied.error },
        ),
      );
    }
    state = applied.value;
  }
  return ok(null);
}

/**
 * Parse a PTN record into typed moves, then validate the whole record by
 * replaying it from an empty board. The first illegal move is rejected with an
 * error identifying it (full-move number, player, and the underlying rule error).
 */
export function parsePtn(text: string): Result<PtnGame, PtnError> {
  const stripped = stripComments(text);
  if (stripped.isErr()) return err(stripped.error);

  const tags = parseTags(stripped.value);
  if (tags.isErr()) return err(tags.error);

  const size = parseSize(tags.value.tags);
  if (size.isErr()) return err(size.error);

  const tokens = tags.value.rest.trim().split(/\s+/).filter((t) => t.length > 0);

  const moves: Move[] = [];
  let result: ResultCode | null = null;
  // The record must read: number, P1 move, P2 move, number, P1 move, P2 move, …
  let awaiting: 'number' | 'p1' | 'p2' = 'number';
  let nextNumber = 1;

  for (const raw of tokens) {
    if (isResultCode(raw)) {
      if (result !== null) {
        return err(ptnError('ptn-duplicate-result', `the result was already given as ${result}`));
      }
      result = raw;
      continue;
    }

    const bare = stripMarks(raw);
    if (bare === '') continue; // a standalone annotation (! ? ' '' …)

    if (NUMBER_RE.test(raw)) {
      if (result !== null) {
        return err(ptnError('ptn-move-after-result', `a move or move number follows the result ${result}`));
      }
      if (awaiting !== 'number') {
        const who = awaiting === 'p1' ? "player 1's" : "player 2's";
        return err(
          ptnError('ptn-bad-move-number', `unexpected move number ${raw}; expected ${who} move of move ${nextNumber}`),
        );
      }
      const n = Number(raw.slice(0, -1));
      if (n !== nextNumber) {
        return err(ptnError('ptn-bad-move-number', `expected move number ${nextNumber}, found ${n}`));
      }
      awaiting = 'p1';
      continue;
    }

    const ellipsis = ELLIPSIS_RE.exec(raw);
    if (ellipsis !== null) {
      return err(
        ptnError(
          'ptn-bad-move-number',
          `"${raw}": ellipsis move numbers are not part of PTN; player 1's move of move ${ellipsis[1]} is missing`,
        ),
      );
    }

    if (result !== null) {
      return err(ptnError('ptn-move-after-result', `a move follows the result ${result}`));
    }

    const move = parseMoveToken(bare);
    if (move.isErr()) return err(move.error);

    if (awaiting === 'p1') {
      moves.push(move.value);
      awaiting = 'p2';
    } else if (awaiting === 'p2') {
      moves.push(move.value);
      awaiting = 'number';
      nextNumber++;
    } else {
      return err(ptnError('ptn-bad-move-number', `expected move number ${nextNumber} before "${raw}"`));
    }
  }

  const replay = validateByReplay(size.value, moves);
  if (replay.isErr()) return err(replay.error);

  return ok({ tags: tags.value.tags, size: size.value, moves, result });
}

/**
 * Parse a single PTN move token (a place or stack move) into a typed `Move`.
 * No move numbers, tags, or result codes — this is the move-entry validator:
 * the web parses a submitted move with it, then the engine checks legality.
 */
export function parseMove(text: string): Result<Move, PtnError> {
  const stripped = stripComments(text);
  if (stripped.isErr()) return err(stripped.error);
  const token = stripMarks(stripped.value.trim());
  if (token === '' || /\s/.test(token)) {
    return err(
      ptnError('ptn-invalid-token', `"${text.trim()}" is not a single PTN move`, { token: text.trim() }),
    );
  }
  return parseMoveToken(token);
}

function formatSquare(sq: Square): string {
  return `${sq[0]}${sq[1]}`;
}

/** Format a single move as canonical PTN (`a1`, `Sa1`, `Ca1`, `5b4>212`). */
export function formatMove(move: Move): string {
  if (move.type === 'place') {
    const stone = move.stone === 'flat' ? '' : move.stone === 'standing' ? 'S' : 'C';
    return `${stone}${formatSquare(move.square)}`;
  }
  const lift = move.drops.reduce((a, b) => a + b, 0);
  return `${lift}${formatSquare(move.square)}${move.direction}${move.drops.join('')}`;
}

/**
 * Escape a tag value the way `parseTags` reads one back: it unescapes `\x` to
 * `x`, so a value carrying a quote or a backslash must arrive escaped or the
 * record it lands in cannot be re-imported. Tag values hold names their owners
 * choose, so these characters are input, not a corner case.
 */
function escapeTagValue(value: string): string {
  return value.replace(/[\\"]/g, '\\$&');
}

/**
 * Generate PTN text for a game or a replayable prefix. The moves are replayed
 * from an empty board first, so an illegal sequence is rejected rather than
 * emitted. A prefix (any number of moves up to a chosen point) replays cleanly
 * and produces text without a result; pass `result` for a finished game.
 */
export function generatePtn(
  moves: readonly Move[],
  size: BoardSize,
  options: PtnOptions = {},
): Result<string, PtnError> {
  const replay = validateByReplay(size, moves);
  if (replay.isErr()) return err(replay.error);

  const lines: string[] = [`[Size "${size}"]`];
  for (const [key, value] of options.tags ?? []) {
    const lower = key.toLowerCase();
    if (lower === 'size' || lower === 'result') continue; // derived from the arguments
    lines.push(`[${key} "${escapeTagValue(value)}"]`);
  }
  if (options.result !== undefined) lines.push(`[Result "${options.result}"]`);
  lines.push('');

  for (let i = 0; i < moves.length; i += 2) {
    const number = i / 2 + 1;
    const first = formatMove(moves[i]!);
    const second = i + 1 < moves.length ? formatMove(moves[i + 1]!) : null;
    lines.push(second === null ? `${number}. ${first}` : `${number}. ${first} ${second}`);
  }

  if (options.result !== undefined) {
    if (moves.length === 0) {
      lines.push(options.result);
    } else {
      const last = lines[lines.length - 1]!;
      lines[lines.length - 1] = `${last} ${options.result}`;
    }
  }

  return ok(lines.join('\n'));
}
