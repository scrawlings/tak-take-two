import { describe, expect, it } from 'vitest';
import { applyMove, createGame, getStack, square } from '../src/index';
import type { GameState, Move } from '../src/index';
import { move, must, place, play, sq } from './helpers';

describe('board and place moves', () => {
  it('creates an empty 5x5 game with correct reserves and turn', () => {
    const g = createGame(5);
    expect(g.size).toBe(5);
    expect(g.playerToMove).toBe(1);
    expect(g.moveNumber).toBe(1);
    expect(g.outcome).toBeNull();
    expect(g.opened).toEqual({ 1: false, 2: false });
    expect(g.reserves).toEqual({
      1: { stones: 21, capstones: 1 },
      2: { stones: 21, capstones: 1 },
    });
    for (const f of ['a', 'b', 'c', 'd', 'e'] as const) {
      for (const r of [1, 2, 3, 4, 5] as const) {
        expect(must(getStack(g, square(f, r)))).toEqual([]);
      }
    }
  });

  it('enforces the opponent-stone opening', () => {
    let g = createGame(5);
    const bad = applyMove(g, place('a1', 'standing'));
    expect(bad.isErr()).toBe(true);
    if (bad.isErr()) expect(bad.error.code).toBe('opening-must-be-flat');

    g = play(g, place('a1', 'flat'));
    expect(must(getStack(g, sq('a1')))).toEqual([{ player: 2, kind: 'flat' }]);
    expect(g.reserves[2].stones).toBe(20);
    expect(g.reserves[1].stones).toBe(21);
    expect(g.playerToMove).toBe(2);
    expect(g.opened[1]).toBe(true);
    expect(g.opened[2]).toBe(false);

    g = play(g, place('b1', 'flat'));
    expect(must(getStack(g, sq('b1')))).toEqual([{ player: 1, kind: 'flat' }]);
    expect(g.reserves[1].stones).toBe(20);
    expect(g.playerToMove).toBe(1);
    expect(g.opened[2]).toBe(true);
  });

  it('places own stones after the opening and rejects occupied and off-board squares', () => {
    let g = createGame(5);
    g = play(g, place('a1', 'flat')); // P2 stone
    g = play(g, place('b1', 'flat')); // P1 stone

    g = play(g, place('c1', 'standing'));
    expect(must(getStack(g, sq('c1')))).toEqual([{ player: 1, kind: 'standing' }]);
    expect(g.reserves[1].stones).toBe(19);

    const occ = applyMove(g, place('c1', 'flat'));
    expect(occ.isErr()).toBe(true);
    if (occ.isErr()) expect(occ.error.code).toBe('square-occupied');

    const off = applyMove(g, place('f6', 'flat'));
    expect(off.isErr()).toBe(true);
    if (off.isErr()) expect(off.error.code).toBe('square-off-board');
  });

  it('places a capstone from the reserve', () => {
    let g = createGame(5);
    g = play(g, place('a1', 'flat'));
    g = play(g, place('b1', 'flat'));
    g = play(g, place('c1', 'capstone'));
    expect(must(getStack(g, sq('c1')))).toEqual([{ player: 1, kind: 'capstone' }]);
    expect(g.reserves[1].capstones).toBe(0);
  });

  it('rejects a second capstone', () => {
    let g = createGame(5);
    g = play(g, place('a1', 'flat'));
    g = play(g, place('a5', 'flat'));
    g = play(g, place('b1', 'capstone')); // P1 capstone
    g = play(g, place('a3', 'flat')); // P2
    const r = applyMove(g, place('c1', 'capstone'));
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('no-capstone-in-reserve');
  });
});

describe('6x6 board', () => {
  it('creates an empty 6x6 game with 30 stones and one capstone per player', () => {
    const g = createGame(6);
    expect(g.size).toBe(6);
    expect(g.reserves).toEqual({
      1: { stones: 30, capstones: 1 },
      2: { stones: 30, capstones: 1 },
    });
    for (const f of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
      for (const r of [1, 2, 3, 4, 5, 6] as const) {
        expect(must(getStack(g, square(f, r)))).toEqual([]);
      }
    }
  });

  it('enforces the carry limit of 6', () => {
    let g = createGame(6);
    g = play(g, place('a1', 'flat')); // P1 places P2 stone
    g = play(g, place('a6', 'flat')); // P2 places P1 stone
    g = play(g, place('b1', 'flat')); // P1 own stone
    g = play(g, place('a3', 'flat')); // P2 own stone
    const r = applyMove(g, move('b1', '>', [7]));
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('carry-limit-exceeded');
  });
});

describe('win detection', () => {
  it('detects a road win', () => {
    let g = createGame(5);
    g = play(g, place('a1', 'flat')); // P2
    g = play(g, place('a5', 'flat')); // P1
    g = play(g, place('a3', 'flat')); // P1
    g = play(g, place('a2', 'flat')); // P2
    g = play(g, place('b3', 'flat')); // P1
    g = play(g, place('a4', 'flat')); // P2
    g = play(g, place('c3', 'flat')); // P1
    g = play(g, place('b4', 'flat')); // P2
    g = play(g, place('d3', 'flat')); // P1
    g = play(g, place('b2', 'flat')); // P2
    const result = applyMove(g, place('e3', 'flat')); // P1 completes a3–e3
    expect(result.isOk()).toBe(true);
    expect(result.isOk() ? result.value.outcome : null).toEqual({ type: 'road', winner: 1 });
  });

  it('awards the win to the mover when one move creates roads for both (double road)', () => {
    let g = createGame(5);
    g = play(g, place('a5', 'flat')); // P1 places P2 stone
    g = play(g, place('b5', 'flat')); // P2 places P1 stone
    g = play(g, place('a3', 'flat')); // P1 road
    g = play(g, place('c1', 'flat')); // P2 (bottom of c1)
    g = play(g, place('c2', 'flat')); // P1 staged
    g = play(g, place('a1', 'flat')); // P2 road
    g = play(g, place('b3', 'flat')); // P1 road
    g = play(g, place('b1', 'flat')); // P2 road
    g = play(g, move('c2', '-', [1])); // P1: c1=[P2,P1]
    g = play(g, place('d1', 'flat')); // P2 road
    g = play(g, place('c2', 'flat')); // P1 staged
    g = play(g, place('e1', 'flat')); // P2 road
    g = play(g, move('c2', '-', [1])); // P1: c1=[P2,P1,P1]
    g = play(g, move('a5', '-', [1])); // P2 filler
    g = play(g, place('d3', 'flat')); // P1 road
    g = play(g, move('a4', '+', [1])); // P2 filler
    g = play(g, place('e3', 'flat')); // P1 road (a3,b3,d3,e3)
    g = play(g, move('a5', '-', [1])); // P2 filler
    const result = applyMove(g, move('c1', '+', [1, 1])); // P1 final: c1->c2->c3
    expect(result.isOk()).toBe(true);
    expect(result.isOk() ? result.value.outcome : null).toEqual({ type: 'road', winner: 1 });
    if (result.isOk()) {
      expect(must(getStack(result.value, sq('c1')))).toEqual([{ player: 2, kind: 'flat' }]);
      expect(must(getStack(result.value, sq('c3')))).toEqual([{ player: 1, kind: 'flat' }]);
    }
  });

  it('ends by flat count when the board fills', () => {
    let g = createGame(5);
    const squares = [
      'a1', 'b1', 'c1', 'd1', 'e1',
      'a2', 'b2', 'c2', 'd2', 'e2',
      'a3', 'b3', 'c3', 'd3', 'e3',
      'a4', 'b4', 'c4', 'd4', 'e4',
      'a5', 'b5', 'c5', 'd5', 'e5',
    ];
    const moves: Move[] = [];
    moves.push(place(squares[0]!, 'flat')); // P1 places P2 stone at a1
    moves.push(place(squares[1]!, 'flat')); // P2 places P1 stone at b1
    for (let i = 2; i < squares.length; i++) moves.push(place(squares[i]!, 'flat'));
    for (const m of moves) g = play(g, m);
    expect(g.outcome).toEqual({ type: 'flat', winner: 1 });
  });

  it('declares a draw when flat counts tie', () => {
    let g = createGame(5);
    const squares = [
      'a1', 'b1', 'c1', 'd1', 'e1',
      'a2', 'b2', 'c2', 'd2', 'e2',
      'a3', 'b3', 'c3', 'd3', 'e3',
      'a4', 'b4', 'c4', 'd4', 'e4',
      'a5', 'b5', 'c5', 'd5', 'e5',
    ];
    const moves: Move[] = [];
    moves.push(place(squares[0]!, 'flat'));
    moves.push(place(squares[1]!, 'flat'));
    for (let i = 2; i < squares.length; i++) {
      moves.push(place(squares[i]!, squares[i] === 'c1' ? 'standing' : 'flat'));
    }
    for (const m of moves) g = play(g, m);
    expect(g.outcome).toEqual({ type: 'flat', winner: 'draw' });
  });

  it('exhausts stones with walls, rejects a flat, then the capstone ends the game', () => {
    let g = createGame(5);
    g = play(g, place('a1', 'flat')); // P2 stone
    g = play(g, place('a5', 'flat')); // P1 stone (P1 reserve -> 20 stones)
    g = play(g, place('b1', 'standing')); // P1 wall #1
    g = play(g, place('a3', 'flat')); // P2 shuffle stone
    const wallSquares = [
      'c1', 'd1', 'e1', 'a2', 'b2', 'c2', 'd2', 'e2',
      'b3', 'c3', 'd3', 'e3', 'b4', 'c4', 'd4', 'e4',
      'b5', 'c5', 'd5',
    ];
    for (const s of wallSquares) {
      g = play(g, place(s, 'standing'));
      g = shuffle(g);
    }
    // P1 has 0 stones, 1 capstone. A flat is rejected; the capstone ends the game.
    const flatErr = applyMove(g, place('e5', 'flat'));
    expect(flatErr.isErr()).toBe(true);
    if (flatErr.isErr()) expect(flatErr.error.code).toBe('no-stones-in-reserve');

    const cap = applyMove(g, place('e5', 'capstone'));
    expect(cap.isOk()).toBe(true);
    if (cap.isOk()) expect(cap.value.outcome).toEqual({ type: 'flat', winner: 2 });
  });

  it('rejects moves after the game has finished', () => {
    let g = createGame(5);
    g = play(g, place('a1', 'flat'));
    g = play(g, place('a5', 'flat'));
    g = play(g, place('a3', 'flat'));
    g = play(g, place('a2', 'flat'));
    g = play(g, place('b3', 'flat'));
    g = play(g, place('a4', 'flat'));
    g = play(g, place('c3', 'flat'));
    g = play(g, place('b4', 'flat'));
    g = play(g, place('d3', 'flat'));
    g = play(g, place('b2', 'flat'));
    g = play(g, place('e3', 'flat')); // road win
    expect(g.outcome).toEqual({ type: 'road', winner: 1 });
    const r = applyMove(g, place('d1', 'flat'));
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('game-finished');
  });
});

/** P2 shuffles the stone at a3 <-> a4. */
function shuffle(g: GameState): GameState {
  const a3 = must(getStack(g, sq('a3')));
  const a4 = must(getStack(g, sq('a4')));
  if (a3.length > 0 && a3[a3.length - 1]!.player === 2) return play(g, move('a3', '+', [1]));
  if (a4.length > 0 && a4[a4.length - 1]!.player === 2) return play(g, move('a4', '-', [1]));
  throw new Error('shuffle stone missing');
}
