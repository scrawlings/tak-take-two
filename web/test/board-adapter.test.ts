import { describe, expect, it } from 'vitest';
import { boardComponent } from '../src/client/board-adapter.js';
import type { BoardConfig } from '../src/client/board-adapter.js';

/**
 * The Alpine adapter as plain data: the seat rule, the move field, and the
 * values the templates bind to. Alpine itself is not involved — the component
 * is an object with methods, so driving it needs no browser.
 */

const PLAYING: BoardConfig = { canMove: true, viewerSeat: 1, size: 5, selfPlay: false };

/** A board cell as the page renders it. */
function cell(square: string, height = 0, top = '', stack = ''): HTMLElement {
  return { dataset: { square, height: String(height), top, stack } } as unknown as HTMLElement;
}

function board(config: Partial<BoardConfig> = {}): ReturnType<typeof boardComponent> {
  return boardComponent({ ...PLAYING, ...config });
}

describe('the seat rule', () => {
  it('lifts a stack the viewer controls', () => {
    const b = board();
    b.cellClick(cell('b4', 3, '1|flat'));
    expect(b.source).toEqual({ square: 'b4', height: 3 });
  });

  it('leaves the opponent\'s stack alone', () => {
    const b = board();
    b.cellClick(cell('b4', 3, '2|flat'));
    expect(b.source).toBeNull();
  });

  it('lifts either colour in self-play, where one account holds both seats', () => {
    const b = board({ selfPlay: true, viewerSeat: 1 });
    b.cellClick(cell('b4', 3, '2|flat'));
    expect(b.source).toEqual({ square: 'b4', height: 3 });
  });

  it('ignores every click when the viewer may not move', () => {
    const b = board({ canMove: false });
    b.cellClick(cell('a1'));
    b.cellClick(cell('b4', 3, '1|flat'));
    expect(b.move).toBe('');
    expect(b.source).toBeNull();
  });
});

describe('the move field', () => {
  it('takes what the builder composes', () => {
    const b = board();
    b.cellClick(cell('a1'));
    expect(b.move).toBe('a1');
  });

  it('keeps a hand-typed move when a stack is picked up, composing nothing yet', () => {
    const b = board();
    b.move = 'Cc3';
    b.cellClick(cell('b4', 3, '1|flat'));
    expect(b.move).toBe('Cc3');
  });

  it('empties when the stack is put back down, so Play cannot fire a stale move', () => {
    const b = board();
    b.cellClick(cell('b4', 3, '1|flat'));
    b.cellClick(cell('b2', 0));
    expect(b.move).toBe('3b4-12');

    b.cellClick(cell('b4', 3, '1|flat')); // the source again: put it back
    expect(b.source).toBeNull();
    expect(b.move).toBe('');
  });

  it('empties on cancel, the same way', () => {
    const b = board();
    b.cellClick(cell('b4', 3, '1|flat'));
    b.cellClick(cell('b2', 0));
    b.cancel();
    expect(b.source).toBeNull();
    expect(b.move).toBe('');
  });
});

describe('what the templates bind to', () => {
  it('names the source square as a string either way', () => {
    const b = board();
    expect(b.sourceSquare).toBe('');
    b.cellClick(cell('b4', 3, '1|flat'));
    expect(b.sourceSquare).toBe('b4');
    expect(b.isSource('b4')).toBe(true);
    expect(b.isSource('b3')).toBe(false);
  });

  it('bounds the lift stepper so a live button always has somewhere to go', () => {
    const b = board();
    b.cellClick(cell('b4', 6, '1|flat'));
    expect(b.lift).toBe(5); // the carry limit
    expect(b.liftCeiling).toBe(5);
    expect(b.liftFloor).toBe(1);

    b.cellClick(cell('b2', 0)); // a path of two squares
    expect(b.liftFloor).toBe(2);
    b.bumpLift(-9);
    expect(b.lift).toBe(2);
  });

  it('reports the drops each square receives, and none for the rest', () => {
    const b = board();
    b.cellClick(cell('b4', 3, '1|flat'));
    b.cellClick(cell('b2', 0));
    expect(b.dropsOn('b3')).toBe(1);
    expect(b.dropsOn('b2')).toBe(2);
    expect(b.dropsOn('a1')).toBe(0);

    b.shiftDrop(1, -1); // push a stone from b2 back to b3
    expect(b.dropsOn('b3')).toBe(2);
    expect(b.move).toBe('3b4-21');
  });

  it('says when a shift would do nothing, so a dead button looks dead', () => {
    const b = board();
    b.cellClick(cell('b4', 3, '1|flat'));
    b.cellClick(cell('b2', 0)); // b3 gets 1, b2 gets 2
    expect(b.canShiftDrop(0, -1)).toBe(false); // nothing before the first square
    expect(b.canShiftDrop(0, 1)).toBe(false); // b3 holds its last stone
    expect(b.canShiftDrop(1, -1)).toBe(true);
    expect(b.canShiftDrop(1, 1)).toBe(false); // nothing after the last square
  });

  it('places the stone the picker chose', () => {
    const b = board();
    b.pick('capstone');
    expect(b.stone).toBe('capstone');
    b.cellClick(cell('c3'));
    expect(b.move).toBe('Cc3');
  });
});

describe('the source stack, shown as its own glyphs', () => {
  it('marks the cut between what stays and what is lifted, unsplit before a direction is chosen', () => {
    const b = board();
    b.cellClick(cell('b4', 3, '1|flat', '●●○')); // lifting all 3: nothing stays
    expect(b.partition).toBe('●●○');
  });

  it('shows what stays behind when the lift is less than the whole stack', () => {
    const b = board();
    b.cellClick(cell('b4', 5, '1|flat', '●●●○○')); // carry limit 5, lifting only 2
    b.bumpLift(-3);
    expect(b.partition).toBe('●●● ‖ ○○');
  });

  it('splits the lifted part into one group per path square, in drop order', () => {
    const b = board();
    b.cellClick(cell('b4', 3, '1|flat', '●●○'));
    b.cellClick(cell('b2', 0)); // b3 gets 1, b2 gets 2
    expect(b.partition).toBe('● · ●○');

    b.shiftDrop(1, -1); // b3 gets 2, b2 gets 1
    expect(b.partition).toBe('●● · ○');
  });

  it('marks both cuts together: what stays, then each square along the path', () => {
    const b = board();
    b.cellClick(cell('b4', 5, '1|flat', '●●●○○')); // carry limit 5, lifting only 2
    b.bumpLift(-3);
    b.cellClick(cell('b2', 0)); // b3 gets 1, b2 gets 1
    expect(b.partition).toBe('●●● ‖ ○ · ○');
  });

  it('clears when the stack is put back down', () => {
    const b = board();
    b.cellClick(cell('b4', 3, '1|flat', '●●○'));
    b.cellClick(cell('b4', 3, '1|flat', '●●○')); // the source again: put it back
    expect(b.partition).toBe('');
  });
});
