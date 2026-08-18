// The headless game aggregate: a playable Tak game with a full, immutable move
// history (per-move timestamps), undo, resign, mutual draw, and finished state,
// loaded from a new board, from PTN, or from a stored record (ADR-0005).
// Pure module — no I/O, no framework dependencies, no exceptions.
// Every failure path returns a neverthrow Result.

import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import { applyMove, computeOutcome, createGame } from './game';
import { generatePtn, isResultCode, parseMove, parsePtn } from './ptn';
import { parseTps } from './tps';
import { opponent } from './types';
import type {
  BoardSize,
  GameState,
  Move,
  Outcome,
  Player,
  PtnError,
  PtnGame,
  PtnOptions,
  ResultCode,
  RuleError,
} from './types';

/** A single recorded move with the time it was played. */
export interface RecordedMove {
  readonly move: Move;
  /** Epoch milliseconds when the move was played; null for imported (fixed) history. */
  readonly playedAt: number | null;
}

/** How a game ended. `board` is a road/flat win detected by the rules engine. */
export type GameEnd =
  | { readonly kind: 'board'; readonly outcome: Outcome }
  | { readonly kind: 'resign'; readonly winner: Player }
  | { readonly kind: 'mutual-draw' };

/**
 * A headless game: the current rules state plus the full move history.
 * The first `fixedMoves` history entries are imported (fixed) and cannot be
 * undone; everything after them is live and undoable while the game is in play.
 */
export interface TakGame {
  /** The current board state (position, turn, reserves, engine outcome). */
  readonly state: GameState;
  /** Every move in play order, each with its timestamp (null for imported moves). */
  readonly history: readonly RecordedMove[];
  /** Number of leading history entries that are fixed (imported) and not undoable. */
  readonly fixedMoves: number;
  /** Non-null once the game has ended (board win, resign, or mutual draw). */
  readonly result: GameEnd | null;
}

export type GameErrorCode =
  | 'game-finished'
  | 'no-move-to-undo'
  | 'invalid-move'
  /** A stored record no longer parses or replays: the data is corrupt, not the input. */
  | 'corrupt-record'
  /** A move number outside the record's history was asked for. */
  | 'invalid-move-number';

export interface GameError {
  readonly code: GameErrorCode;
  readonly message: string;
  /** The underlying rules error when `code` is `invalid-move`. */
  readonly ruleError?: RuleError;
}

function gameError(code: GameErrorCode, message: string, extra: Partial<GameError> = {}): GameError {
  return { code, message, ...extra };
}

/** Replay moves from an empty board, returning the final state (or a rule error). */
function replay(size: BoardSize, moves: readonly Move[]): Result<GameState, RuleError> {
  let state = createGame(size);
  for (const m of moves) {
    const applied = applyMove(state, m);
    if (applied.isErr()) return err(applied.error);
    state = applied.value;
  }
  return ok(state);
}

/** The aggregate-level end implied by an engine outcome, if any. */
function boardEnd(state: GameState): GameEnd | null {
  return state.outcome === null ? null : { kind: 'board', outcome: state.outcome };
}

/** Map a PTN result code to an aggregate end (board, resign, or draw). */
function endFromCode(code: ResultCode | null): GameEnd | null {
  switch (code) {
    case 'R-0':
      return { kind: 'board', outcome: { type: 'road', winner: 1 } };
    case '0-R':
      return { kind: 'board', outcome: { type: 'road', winner: 2 } };
    case 'F-0':
      return { kind: 'board', outcome: { type: 'flat', winner: 1 } };
    case '0-F':
      return { kind: 'board', outcome: { type: 'flat', winner: 2 } };
    case '1-0':
      return { kind: 'resign', winner: 1 };
    case '0-1':
      return { kind: 'resign', winner: 2 };
    case '1/2-1/2':
      return { kind: 'mutual-draw' };
    case '*':
    case null:
      return null; // abandoned / no recorded result — not a modelled finish
  }
}

/** Create a new empty game on a 5×5 or 6×6 board. */
export function createTakGame(size: BoardSize): TakGame {
  return { state: createGame(size), history: [], fixedMoves: 0, result: null };
}

export interface FromPtnOptions {
  /** Timestamp stamped on every imported move (e.g. the import time). Defaults to null. */
  readonly playedAt?: number | null;
}

/** Load a parsed, replay-validated PTN game as fixed history. */
export function fromPtn(game: PtnGame, options: FromPtnOptions = {}): Result<TakGame, GameError> {
  const replayed = replay(game.size, game.moves);
  if (replayed.isErr()) {
    return err(
      gameError('invalid-move', `imported record contains an illegal move: ${replayed.error.message}`, {
        ruleError: replayed.error,
      }),
    );
  }
  const playedAt = options.playedAt ?? null;
  const history: RecordedMove[] = game.moves.map((move) => ({ move, playedAt }));
  const result = boardEnd(replayed.value) ?? endFromCode(game.result);
  return ok({ state: replayed.value, history, fixedMoves: history.length, result });
}

/** Load a PTN record from text (parse + replay-validate + load as fixed history). */
export function fromPtnText(
  text: string,
  options: FromPtnOptions = {},
): Result<TakGame, GameError | PtnError> {
  const parsed = parsePtn(text);
  if (parsed.isErr()) return err(parsed.error);
  return fromPtn(parsed.value, options);
}

/** One stored live move: what was played, when, and the position it produced. */
export interface StoredMove {
  /** The move as canonical PTN (`a1`, `Sa1`, `5b4>212`). */
  readonly notation: string;
  /** Epoch milliseconds when the move was played. */
  readonly playedAt: number | null;
  /** TPS of the position after this move — the read path. Null means replay. */
  readonly position: string | null;
}

/**
 * A stored game, as a store hands it back: the board size, the PTN it was
 * imported from (if any), the live moves played since, and the result string
 * recorded when it ended. `loadGame` folds this back into a playable game.
 */
export interface StoredGame {
  readonly size: BoardSize;
  /** The PTN this game was imported from, or null when it started empty. */
  readonly importedPtn: string | null;
  /** The live moves in play order, after any imported history. */
  readonly moves: readonly StoredMove[];
  /** The stored PTN result code, or null while the game is in play. */
  readonly result: string | null;
}

function corrupt(reason: string): GameError {
  return gameError('corrupt-record', reason);
}

/**
 * The position a record starts its live moves from: the replayed import, or an
 * empty board. The imported record's own result tag is dropped — the stored
 * result string is the only word on how *this* game ended.
 */
function importedPrefix(record: StoredGame): Result<TakGame, GameError> {
  if (record.importedPtn === null) return ok(createTakGame(record.size));
  const loaded = fromPtnText(record.importedPtn);
  if (loaded.isErr()) {
    return err(corrupt(`the imported record no longer replays: ${loaded.error.message}`));
  }
  if (loaded.value.state.size !== record.size) {
    return err(
      corrupt(`the imported record is a ${loaded.value.state.size}x${loaded.value.state.size} game, not ${record.size}x${record.size}`),
    );
  }
  return ok({ ...loaded.value, result: null });
}

/**
 * Parse live move `index` of a record, naming its number in the full history
 * when it fails. The numbering lives here so every caller says it the same way.
 */
function storedMove(record: StoredGame, fixedMoves: number, index: number): Result<Move, GameError> {
  const parsed = parseMove(record.moves[index]!.notation);
  if (parsed.isErr()) {
    return err(corrupt(`stored move ${fixedMoves + index + 1} no longer parses: ${parsed.error.message}`));
  }
  return ok(parsed.value);
}

/** The end a stored result string records, or null while the game is in play. */
function storedEnd(result: string | null): Result<GameEnd | null, GameError> {
  if (result === null) return ok(null);
  if (!isResultCode(result)) return err(corrupt(`stored result "${result}" is not a PTN result code`));
  return ok(endFromCode(result));
}

/**
 * Restore a stored position: parse the TPS, then recover the engine's verdict,
 * which TPS does not carry. `last` is the move that reached the position — its
 * mover is whoever is not to move, and only a placement can exhaust a reserve.
 */
function restoreState(position: string, size: BoardSize, last: Move): Result<GameState, GameError> {
  const parsed = parseTps(position);
  if (parsed.isErr()) {
    return err(corrupt(`stored position "${position}" no longer parses: ${parsed.error.message}`));
  }
  const state = parsed.value;
  if (state.size !== size) {
    return err(corrupt(`stored position "${position}" is a ${state.size}x${state.size} board, not ${size}x${size}`));
  }
  const outcome = computeOutcome(state, opponent(state.playerToMove), last.type === 'place');
  return ok({ ...state, outcome });
}

/**
 * The state after the first `count` live moves — the snapshot of move `count`
 * when it has one, else a replay of those moves from the post-import position.
 * `count` is at least 1.
 */
function liveState(base: TakGame, record: StoredGame, count: number): Result<GameState, GameError> {
  const position = record.moves[count - 1]!.position;
  if (position !== null) {
    return storedMove(record, base.fixedMoves, count - 1).andThen((move) =>
      restoreState(position, record.size, move),
    );
  }
  let state = base.state;
  for (let i = 0; i < count; i++) {
    const move = storedMove(record, base.fixedMoves, i);
    if (move.isErr()) return err(move.error);
    const applied = applyMove(state, move.value);
    if (applied.isErr()) {
      return err(corrupt(`stored move ${base.fixedMoves + i + 1} no longer replays: ${applied.error.message}`));
    }
    state = applied.value;
  }
  return ok(state);
}

/**
 * Materialize a stored game as a playable one (ADR-0005). Pure: the record
 * goes in, a `TakGame` comes out. Reads trust the write seam — the last live
 * move's stored position *is* the state, and full replay is only the fallback
 * for what no snapshot covers. A record that no longer parses or replays is
 * `corrupt-record`; the reason never names a game id, which is the store's to
 * compose.
 */
export function loadGame(record: StoredGame): Result<TakGame, GameError> {
  const prefix = importedPrefix(record);
  if (prefix.isErr()) return err(prefix.error);
  const base = prefix.value;

  const result = storedEnd(record.result);
  if (result.isErr()) return err(result.error);

  const live: RecordedMove[] = [];
  for (const [i, row] of record.moves.entries()) {
    const move = storedMove(record, base.fixedMoves, i);
    if (move.isErr()) return err(move.error);
    live.push({ move: move.value, playedAt: row.playedAt });
  }

  const state =
    record.moves.length === 0 ? ok<GameState, GameError>(base.state) : liveState(base, record, record.moves.length);
  if (state.isErr()) return err(state.error);

  return ok({
    state: state.value,
    history: [...base.history, ...live],
    fixedMoves: base.fixedMoves,
    // The stored string is authoritative — resign and draw exist nowhere else.
    // Where it says nothing, a decided position still ended the game, which is
    // what a full replay reports and what keeps `isFinished` and the board from
    // disagreeing.
    result: result.value ?? boardEnd(state.value),
  });
}

/**
 * The state after move `n` of a stored record's full history: the empty board
 * at 0, the stored snapshot inside the live moves, and a replay when `n` cuts
 * inside imported history, which no snapshot covers.
 */
export function stateAfter(record: StoredGame, n: number): Result<GameState, GameError> {
  if (!Number.isInteger(n) || n < 0) {
    return err(gameError('invalid-move-number', `move number ${n} is not a move in this record`));
  }
  if (n === 0) return ok(createGame(record.size));

  const prefix = importedPrefix(record);
  if (prefix.isErr()) return err(prefix.error);
  const base = prefix.value;

  const totalMoves = base.fixedMoves + record.moves.length;
  if (n > totalMoves) {
    return err(gameError('invalid-move-number', `this record has ${totalMoves} moves; ${n} is beyond it`));
  }
  if (n === base.fixedMoves) return ok(base.state);
  if (n < base.fixedMoves) {
    const replayed = replay(record.size, base.history.slice(0, n).map((r) => r.move));
    if (replayed.isErr()) {
      return err(corrupt(`the imported record no longer replays to move ${n}: ${replayed.error.message}`));
    }
    return ok(replayed.value);
  }
  return liveState(base, record, n - base.fixedMoves);
}

/** Play a move, recording it with a timestamp. */
export function playMove(game: TakGame, move: Move, playedAt: number = Date.now()): Result<TakGame, GameError> {
  if (game.result !== null) {
    return err(gameError('game-finished', 'the game has already finished'));
  }
  const applied = applyMove(game.state, move);
  if (applied.isErr()) {
    return err(gameError('invalid-move', applied.error.message, { ruleError: applied.error }));
  }
  const history = [...game.history, { move, playedAt }];
  return ok({ state: applied.value, history, fixedMoves: game.fixedMoves, result: boardEnd(applied.value) });
}

/** Undo the last live move, restoring the prior state. Only possible while in play. */
export function undo(game: TakGame): Result<TakGame, GameError> {
  if (game.result !== null) {
    return err(gameError('game-finished', 'cannot undo a finished game'));
  }
  if (game.history.length <= game.fixedMoves) {
    return err(gameError('no-move-to-undo', 'there is no live move to undo'));
  }
  const moves = game.history.slice(0, -1).map((r) => r.move);
  const replayed = replay(game.state.size, moves);
  if (replayed.isErr()) {
    return err(gameError('invalid-move', replayed.error.message, { ruleError: replayed.error }));
  }
  return ok({ state: replayed.value, history: game.history.slice(0, -1), fixedMoves: game.fixedMoves, result: null });
}

/** Resign as `player`; the opponent wins. */
export function resign(game: TakGame, player: Player): Result<TakGame, GameError> {
  if (game.result !== null) {
    return err(gameError('game-finished', 'the game has already finished'));
  }
  return ok({ ...game, result: { kind: 'resign', winner: opponent(player) } });
}

/** End the game as an agreed draw. */
export function mutualDraw(game: TakGame): Result<TakGame, GameError> {
  if (game.result !== null) {
    return err(gameError('game-finished', 'the game has already finished'));
  }
  return ok({ ...game, result: { kind: 'mutual-draw' } });
}

/** Whether the game has ended (board win, resign, or mutual draw). */
export function isFinished(game: TakGame): boolean {
  return game.result !== null;
}

/**
 * Whether the position itself is decided — a road or flat win already exists.
 * Distinct from `isFinished`: resign and mutual draw end the game while the
 * position stays undecided. This is the engine's question, not the record's:
 * a `[Result]` tag never decides a position.
 */
export function isBoardFinished(game: TakGame): boolean {
  return boardEnd(game.state) !== null;
}

/** The PTN result code for a finished game, or null while in play. */
export function resultCode(game: TakGame): ResultCode | null {
  const end = game.result;
  if (end === null) return null;
  switch (end.kind) {
    case 'board':
      if (end.outcome.type === 'road') return end.outcome.winner === 1 ? 'R-0' : '0-R';
      if (end.outcome.winner === 'draw') return '1/2-1/2';
      return end.outcome.winner === 1 ? 'F-0' : '0-F';
    case 'resign':
      return end.winner === 1 ? '1-0' : '0-1';
    case 'mutual-draw':
      return '1/2-1/2';
  }
}

/** Export the game as PTN text (full game; includes the result when finished). */
export function toPtn(game: TakGame, options: PtnOptions = {}): Result<string, PtnError> {
  const moves = game.history.map((r) => r.move);
  const result = resultCode(game);
  return generatePtn(moves, game.state.size, { tags: options.tags, result: result ?? undefined });
}
