import { describe, expect, it } from 'vitest';
import { applyMove, createGame, getStack } from '../src/index';
import {
  buildP1Stack,
  move,
  must,
  openedGame,
  place,
  play,
  p2Shuffle,
  sq,
  withP2Shuffle,
} from './helpers';

describe('stack moves', () => {
  it('moves a stack, dropping one stone per square and emptying the source', () => {
    let g = withP2Shuffle(openedGame());
    g = buildP1Stack(g, 'b1', 'b2', '-', 2);
    g = p2Shuffle(g); // P1 to move
    const r = applyMove(g, move('b1', '>', [1, 1]));
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(must(getStack(r.value, sq('b1')))).toEqual([]);
      expect(must(getStack(r.value, sq('c1')))).toEqual([{ player: 1, kind: 'flat' }]);
      expect(must(getStack(r.value, sq('d1')))).toEqual([{ player: 1, kind: 'flat' }]);
      expect(r.value.playerToMove).toBe(2);
    }
  });

  it('rejects a stack move on the opening turn', () => {
    const g = createGame(5);
    const r = applyMove(g, move('a1', '>', [1]));
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('opening-not-complete');
  });

  it('rejects moving from an empty square', () => {
    const g = openedGame();
    const r = applyMove(g, move('c3', '>', [1]));
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('source-empty');
  });

  it('rejects moving a stack the opponent controls', () => {
    let g = openedGame();
    g = play(g, place('b1', 'flat')); // P1
    g = play(g, place('b2', 'flat')); // P2
    g = play(g, place('c2', 'flat')); // P1
    g = play(g, move('b2', '-', [1])); // P2 onto b1 -> [P1, P2]
    const r = applyMove(g, move('b1', '>', [1])); // P1 tries
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('not-your-stack');
  });

  it('rejects lifting more than the carry limit', () => {
    let g = withP2Shuffle(openedGame());
    g = buildP1Stack(g, 'b1', 'b2', '-', 5);
    g = p2Shuffle(g);
    const r = applyMove(g, move('b1', '>', [6]));
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('carry-limit-exceeded');
  });

  it('rejects lifting more stones than the stack holds', () => {
    let g = withP2Shuffle(openedGame());
    g = buildP1Stack(g, 'b1', 'b2', '-', 2);
    g = p2Shuffle(g);
    const r = applyMove(g, move('b1', '>', [3]));
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('carry-exceeds-stack');
  });

  it('rejects malformed drop counts', () => {
    let g = openedGame();
    g = play(g, place('b1', 'flat')); // P1
    g = play(g, place('a3', 'flat')); // P2
    for (const drops of [[0], [1, 0], [1.5]]) {
      const r = applyMove(g, move('b1', '>', drops));
      expect(r.isErr()).toBe(true);
      if (r.isErr()) expect(r.error.code).toBe('invalid-drop');
    }
    const empty = applyMove(g, move('b1', '>', []));
    expect(empty.isErr()).toBe(true);
    if (empty.isErr()) expect(empty.error.code).toBe('no-drops');
  });

  it('rejects moves that run off the board', () => {
    let g = openedGame();
    g = play(g, place('a2', 'flat')); // P1
    g = play(g, place('a3', 'flat')); // P2
    const r = applyMove(g, move('a2', '<', [1]));
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('drops-off-board');
  });

  it('rejects moving through a standing stone', () => {
    let g = withP2Shuffle(openedGame());
    g = buildP1Stack(g, 'b1', 'b2', '-', 2);
    g = play(g, place('c1', 'standing')); // P2 wall
    const r = applyMove(g, move('b1', '>', [1, 1])); // b1->c1->d1
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('crossing-standing-stone');
  });

  it('rejects landing a flat on a standing stone', () => {
    let g = withP2Shuffle(openedGame());
    g = play(g, place('b1', 'flat')); // P1
    g = play(g, place('c1', 'standing')); // P2 wall
    const r = applyMove(g, move('b1', '>', [1]));
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('cannot-stack-on-standing-stone');
  });

  it('flattens a standing stone when a lone capstone lands on it', () => {
    let g = openedGame();
    g = play(g, place('b1', 'capstone')); // P1
    g = play(g, place('c1', 'standing')); // P2 wall
    const r = applyMove(g, move('b1', '>', [1]));
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(must(getStack(r.value, sq('c1')))).toEqual([
        { player: 2, kind: 'flat' },
        { player: 1, kind: 'capstone' },
      ]);
    }
  });

  it('rejects crushing when the capstone is not dropped alone', () => {
    let g = openedGame();
    g = play(g, place('b1', 'flat')); // P1
    g = play(g, place('c1', 'standing')); // P2 wall
    g = play(g, place('b2', 'capstone')); // P1 staged capstone
    g = play(g, place('e1', 'flat')); // P2 filler
    g = play(g, move('b2', '-', [1])); // P1: capstone onto b1 -> [flat, capstone]
    g = play(g, place('d1', 'flat')); // P2 filler
    const r = applyMove(g, move('b1', '>', [2])); // both stones onto the wall
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('cannot-stack-on-standing-stone');
  });

  it('rejects landing on a capstone', () => {
    let g = openedGame();
    g = play(g, place('b1', 'flat')); // P1
    g = play(g, place('c1', 'capstone')); // P2 capstone
    const r = applyMove(g, move('b1', '>', [1]));
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('cannot-stack-on-capstone');
  });

  it('rejects moving through a capstone', () => {
    let g = withP2Shuffle(openedGame());
    g = buildP1Stack(g, 'b1', 'b2', '-', 2);
    g = play(g, place('c1', 'capstone')); // P2 capstone
    const r = applyMove(g, move('b1', '>', [1, 1]));
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('crossing-capstone');
  });
});
