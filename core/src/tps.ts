// TPS: serialize a position to a TPS string and parse/validate TPS strings.
// Pure module — no I/O, no framework dependencies, no exceptions.
// Every failure path returns a neverthrow Result. Grammar follows the USTak
// Tak Positional System spec (ustak.org): rows top-down, squares comma
// separated, stacks bottom-to-top, `x`/`xN` for empty runs, a trailing `S`/`C`
// on the top stone, then the turn and the move counter (the move due, never 0).

import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import { initialReserve } from './types';
import type {
  Board,
  BoardSize,
  GameState,
  Player,
  Rank,
  Stack,
  Stone,
  TpsError,
} from './types';

/** An empty run: `x` (one square) or `xN`. */
const X_RUN_RE = /^x(?:([1-9]\d*))?$/;

/** A stack: owner digits bottom-to-top, with an optional S/C on the top stone. */
const STACK_RE = /^([12]+)([SC]?)$/;

function tpsError(code: TpsError['code'], message: string): TpsError {
  return { code, message };
}

/** Parse one cell into an empty run or a stack of stones. */
function parseCell(
  cell: string,
  row: number,
): Result<{ empties: number } | { stack: Stack }, TpsError> {
  const run = X_RUN_RE.exec(cell);
  if (run !== null) {
    return ok({ empties: run[1] === undefined ? 1 : Number(run[1]) });
  }
  const stack = STACK_RE.exec(cell);
  if (stack !== null) {
    const stones: Stone[] = [];
    for (const ch of stack[1]!) {
      const player: Player = ch === '1' ? 1 : 2;
      stones.push({ player, kind: 'flat' });
    }
    if (stack[2] !== '') {
      const top = stones[stones.length - 1]!;
      stones[stones.length - 1] = {
        player: top.player,
        kind: stack[2] === 'S' ? 'standing' : 'capstone',
      };
    }
    return ok({ stack: stones });
  }
  return err(tpsError('tps-bad-cell', `row ${row}: cell "${cell}" is not a valid TPS cell`));
}

/** Build the board grid and per-player stone counts from the rows (top-down). */
function parseBoard(
  rows: readonly string[],
  size: BoardSize,
): Result<
  { board: Board; counts: Record<Player, { stones: number; capstones: number }> },
  TpsError
> {
  const grid: Stack[][] = [];
  for (let fi = 0; fi < size; fi++) {
    const col: Stack[] = [];
    for (let ri = 0; ri < size; ri++) col.push([]);
    grid.push(col);
  }
  const counts: Record<Player, { stones: number; capstones: number }> = {
    1: { stones: 0, capstones: 0 },
    2: { stones: 0, capstones: 0 },
  };

  for (let r = 0; r < rows.length; r++) {
    const rank = size - r; // 1-based, top row first
    const ri = rank - 1;
    let fi = 0;
    for (const cell of rows[r]!.split(',')) {
      const parsed = parseCell(cell, r + 1);
      if (parsed.isErr()) return err(parsed.error);
      if ('empties' in parsed.value) {
        fi += parsed.value.empties;
      } else {
        if (fi >= size) {
          return err(tpsError('tps-bad-row-width', `row ${r + 1} has more than ${size} squares`));
        }
        grid[fi]![ri] = parsed.value.stack;
        for (const stone of parsed.value.stack) {
          if (stone.kind === 'capstone') counts[stone.player].capstones++;
          else counts[stone.player].stones++;
        }
        fi++;
      }
    }
    if (fi !== size) {
      return err(tpsError('tps-bad-row-width', `row ${r + 1} has ${fi} squares; expected ${size}`));
    }
  }
  return ok({ board: { size, grid }, counts });
}

/**
 * Parse and validate a TPS string. The board size comes from the row count
 * (5 or 6). Material validation rejects stacks with a standing/capstone not on
 * top (a structural check), more than one capstone per player, stone counts
 * beyond each player's reserve, and stone counts the move counter cannot
 * account for. Returns a GameState with reserves and opening flags derived
 * from the position — starting a game from a TPS position remains deferred,
 * but the state is exactly what that will need.
 */
export function parseTps(text: string): Result<GameState, TpsError> {
  const fields = text.trim().split(/\s+/).filter((t) => t.length > 0);
  if (fields.length !== 3) {
    return err(tpsError('tps-field-count', `expected "board turn move", found ${fields.length} field(s)`));
  }
  const [boardText, turnText, moveText] = fields as [string, string, string];

  if (!/^[12]$/.test(turnText)) {
    return err(tpsError('tps-bad-turn', `turn "${turnText}" is not 1 or 2`));
  }
  const turn: Player = turnText === '1' ? 1 : 2;

  if (!/^[1-9]\d*$/.test(moveText)) {
    return err(tpsError('tps-bad-move-count', `move counter "${moveText}" is not a positive integer`));
  }
  const moveNumber = Number(moveText);

  const rows = boardText.split('/');
  if (rows.length !== 5 && rows.length !== 6) {
    return err(tpsError('tps-bad-row-count', `${rows.length} rows is not a 5x5 or 6x6 board`));
  }
  const size: BoardSize = rows.length === 5 ? 5 : 6;

  const board = parseBoard(rows, size);
  if (board.isErr()) return err(board.error);
  const { board: b, counts } = board.value;

  // Material validation.
  const reserve = initialReserve(size);
  for (const player of [1, 2] as const) {
    if (counts[player].capstones > 1) {
      return err(
        tpsError('tps-too-many-capstones', `player ${player} has ${counts[player].capstones} capstones on the board`),
      );
    }
    if (counts[player].stones > reserve.stones) {
      return err(
        tpsError(
          'tps-stones-beyond-reserve',
          `player ${player} has ${counts[player].stones} stones on the board, beyond the reserve of ${reserve.stones}`,
        ),
      );
    }
  }

  // Every move adds at most one stone (stack moves add none), and the first
  // two moves are the openings, which must place. So the board holds between
  // min(movesPlayed, 2) and movesPlayed stones.
  const total = counts[1].stones + counts[1].capstones + counts[2].stones + counts[2].capstones;
  const movesPlayed = 2 * (moveNumber - 1) + (turn === 2 ? 1 : 0);
  if (total > movesPlayed) {
    return err(
      tpsError(
        'tps-too-many-stones',
        `${total} stones on the board but the move counter ${moveNumber} accounts for only ${movesPlayed} moves played`,
      ),
    );
  }
  if (total < Math.min(movesPlayed, 2)) {
    return err(
      tpsError(
        'tps-too-few-stones',
        `${total} stones on the board but the move counter ${moveNumber} implies at least ${Math.min(movesPlayed, 2)} (the openings always place)`,
      ),
    );
  }

  return ok({
    size,
    board: b,
    playerToMove: turn,
    moveNumber,
    reserves: {
      1: { stones: reserve.stones - counts[1].stones, capstones: 1 - counts[1].capstones },
      2: { stones: reserve.stones - counts[2].stones, capstones: 1 - counts[2].capstones },
    },
    opened: { 1: turn === 2 || moveNumber >= 2, 2: moveNumber >= 2 },
    outcome: null,
  });
}

function stackAt(board: Board, fi: number, ri: number): Stack {
  const col = board.grid[fi];
  if (col === undefined) return [];
  const stack = col[ri];
  if (stack === undefined) return [];
  return stack;
}

/** A stack as TPS text: owner digits bottom-to-top, S/C on a standing/capstone top. */
function formatStack(stack: Stack): string {
  let out = '';
  for (const stone of stack) out += stone.player === 1 ? '1' : '2';
  const top = stack[stack.length - 1];
  if (top !== undefined) {
    if (top.kind === 'standing') out += 'S';
    else if (top.kind === 'capstone') out += 'C';
  }
  return out;
}

function formatRow(board: Board, size: BoardSize, rank: Rank): string {
  const cells: string[] = [];
  let emptyRun = 0;
  const flush = (): void => {
    if (emptyRun === 0) return;
    cells.push(emptyRun === 1 ? 'x' : `x${emptyRun}`);
    emptyRun = 0;
  };
  for (let fi = 0; fi < size; fi++) {
    const stack = stackAt(board, fi, rank - 1);
    if (stack.length === 0) {
      emptyRun++;
    } else {
      flush();
      cells.push(formatStack(stack));
    }
  }
  flush();
  return cells.join(',');
}

/**
 * Serialize a position to a TPS string. This is total — any GameState is a
 * well-formed position — so it returns a plain string rather than a Result.
 */
export function generateTps(state: GameState): string {
  const rows: string[] = [];
  for (let rank = state.size; rank >= 1; rank--) {
    rows.push(formatRow(state.board, state.size, rank as Rank));
  }
  return `${rows.join('/')} ${state.playerToMove} ${state.moveNumber}`;
}
