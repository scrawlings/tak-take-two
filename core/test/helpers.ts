import type { Result } from 'neverthrow';
import {
  applyMove,
  createGame,
  getStack,
  type Direction,
  type File,
  type GameState,
  type Move,
  type Rank,
  type RuleError,
  type Square,
  type StoneKind,
} from '../src/index';

export function must<T>(r: Result<T, RuleError>): T {
  if (r.isErr()) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

export function play(state: GameState, m: Move): GameState {
  return must(applyMove(state, m));
}

export function sq(s: string): Square {
  const f = s[0] as File;
  const r = Number(s[1]) as Rank;
  return [f, r] as unknown as Square;
}

export function place(s: string, stone: StoneKind): Move {
  return { type: 'place', square: sq(s), stone };
}

export function move(s: string, direction: Direction, drops: number[]): Move {
  return { type: 'move', square: sq(s), direction, drops };
}

/** Openings only: P1 places P2's flat at a1, P2 places P1's flat at a5. P1 to move. */
export function openedGame(): GameState {
  let g = createGame(5);
  g = play(g, place('a1', 'flat')); // P2 stone
  g = play(g, place('a5', 'flat')); // P1 stone
  return g;
}

/** Same as openedGame, plus P1 filler at e5 and P2's shuffle stone at a3. P1 to move. */
export function withP2Shuffle(g: GameState): GameState {
  g = play(g, place('e5', 'flat')); // P1 filler
  g = play(g, place('a3', 'flat')); // P2 shuffle stone
  return g;
}

/** P2 shuffles their stone between a3 and a4. P2 to move on entry. */
export function p2Shuffle(g: GameState): GameState {
  const a3 = must(getStack(g, sq('a3')));
  const a4 = must(getStack(g, sq('a4')));
  if (a3.length > 0 && a3[a3.length - 1]!.player === 2) {
    return play(g, move('a3', '+', [1]));
  }
  if (a4.length > 0 && a4[a4.length - 1]!.player === 2) {
    return play(g, move('a4', '-', [1]));
  }
  throw new Error('P2 shuffle stone missing');
}

/**
 * Build an n-high stack of P1 flats at `target`, staging stones on an adjacent
 * `stage` square and moving them onto the target. P1 to move on entry.
 */
export function buildP1Stack(
  g: GameState,
  target: string,
  stage: string,
  dir: Direction,
  n: number,
): GameState {
  let s = g;
  s = play(s, place(target, 'flat'));
  for (let i = 1; i < n; i++) {
    s = p2Shuffle(s);
    s = play(s, place(stage, 'flat'));
    s = p2Shuffle(s);
    s = play(s, move(stage, dir, [1]));
  }
  return s;
}
