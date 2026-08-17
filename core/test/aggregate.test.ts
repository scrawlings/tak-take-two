import { describe, expect, it } from 'vitest';
import type { Result } from 'neverthrow';
import {
  createGame,
  createTakGame,
  fromPtnText,
  generatePtn,
  isFinished,
  mutualDraw,
  playMove,
  resign,
  resultCode,
  toPtn,
  undo,
} from '../src/index';
import type { BoardSize, GameState, Move, TakGame } from '../src/index';
import { move, place, play } from './helpers';

/** Unwrap an aggregate/PTN result (both error shapes are just data). */
function mustTak<T>(r: Result<T, unknown>): T {
  if (r.isErr()) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

/** Replay a move list with the raw rules engine, for cross-checking the aggregate. */
function engineReplay(moves: readonly Move[], size: BoardSize = 5): GameState {
  return moves.reduce((g, m) => play(g, m), createGame(size));
}

/** Record a move list in an aggregate game with strictly increasing timestamps. */
function playAll(g: TakGame, moves: readonly Move[], start = 1_000): TakGame {
  let game = g;
  for (const m of moves) game = mustTak(playMove(game, m, start++));
  return game;
}

/** The 5×5 road win from game.test.ts: P1 completes a3–e3 on the 11th move. */
function roadWinMoves(): Move[] {
  const moves: Move[] = [];
  let g = createGame(5);
  const rec = (m: Move): GameState => {
    moves.push(m);
    return play(g, m);
  };
  g = rec(place('a1', 'flat'));
  g = rec(place('a5', 'flat'));
  g = rec(place('a3', 'flat'));
  g = rec(place('a2', 'flat'));
  g = rec(place('b3', 'flat'));
  g = rec(place('a4', 'flat'));
  g = rec(place('c3', 'flat'));
  g = rec(place('b4', 'flat'));
  g = rec(place('d3', 'flat'));
  g = rec(place('b2', 'flat'));
  g = rec(place('e3', 'flat'));
  return moves;
}

describe('create and replay', () => {
  it('creates an empty game and replays moves with a state matching the engine', () => {
    const g = createTakGame(5);
    expect(g.state).toEqual(createGame(5));
    expect(g.history).toEqual([]);
    expect(g.fixedMoves).toBe(0);
    expect(g.result).toBeNull();
    expect(isFinished(g)).toBe(false);
    expect(resultCode(g)).toBeNull();

    const moves: Move[] = [place('a1', 'flat'), place('a5', 'flat'), place('b1', 'flat')];
    const played = playAll(g, moves);
    expect(played.state).toEqual(engineReplay(moves));
    expect(played.state.playerToMove).toBe(2);
    expect(played.history.length).toBe(3);
    expect(played.result).toBeNull();
  });

  it('records every move with its timestamp', () => {
    const g = createTakGame(5);
    const played = playAll(g, [place('a1', 'flat'), place('a5', 'flat')], 1_700_000_000_000);
    expect(played.history.map((r) => r.playedAt)).toEqual([1_700_000_000_000, 1_700_000_000_001]);
    expect(played.history.map((r) => r.move)).toEqual([place('a1', 'flat'), place('a5', 'flat')]);
  });
});

describe('undo', () => {
  it('restores the prior state', () => {
    const moves: Move[] = [place('a1', 'flat'), place('a5', 'flat'), place('b1', 'flat')];
    const played = playAll(createTakGame(5), moves);
    const before = played.state;
    const undone = mustTak(undo(played));
    expect(undone.state).toEqual(engineReplay(moves.slice(0, -1)));
    expect(undone.history.length).toBe(2);
    expect(undone.result).toBeNull();
    // A follow-up move replays from the restored state.
    const again = mustTak(playMove(undone, place('b1', 'flat'), 9_999));
    expect(again.state).toEqual(before);
  });

  it('refuses when there is nothing to undo', () => {
    const r = undo(createTakGame(5));
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('no-move-to-undo');
  });

  it('refuses to undo a finished game', () => {
    const g = playAll(createTakGame(5), roadWinMoves());
    expect(isFinished(g)).toBe(true);
    const r = undo(g);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('game-finished');
  });

  it('cannot undo into imported (fixed) history', () => {
    const imported = [place('a1', 'flat'), place('a5', 'flat'), place('b1', 'flat')];
    const loaded = mustTak(
      fromPtnText(mustTak(generatePtn(imported, 5)), { playedAt: 42 }),
    );
    expect(loaded.fixedMoves).toBe(3);
    // Imported history has no live moves to undo.
    const r = undo(loaded);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('no-move-to-undo');

    // A live move is undoable, but only back to the imported prefix.
    const live = mustTak(playMove(loaded, place('b5', 'flat'), 43));
    const undone = mustTak(undo(live));
    expect(undone.history.length).toBe(3);
    const again = undo(undone);
    expect(again.isErr()).toBe(true);
    if (again.isErr()) expect(again.error.code).toBe('no-move-to-undo');
  });
});

describe('resign and mutual draw', () => {
  it('resign ends the game and the opponent wins', () => {
    const g = playAll(createTakGame(5), [place('a1', 'flat'), place('a5', 'flat')]);
    const done = mustTak(resign(g, 1));
    expect(done.result).toEqual({ kind: 'resign', winner: 2 });
    expect(resultCode(done)).toBe('0-1');
    expect(isFinished(done)).toBe(true);

    const r = playMove(done, place('b1', 'flat'), 1);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('game-finished');
  });

  it('resign as player 2 gives player 1 the win', () => {
    const g = playAll(createTakGame(5), [place('a1', 'flat'), place('a5', 'flat')]);
    const done = mustTak(resign(g, 2));
    expect(done.result).toEqual({ kind: 'resign', winner: 1 });
    expect(resultCode(done)).toBe('1-0');
  });

  it('mutual draw ends the game as a draw', () => {
    const g = playAll(createTakGame(5), [place('a1', 'flat'), place('a5', 'flat')]);
    const done = mustTak(mutualDraw(g));
    expect(done.result).toEqual({ kind: 'mutual-draw' });
    expect(resultCode(done)).toBe('1/2-1/2');

    const r = resign(done, 1);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('game-finished');
  });

  it('a board win also ends the game with the correct result', () => {
    const g = playAll(createTakGame(5), roadWinMoves());
    expect(g.result).toEqual({ kind: 'board', outcome: { type: 'road', winner: 1 } });
    expect(resultCode(g)).toBe('R-0');

    const r = playMove(g, place('d1', 'flat'), 1);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('game-finished');
  });
});

describe('load a full PTN game headlessly', () => {
  it('loads a finished road-win record and preserves the finish', () => {
    const moves = roadWinMoves();
    const text = mustTak(generatePtn(moves, 5, { result: 'R-0' }));
    const loaded = mustTak(fromPtnText(text, { playedAt: 123 }));
    expect(loaded.fixedMoves).toBe(moves.length);
    expect(loaded.history.length).toBe(moves.length);
    expect(loaded.history.every((r) => r.playedAt === 123)).toBe(true);
    expect(loaded.state).toEqual(engineReplay(moves));
    expect(loaded.result).toEqual({ kind: 'board', outcome: { type: 'road', winner: 1 } });
    expect(resultCode(loaded)).toBe('R-0');
  });

  it('loads an in-play prefix and continues playing; imported history stays fixed', () => {
    const imported = [place('a1', 'flat'), place('a5', 'flat'), place('b1', 'flat')];
    const text = mustTak(generatePtn(imported, 5));
    const loaded = mustTak(fromPtnText(text));
    expect(loaded.result).toBeNull();
    expect(isFinished(loaded)).toBe(false);
    // Imported moves carry no timestamp.
    expect(loaded.history.every((r) => r.playedAt === null)).toBe(true);

    const live = mustTak(playMove(loaded, place('b5', 'flat'), 999));
    expect(live.history.length).toBe(4);
    expect(live.history[3]).toEqual({ move: place('b5', 'flat'), playedAt: 999 });
    expect(live.state).toEqual(engineReplay([...imported, place('b5', 'flat')]));
  });

  it('loads resign and draw results when the board does not end', () => {
    const moves = [place('a1', 'flat'), place('a5', 'flat')];
    const resignText = mustTak(generatePtn(moves, 5, { result: '1-0' }));
    const resigned = mustTak(fromPtnText(resignText));
    expect(resigned.result).toEqual({ kind: 'resign', winner: 1 });
    expect(resultCode(resigned)).toBe('1-0');

    const drawText = mustTak(generatePtn(moves, 5, { result: '1/2-1/2' }));
    const drawn = mustTak(fromPtnText(drawText));
    expect(drawn.result).toEqual({ kind: 'mutual-draw' });
    expect(resultCode(drawn)).toBe('1/2-1/2');
  });

  it('round-trips through toPtn', () => {
    const moves = roadWinMoves();
    const loaded = mustTak(fromPtnText(mustTak(generatePtn(moves, 5, { result: 'R-0' }))));
    const exported = mustTak(toPtn(loaded));
    expect(exported).toContain('R-0');
    const reloaded = mustTak(fromPtnText(exported));
    expect(reloaded.history.map((r) => r.move)).toEqual(moves);
    expect(reloaded.result).toEqual(loaded.result);
  });
});

describe('typed errors', () => {
  it('rejects an illegal move with the underlying rule error', () => {
    const g = playAll(createTakGame(5), [place('a1', 'flat')]);
    const r = playMove(g, place('a1', 'flat'), 1); // occupied
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.code).toBe('invalid-move');
      expect(r.error.ruleError?.code).toBe('square-occupied');
    }
  });

  it('rejects malformed PTN text with a PTN error', () => {
    const r = fromPtnText('1. a1 a5'); // missing [Size] tag
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('ptn-missing-size');
  });

  it('never throws on bad actions', () => {
    const g = playAll(createTakGame(5), [place('a1', 'flat'), place('a5', 'flat')]);
    const finished = mustTak(resign(g, 1));
    expect(() => resign(finished, 2)).not.toThrow();
    expect(() => mutualDraw(finished)).not.toThrow();
    expect(() => undo(finished)).not.toThrow();
    expect(() => playMove(finished, move('a1', '+', [1]), 1)).not.toThrow();
    expect(() => undo(createTakGame(5))).not.toThrow();
  });
});
