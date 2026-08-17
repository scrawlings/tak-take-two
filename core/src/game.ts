// The Tak rules engine: createGame, applyMove, getStack.
// Pure module — zero I/O, zero framework dependencies, no exceptions.
// Every failure path returns a neverthrow Result.

import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import { initialReserve, opponent } from './types';
import type {
  Board,
  BoardSize,
  Direction,
  File,
  GameState,
  Move,
  Outcome,
  Player,
  PlayerReserve,
  Rank,
  Reserves,
  RuleError,
  RuleErrorCode,
  Square,
  Stack,
  Stone,
} from './types';

const FILES: readonly File[] = ['a', 'b', 'c', 'd', 'e', 'f'];
const RANKS: readonly Rank[] = [1, 2, 3, 4, 5, 6];

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function ruleError(code: RuleErrorCode, message: string): RuleError {
  return { code, message };
}

function fileIndex(f: File): number {
  return f.charCodeAt(0) - 97;
}

function rankIndex(r: Rank): number {
  return r - 1;
}

function fileFromIndex(i: number): File | undefined {
  return FILES[i];
}

function rankFromIndex(i: number): Rank | undefined {
  return RANKS[i];
}

/** The file/rank indices of a square on a board of the given size. */
function squareIndex(size: BoardSize, sq: Square): Result<{ fi: number; ri: number }, RuleError> {
  const fi = fileIndex(sq[0]);
  const ri = rankIndex(sq[1]);
  if (fi < 0 || ri < 0 || fi >= size || ri >= size) {
    return err(ruleError('square-off-board', `square ${sq[0]}${sq[1]} is off the ${size}x${size} board`));
  }
  return ok({ fi, ri });
}

/** The stack at an internal index (empty array for an empty or out-of-range square). */
function stackAt(board: Board, fi: number, ri: number): Stack {
  const row = board.grid[fi];
  if (row === undefined) return [];
  const stack = row[ri];
  if (stack === undefined) return [];
  return stack;
}

function setStack(board: Board, fi: number, ri: number, stack: Stack): Board {
  const grid = board.grid.map((row, i) => {
    if (i !== fi) return row;
    return row.map((cell, j) => (j === ri ? stack : cell));
  });
  return { size: board.size, grid };
}

function adjustReserve(
  reserves: Reserves,
  player: Player,
  fn: (r: PlayerReserve) => PlayerReserve,
): Reserves {
  return player === 1
    ? { 1: fn(reserves[1]), 2: reserves[2] }
    : { 1: reserves[1], 2: fn(reserves[2]) };
}

function setOpened(opened: Record<Player, boolean>, player: Player): Record<Player, boolean> {
  return player === 1 ? { 1: true, 2: opened[2] } : { 1: opened[1], 2: true };
}

/** Produce the next state after a mover's turn: advance turn, bump the move number. */
function advanceTurn(
  state: GameState,
  overrides: { board: Board; reserves?: Reserves; opened?: Record<Player, boolean> },
): GameState {
  const mover = state.playerToMove;
  return {
    ...state,
    board: overrides.board,
    reserves: overrides.reserves ?? state.reserves,
    opened: overrides.opened ?? state.opened,
    playerToMove: opponent(mover),
    moveNumber: mover === 2 ? state.moveNumber + 1 : state.moveNumber,
  };
}

/** Create an empty game on a 5×5 or 6×6 board. */
export function createGame(size: BoardSize): GameState {
  const grid: Stack[][] = [];
  for (let fi = 0; fi < size; fi++) {
    const row: Stack[] = [];
    for (let ri = 0; ri < size; ri++) row.push([]);
    grid.push(row);
  }
  return {
    size,
    board: { size, grid },
    playerToMove: 1,
    moveNumber: 1,
    reserves: { 1: initialReserve(size), 2: initialReserve(size) },
    opened: { 1: false, 2: false },
    outcome: null,
  };
}

/** The stack at a square (empty array for an empty square). */
export function getStack(state: GameState, sq: Square): Result<Stack, RuleError> {
  const idx = squareIndex(state.size, sq);
  if (idx.isErr()) return err(idx.error);
  return ok(stackAt(state.board, idx.value.fi, idx.value.ri));
}

/** Apply a move, returning the new immutable state (or a typed error). */
export function applyMove(state: GameState, move: Move): Result<GameState, RuleError> {
  if (state.outcome !== null) {
    return err(ruleError('game-finished', 'the game has already finished'));
  }
  const mover = state.playerToMove;
  if (move.type === 'place') return applyPlace(state, mover, move);
  return applyStackMove(state, mover, move);
}

function applyPlace(
  state: GameState,
  mover: Player,
  move: Extract<Move, { type: 'place' }>,
): Result<GameState, RuleError> {
  const idx = squareIndex(state.size, move.square);
  if (idx.isErr()) return err(idx.error);
  const { fi, ri } = idx.value;
  if (stackAt(state.board, fi, ri).length !== 0) {
    return err(
      ruleError('square-occupied', `square ${move.square[0]}${move.square[1]} is already occupied`),
    );
  }

  let stone: Stone;
  let reserves = state.reserves;
  let opened = state.opened;

  if (!state.opened[mover]) {
    // Opening move: place one of the opponent's flat stones.
    if (move.stone !== 'flat') {
      return err(ruleError('opening-must-be-flat', 'the opening move must place a flat stone'));
    }
    const other = opponent(mover);
    if (state.reserves[other].stones <= 0) {
      return err(ruleError('no-stones-in-reserve', `player ${other} has no stones left`));
    }
    stone = { player: other, kind: 'flat' };
    reserves = adjustReserve(state.reserves, other, (r) => ({
      stones: r.stones - 1,
      capstones: r.capstones,
    }));
    opened = setOpened(state.opened, mover);
  } else if (move.stone === 'capstone') {
    if (state.reserves[mover].capstones <= 0) {
      return err(ruleError('no-capstone-in-reserve', `player ${mover} has no capstone left`));
    }
    stone = { player: mover, kind: 'capstone' };
    reserves = adjustReserve(state.reserves, mover, (r) => ({
      stones: r.stones,
      capstones: r.capstones - 1,
    }));
  } else {
    if (state.reserves[mover].stones <= 0) {
      return err(ruleError('no-stones-in-reserve', `player ${mover} has no stones left`));
    }
    stone = { player: mover, kind: move.stone };
    reserves = adjustReserve(state.reserves, mover, (r) => ({
      stones: r.stones - 1,
      capstones: r.capstones,
    }));
  }

  const board = setStack(state.board, fi, ri, [stone]);
  const candidate: GameState = advanceTurn(state, { board, reserves, opened });
  const outcome = computeOutcome(candidate, mover, true);
  return ok({ ...candidate, outcome });
}

function applyStackMove(
  state: GameState,
  mover: Player,
  move: Extract<Move, { type: 'move' }>,
): Result<GameState, RuleError> {
  if (!state.opened[mover]) {
    return err(ruleError('opening-not-complete', `player ${mover} must place a stone on their first turn`));
  }

  const srcIdx = squareIndex(state.size, move.square);
  if (srcIdx.isErr()) return err(srcIdx.error);
  const { fi: sfi, ri: sri } = srcIdx.value;
  const src = stackAt(state.board, sfi, sri);
  if (src.length === 0) return err(ruleError('source-empty', 'there is no stack to move'));
  const top = src[src.length - 1]!;
  if (top.player !== mover) {
    return err(ruleError('not-your-stack', 'the stack is controlled by the other player'));
  }

  const drops = move.drops;
  if (drops.length === 0) return err(ruleError('no-drops', 'a stack move must drop at least one stone'));
  let lift = 0;
  for (const d of drops) {
    if (!Number.isInteger(d) || d < 1) {
      return err(ruleError('invalid-drop', `drop count ${d} is not a positive integer`));
    }
    lift += d;
  }
  if (lift > state.size) {
    return err(ruleError('carry-limit-exceeded', `cannot lift more than the carry limit of ${state.size}`));
  }
  if (lift > src.length) {
    return err(ruleError('carry-exceeds-stack', 'cannot lift more stones than the stack holds'));
  }

  const lifted = src.slice(src.length - lift);
  const newSource = src.slice(0, src.length - lift);
  let board = setStack(state.board, sfi, sri, newSource);

  let cursor = 0;
  for (let step = 0; step < drops.length; step++) {
    const dropCount = drops[step]!;
    const destSq = offsetSquare(move.square, move.direction, step + 1);
    if (destSq === null) return err(ruleError('drops-off-board', 'the move runs off the board'));
    const destIdx = squareIndex(state.size, destSq);
    if (destIdx.isErr()) return err(ruleError('drops-off-board', 'the move runs off the board'));
    const { fi: dfi, ri: dri } = destIdx.value;
    const dest = stackAt(board, dfi, dri);
    const destTop = dest.length > 0 ? dest[dest.length - 1]! : null;
    const stones = lifted.slice(cursor, cursor + dropCount);
    cursor += dropCount;
    const isLast = step === drops.length - 1;

    let next: Stack;
    if (destTop === null || destTop.kind === 'flat') {
      next = dest.concat(stones);
    } else if (destTop.kind === 'standing') {
      if (!isLast) return err(ruleError('crossing-standing-stone', 'cannot move through a standing stone'));
      if (dropCount !== 1 || stones[0]!.kind !== 'capstone') {
        return err(ruleError('cannot-stack-on-standing-stone', 'only a lone capstone may land on a standing stone'));
      }
      const flattened = dest.slice(0, -1).concat({ player: destTop.player, kind: 'flat' });
      next = flattened.concat(stones);
    } else {
      if (!isLast) return err(ruleError('crossing-capstone', 'cannot move through a capstone'));
      return err(ruleError('cannot-stack-on-capstone', 'a capstone cannot be stacked upon'));
    }
    board = setStack(board, dfi, dri, next);
  }

  const candidate: GameState = advanceTurn(state, { board });
  const outcome = computeOutcome(candidate, mover, false);
  return ok({ ...candidate, outcome });
}

function offsetSquare(sq: Square, dir: Direction, steps: number): Square | null {
  let fi = fileIndex(sq[0]);
  let ri = rankIndex(sq[1]);
  switch (dir) {
    case '+':
      ri += steps;
      break;
    case '-':
      ri -= steps;
      break;
    case '>':
      fi += steps;
      break;
    case '<':
      fi -= steps;
      break;
  }
  const f = fileFromIndex(fi);
  const r = rankFromIndex(ri);
  if (f === undefined || r === undefined) return null;
  return [f, r] as unknown as Square;
}

function computeOutcome(state: GameState, mover: Player, placed: boolean): Outcome | null {
  const road1 = hasRoad(state.board, state.size, 1);
  const road2 = hasRoad(state.board, state.size, 2);
  if (road1 && road2) return { type: 'road', winner: mover };
  if (road1) return { type: 'road', winner: 1 };
  if (road2) return { type: 'road', winner: 2 };
  if (isBoardFull(state.board, state.size)) return flatOutcome(state);
  if (placed) {
    const r = state.reserves[mover];
    if (r.stones === 0 && r.capstones === 0) return flatOutcome(state);
  }
  return null;
}

function flatOutcome(state: GameState): Outcome {
  const c1 = flatCount(state.board, state.size, 1);
  const c2 = flatCount(state.board, state.size, 2);
  if (c1 > c2) return { type: 'flat', winner: 1 };
  if (c2 > c1) return { type: 'flat', winner: 2 };
  return { type: 'flat', winner: 'draw' };
}

function flatCount(board: Board, size: BoardSize, player: Player): number {
  let count = 0;
  for (let fi = 0; fi < size; fi++) {
    for (let ri = 0; ri < size; ri++) {
      const stack = stackAt(board, fi, ri);
      if (stack.length === 0) continue;
      const top = stack[stack.length - 1]!;
      if (top.player === player && top.kind === 'flat') count++;
    }
  }
  return count;
}

function isBoardFull(board: Board, size: BoardSize): boolean {
  for (let fi = 0; fi < size; fi++) {
    for (let ri = 0; ri < size; ri++) {
      if (stackAt(board, fi, ri).length === 0) return false;
    }
  }
  return true;
}

function hasRoad(board: Board, size: BoardSize, player: Player): boolean {
  const roadAt = (fi: number, ri: number): boolean => {
    const stack = stackAt(board, fi, ri);
    if (stack.length === 0) return false;
    const top = stack[stack.length - 1]!;
    return top.player === player && (top.kind === 'flat' || top.kind === 'capstone');
  };
  if (edgeToEdge(size, roadAt, 'left-right')) return true;
  if (edgeToEdge(size, roadAt, 'top-bottom')) return true;
  return false;
}

function edgeToEdge(
  size: BoardSize,
  roadAt: (fi: number, ri: number) => boolean,
  which: 'left-right' | 'top-bottom',
): boolean {
  const isStart = (fi: number, ri: number): boolean =>
    which === 'left-right' ? fi === 0 : ri === 0;
  const isTarget = (fi: number, ri: number): boolean =>
    which === 'left-right' ? fi === size - 1 : ri === size - 1;

  const visited = new Set<number>();
  const queue: number[] = [];
  for (let fi = 0; fi < size; fi++) {
    for (let ri = 0; ri < size; ri++) {
      if (isStart(fi, ri) && roadAt(fi, ri)) {
        const enc = fi * size + ri;
        visited.add(enc);
        queue.push(enc);
      }
    }
  }
  while (queue.length > 0) {
    const enc = queue.shift()!;
    const fi = Math.floor(enc / size);
    const ri = enc % size;
    if (isTarget(fi, ri)) return true;
    for (const [df, dr] of NEIGHBOURS) {
      const nf = fi + df;
      const nr = ri + dr;
      if (nf >= 0 && nf < size && nr >= 0 && nr < size) {
        const nenc = nf * size + nr;
        if (!visited.has(nenc) && roadAt(nf, nr)) {
          visited.add(nenc);
          queue.push(nenc);
        }
      }
    }
  }
  return false;
}
