import { describe, expect, it } from 'vitest';
import { applyMove, createGame, generateTps, parseMove, parseTps } from '@tak/core';
import type { GameState } from '@tak/core';
import {
  cellContent,
  parseReviewPosition,
  reserveAt,
  stackTipContent,
  stoneGlyph,
} from '../src/client/review.js';
import type { ReviewPosition } from '../src/client/review.js';

/**
 * The scrubber's TPS parser at its interface (ADR-0006): a TPS string in,
 * the cell and reserve data the board and stones-left table render from out.
 * No DOM, no Alpine — the adapter owns those.
 */

const FILES = 'abcde';

/** Play a sequence of PTN moves from an empty 5x5 board, failing loudly on a bad fixture. */
function play(moves: readonly string[]): GameState {
  let state = createGame(5);
  for (const notation of moves) {
    const move = parseMove(notation);
    if (move.isErr()) throw new Error(`fixture move "${notation}" did not parse: ${move.error.message}`);
    const applied = applyMove(state, move.value);
    if (applied.isErr()) throw new Error(`fixture move "${notation}" was illegal: ${applied.error.message}`);
    state = applied.value;
  }
  return state;
}

/** Every square name on a 5x5 board, so a test can walk the whole grid. */
const SQUARES = FILES.split('').flatMap((file) => [1, 2, 3, 4, 5].map((rank) => `${file}${rank}`));

describe('parsing a TPS position', () => {
  it('round-trips against core: every TPS the server would emit re-parses through both parsers alike', () => {
    const state = play(['a1', 'e5', 'Sc3', 'b2', 'a2', 'e4', '1a2-1']);
    const tps = generateTps(state);

    // Core itself must accept the string this module is fed (ADR-0006's
    // no-drift discipline), and land on the same position core built.
    const corePosition = parseTps(tps);
    expect(corePosition.isOk()).toBe(true);
    expect(corePosition._unsafeUnwrap()).toEqual(state);

    const position = parseReviewPosition(tps);
    expect(position).not.toBeNull();

    for (const square of SQUARES) {
      const file = square[0]!;
      const rank = Number(square.slice(1));
      const fi = FILES.indexOf(file);
      const coreStack = state.board.grid[fi]?.[rank - 1] ?? [];
      const parsedStack = position!.stacks[square] ?? [];
      expect(parsedStack, square).toEqual(coreStack.map((s) => ({ player: s.player, kind: s.kind })));
    }
  });

  it('round-trips reserves against core for both seats', () => {
    const state = play(['a1', 'e5', 'Sc3', 'b2']);
    const position = parseReviewPosition(generateTps(state));

    expect(position!.reserves[1]).toEqual(state.reserves[1]);
    expect(position!.reserves[2]).toEqual(state.reserves[2]);
  });

  it('round-trips a stack with a capstone on top', () => {
    const state = play(['a1', 'e5', 'a2', 'e4', 'Ca3', 'e3', '1a3-1']);
    const position = parseReviewPosition(generateTps(state));

    for (const square of SQUARES) {
      const file = square[0]!;
      const rank = Number(square.slice(1));
      const fi = FILES.indexOf(file);
      const coreStack = state.board.grid[fi]?.[rank - 1] ?? [];
      expect(position!.stacks[square] ?? []).toEqual(coreStack.map((s) => ({ player: s.player, kind: s.kind })));
    }
  });

  it('rejects text that is not TPS', () => {
    expect(parseReviewPosition('not tps')).toBeNull();
    expect(parseReviewPosition('')).toBeNull();
    expect(parseReviewPosition('x5/x5/x5/x5/x5 3 1')).toBeNull(); // turn out of range
  });
});

describe('cell and stack-tip markup', () => {
  const position: ReviewPosition = {
    size: 5,
    stacks: {
      a1: [{ player: 1, kind: 'flat' }],
      b2: [
        { player: 1, kind: 'flat' },
        { player: 2, kind: 'flat' },
        { player: 1, kind: 'standing' },
      ],
    },
    reserves: { 1: { stones: 18, capstones: 1 }, 2: { stones: 19, capstones: 1 } },
  };

  it('shows an empty square as a dot with no height', () => {
    expect(cellContent(position, 'c3')).toBe('·');
    expect(stackTipContent(position, 'c3')).toBe('');
  });

  it('shows the top stone with no height marker on a single stone', () => {
    expect(cellContent(position, 'a1')).toBe('●');
  });

  it('shows the top stone and a height marker on a taller stack', () => {
    expect(cellContent(position, 'b2')).toBe('▲<span class="cell-height">3</span>');
  });

  it('renders the stack-tip top to bottom', () => {
    expect(stackTipContent(position, 'b2')).toBe(
      '<span class="stack-tip"><span>▲</span><span>○</span><span>●</span></span>',
    );
  });

  it('matches the glyphs views.ts uses for each seat and stone kind', () => {
    expect(stoneGlyph({ player: 1, kind: 'flat' })).toBe('●');
    expect(stoneGlyph({ player: 2, kind: 'flat' })).toBe('○');
    expect(stoneGlyph({ player: 1, kind: 'standing' })).toBe('▲');
    expect(stoneGlyph({ player: 2, kind: 'standing' })).toBe('△');
    expect(stoneGlyph({ player: 1, kind: 'capstone' })).toBe('■');
    expect(stoneGlyph({ player: 2, kind: 'capstone' })).toBe('□');
  });
});

describe('reserves', () => {
  const position: ReviewPosition = {
    size: 6,
    stacks: {},
    reserves: { 1: { stones: 12, capstones: 0 }, 2: { stones: 30, capstones: 1 } },
  };

  it('reads a seat\'s stones and capstones', () => {
    expect(reserveAt(position, 1, 'stones')).toBe(12);
    expect(reserveAt(position, 1, 'capstones')).toBe(0);
    expect(reserveAt(position, 2, 'stones')).toBe(30);
  });
});
