import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { formatMove, parseMove } from '@tak/core';
import {
  chooseStone,
  clearSelection,
  clickSquare,
  createBuilder,
  maxLift,
  moveDrop,
  setLift,
} from '../src/client/move-builder.js';
import type { BuilderState } from '../src/client/move-builder.js';
import { sourcesFingerprint } from '../scripts/client-fingerprint.js';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMMITTED_BUNDLE = readFileSync(join(webRoot, 'static', 'client.js'), 'utf8');
const COMMITTED_FINGERPRINT = JSON.parse(
  readFileSync(join(webRoot, 'static', 'client.fingerprint.json'), 'utf8'),
) as { fingerprint: string };

/**
 * The board move builder at its interface: clicks and adjustments in, composed
 * PTN out. The DOM and the seat rule belong to the Alpine adapter, so nothing
 * here needs a browser.
 */

/** The no-drift guarantee: whatever the builder composes, core reads back identically. */
function roundTrips(notation: string): boolean {
  const parsed = parseMove(notation);
  return parsed.isOk() && formatMove(parsed.value) === notation;
}

/** Click a square that holds a stack of the viewer's own. */
function pickSource(state: BuilderState, square: string, height: number): BuilderState {
  return clickSquare(state, { square, height, mine: true });
}

/** Click an empty square. */
function clickEmpty(state: BuilderState, square: string): BuilderState {
  return clickSquare(state, { square, height: 0, mine: false });
}

/** Click a square that holds stones (whoever owns them). */
function clickStack(state: BuilderState, square: string, height = 1): BuilderState {
  return clickSquare(state, { square, height, mine: false });
}

describe('placing a stone', () => {
  it('composes a flat placement from one click', () => {
    const state = clickEmpty(createBuilder(5), 'a1');
    expect(state.notation).toBe('a1');
    expect(roundTrips(state.notation)).toBe(true);
  });

  it('composes the chosen stone kind', () => {
    const wall = clickEmpty(chooseStone(createBuilder(5), 'standing'), 'c3');
    expect(wall.notation).toBe('Sc3');
    expect(roundTrips(wall.notation)).toBe(true);

    const cap = clickEmpty(chooseStone(createBuilder(5), 'capstone'), 'c3');
    expect(cap.notation).toBe('Cc3');
    expect(roundTrips(cap.notation)).toBe(true);
  });

  it('ignores an occupied square that is not the viewer\'s to lift', () => {
    const state = clickStack(createBuilder(5), 'a1', 2);
    expect(state.notation).toBe('');
    expect(state.source).toBeNull();
  });
});

describe('selecting a source stack', () => {
  it('selects the stack and lifts as many stones as the carry limit allows', () => {
    const state = pickSource(createBuilder(5), 'b4', 8);
    expect(state.source).toEqual({ square: 'b4', height: 8 });
    expect(state.lift).toBe(5); // carry limit on a 5×5 board
    expect(maxLift(state)).toBe(5);
  });

  it('lifts the whole stack when it is shorter than the carry limit', () => {
    const state = pickSource(createBuilder(6), 'b4', 3);
    expect(state.lift).toBe(3);
    expect(maxLift(state)).toBe(3);
  });

  it('composes nothing until a destination is chosen', () => {
    const state = pickSource(clickEmpty(createBuilder(5), 'a1'), 'b4', 3);
    expect(state.notation).toBe('');
    expect(state.path).toEqual([]);
  });

  it('cancels on a second click of the source', () => {
    const state = pickSource(pickSource(createBuilder(5), 'b4', 3), 'b4', 3);
    expect(state.source).toBeNull();
    expect(state.lift).toBe(0);
    expect(state.notation).toBe('');
  });

  it('clears the whole selection on demand', () => {
    const state = clearSelection(pickSource(createBuilder(5), 'b4', 3));
    expect(state.source).toBeNull();
    expect(state.path).toEqual([]);
    expect(state.notation).toBe('');
  });
});

describe('choosing a path', () => {
  const source = (): BuilderState => pickSource(createBuilder(5), 'b2', 3);

  it('spreads one stone per crossed square, the remainder on the last', () => {
    const state = clickStack(source(), 'b4');
    expect(state.path).toEqual([
      { square: 'b3', drops: 1 },
      { square: 'b4', drops: 2 },
    ]);
    expect(state.notation).toBe('3b2+12');
    expect(roundTrips(state.notation)).toBe(true);
  });

  it('reads every direction off the board', () => {
    expect(clickStack(source(), 'b4').notation).toBe('3b2+12');
    expect(clickStack(source(), 'b1').notation).toBe('3b2-3');
    expect(clickStack(source(), 'd2').notation).toBe('3b2>12');
    expect(clickStack(source(), 'a2').notation).toBe('3b2<3');
  });

  it('refuses a destination that is not in a straight line', () => {
    const state = clickStack(source(), 'c3');
    expect(state.path).toEqual([]);
    expect(state.notation).toBe('');
    expect(state.source).not.toBeNull(); // the selection survives a bad click
  });

  it('refuses a path longer than the stones in hand', () => {
    const short = pickSource(createBuilder(5), 'a1', 2);
    const state = clickStack(short, 'a5'); // 4 squares, 2 stones
    expect(state.path).toEqual([]);
    expect(state.notation).toBe('');
  });

  it('re-targets on a second destination click instead of resetting', () => {
    const state = clickStack(clickStack(source(), 'b4'), 'd2');
    expect(state.notation).toBe('3b2>12');
    expect(state.source).toEqual({ square: 'b2', height: 3 });
  });

  it('composes a capstone flatten: one stone, one square', () => {
    const state = clickStack(setLift(pickSource(createBuilder(5), 'b4', 4), 1), 'b5');
    expect(state.notation).toBe('1b4+1');
    expect(roundTrips(state.notation)).toBe(true);
  });
});

describe('adjusting the lift', () => {
  it('recomposes the move with the smaller lift', () => {
    const state = setLift(clickStack(pickSource(createBuilder(5), 'b2', 5), 'b4'), 2);
    expect(state.lift).toBe(2);
    expect(state.path).toEqual([
      { square: 'b3', drops: 1 },
      { square: 'b4', drops: 1 },
    ]);
    expect(state.notation).toBe('2b2+11');
    expect(roundTrips(state.notation)).toBe(true);
  });

  it('never lifts more than the stack holds or the carry limit allows', () => {
    const state = pickSource(createBuilder(5), 'b2', 3);
    expect(setLift(state, 9).lift).toBe(3);
    expect(setLift(pickSource(createBuilder(5), 'b2', 8), 9).lift).toBe(5);
  });

  it('never lifts fewer than one stone, nor fewer than the path needs', () => {
    const state = clickStack(pickSource(createBuilder(5), 'b2', 5), 'b4'); // 2 squares
    expect(setLift(state, 0).lift).toBe(2);
    expect(setLift(state, 1).lift).toBe(2);
    expect(setLift(pickSource(createBuilder(5), 'b2', 5), 0).lift).toBe(1);
  });

  it('does nothing without a source', () => {
    expect(setLift(createBuilder(5), 3).lift).toBe(0);
  });
});

describe('shifting stones along the path', () => {
  /** Lift 5 from b1 across b2, b3, b4 — the opening spread is 1, 1, 3. */
  const spread = (): BuilderState => clickStack(pickSource(createBuilder(5), 'b1', 5), 'b4');
  const drops = (state: BuilderState): number[] => state.path.map((step) => step.drops);

  it('starts from the opening spread', () => {
    expect(spread().notation).toBe('5b1+113');
  });

  it('moves a stone back to the square before it', () => {
    const state = moveDrop(spread(), 2, -1);
    expect(drops(state)).toEqual([1, 2, 2]);
    expect(state.notation).toBe('5b1+122');
    expect(roundTrips(state.notation)).toBe(true);
  });

  it('moves a stone on to the square after it', () => {
    const state = moveDrop(moveDrop(spread(), 2, -1), 1, 1);
    expect(drops(state)).toEqual([1, 1, 3]);
    expect(state.notation).toBe('5b1+113');
  });

  it('walks a stone up the path, one neighbour at a time', () => {
    const state = moveDrop(moveDrop(spread(), 2, -1), 1, -1);
    expect(drops(state)).toEqual([2, 1, 2]);
    expect(state.notation).toBe('5b1+212');
    expect(roundTrips(state.notation)).toBe(true);
  });

  it('reaches every square of a long path, not just the last two', () => {
    // The opening spread of a four-square path leaves three squares holding one
    // stone; each still has to be raisable, by pushing a stone along to it.
    const long = clickStack(pickSource(createBuilder(5), 'b1', 5), 'b5');
    expect(drops(long)).toEqual([1, 1, 1, 2]);
    const walked = moveDrop(moveDrop(moveDrop(long, 3, -1), 2, -1), 1, -1);
    expect(drops(walked)).toEqual([2, 1, 1, 1]);
    expect(walked.notation).toBe('5b1+2111');
    expect(roundTrips(walked.notation)).toBe(true);
  });

  it('never empties a square: its last stone stays put', () => {
    expect(drops(moveDrop(spread(), 0, 1))).toEqual([1, 1, 3]);
    expect(drops(moveDrop(spread(), 1, -1))).toEqual([1, 1, 3]);
  });

  it('has nowhere to push beyond either end of the path', () => {
    const ends = moveDrop(moveDrop(spread(), 2, -1), 1, -1); // 2, 1, 2
    expect(drops(moveDrop(ends, 0, -1))).toEqual([2, 1, 2]);
    expect(drops(moveDrop(ends, 2, 1))).toEqual([2, 1, 2]);
  });

  it('keeps the drops summing to the lift through any run of shifts', () => {
    let state = spread();
    for (const [index, towards] of [[2, -1], [1, -1], [0, 1], [2, -1], [1, 1], [0, -1]] as const) {
      state = moveDrop(state, index, towards);
      expect(state.path.reduce((sum, step) => sum + step.drops, 0)).toBe(state.lift);
      expect(state.path.every((step) => step.drops >= 1)).toBe(true);
      expect(roundTrips(state.notation)).toBe(true);
    }
  });

  it('ignores an index that is not on the path', () => {
    expect(moveDrop(spread(), 7, -1).notation).toBe('5b1+113');
    expect(moveDrop(createBuilder(5), 0, 1).notation).toBe('');
  });

  it('reaches every legal distribution, leaving none unbuildable', () => {
    // The property the interaction lives or dies by: shifting between
    // neighbours must reach every way of splitting the lift across the path,
    // or some distributions could only be typed. Compositions of `lift` into
    // `n` positive parts number C(lift - 1, n - 1); a search from the opening
    // spread must find exactly that many.
    const choose = (n: number, k: number): number => (k === 0 ? 1 : (n * choose(n - 1, k - 1)) / k);

    for (const [size, height, destination] of [[5, 5, 'b4'], [5, 5, 'b5'], [6, 6, 'b6'], [5, 4, 'b3']] as const) {
      const start = clickStack(pickSource(createBuilder(size), 'b1', height), destination);
      const squares = start.path.length;
      const seen = new Set([drops(start).join(',')]);
      const queue = [start];
      while (queue.length > 0) {
        const state = queue.shift()!;
        for (let i = 0; i < squares; i++) {
          for (const towards of [1, -1] as const) {
            const next = moveDrop(state, i, towards);
            const key = drops(next).join(',');
            if (seen.has(key)) continue;
            seen.add(key);
            queue.push(next);
            expect(roundTrips(next.notation)).toBe(true);
          }
        }
      }
      expect(seen.size, `${height} stones over ${squares} squares`).toBe(choose(height - 1, squares - 1));
    }
  });
});

describe('everything the builder composes re-parses as core wrote it', () => {
  it('round-trips placements, spreads, adjusted drops, and flattens', () => {
    const composed: string[] = [];
    const record = (state: BuilderState): BuilderState => {
      if (state.notation !== '') composed.push(state.notation);
      return state;
    };

    for (const size of [5, 6]) {
      for (const stone of ['flat', 'standing', 'capstone'] as const) {
        record(clickEmpty(chooseStone(createBuilder(size), stone), 'c3'));
      }
      for (const destination of ['b5', 'b1', 'e3', 'a3']) {
        const from = pickSource(createBuilder(size), 'b3', size);
        const path = record(clickStack(from, destination));
        record(moveDrop(path, path.path.length - 1, -1));
        record(setLift(path, 1));
      }
    }

    expect(composed.length).toBeGreaterThan(20);
    for (const notation of composed) {
      expect(roundTrips(notation), notation).toBe(true);
    }
  });
});

describe('the committed bundle', () => {
  it('was built from the client sources as they stand', () => {
    // The bundle is committed so nothing needs a build step to run; the cost is
    // that editing src/client/ without rebuilding would serve a stale script.
    expect(COMMITTED_FINGERPRINT.fingerprint, 'run `npm run build:client -w web`').toBe(sourcesFingerprint());
  });

  it('carries the builder and registers every component the site has', () => {
    expect(COMMITTED_BUNDLE).toContain('takBoard');
    expect(COMMITTED_BUNDLE).toContain('takStream');
    expect(COMMITTED_BUNDLE).toContain('alpine:init');
    // It is served as a file now (ADR-0013), so the inline-tag constraint is
    // gone — but nothing in the sources writes a closing tag anyway.
  });
});
