import { describe, expect, it, vi } from 'vitest';
import { boardComponent } from '../src/client/board-adapter.js';
import type { BoardConfig } from '../src/contract.js';

/**
 * The Alpine adapter as plain data: the seat rule, the move field, and the
 * values the templates bind to. Alpine itself is not involved — the component
 * is an object with methods, so driving it needs no browser.
 */

const PLAYING: BoardConfig = { size: 5 };

/** The standing the page renders onto the board element, as its dataset. */
interface Standing {
  canMove?: string;
  viewerSeat?: string;
  selfPlay?: string;
}

const MY_TURN: Standing = { canMove: '1', viewerSeat: '1', selfPlay: '0' };

/**
 * A board cell as the page renders it, inside the board it belongs to. The
 * adapter reads the standing off that board on every click, so a test drives
 * it the same way the stream does: by changing the board, not the component.
 */
function cell(square: string, height = 0, top = '', stack = '', standing: Standing = MY_TURN): HTMLElement {
  const boardEl = { dataset: standing };
  return {
    dataset: { square, height: String(height), top, stack },
    closest: (selector: string) => (selector === '.board' ? boardEl : null),
  } as unknown as HTMLElement;
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
    const b = board();
    b.cellClick(cell('b4', 3, '2|flat', '', { canMove: '1', viewerSeat: '1', selfPlay: '1' }));
    expect(b.source).toEqual({ square: 'b4', height: 3 });
  });

  it('ignores every click when the viewer may not move', () => {
    const b = board();
    const waiting: Standing = { canMove: '0', viewerSeat: '1', selfPlay: '0' };
    b.cellClick(cell('a1', 0, '', '', waiting));
    b.cellClick(cell('b4', 3, '1|flat', '', waiting));
    expect(b.move).toBe('');
    expect(b.source).toBeNull();
  });

  it('leaves a spectator, who holds no seat, unable to compose anything', () => {
    const b = board();
    const watching: Standing = { canMove: '0', viewerSeat: '', selfPlay: '0' };
    b.cellClick(cell('b4', 3, '1|flat', '', watching));
    expect(b.source).toBeNull();
  });

  /**
   * The bug this pins: the standing used to live in the `x-data` config, which
   * the stream never replaces (ADR-0007), so a board that became playable
   * mid-page stayed inert — a live move form above squares that refused every
   * click. Reading it off the streamed board element is what fixes it.
   */
  it('becomes playable when a streamed board says the turn has passed to the viewer', () => {
    const b = board();
    const waiting: Standing = { canMove: '0', viewerSeat: '1', selfPlay: '0' };
    b.cellClick(cell('b4', 3, '1|flat', '', waiting));
    expect(b.source).toBeNull();

    // The opponent moved: the stream swapped in a board whose standing says so.
    b.cellClick(cell('b4', 3, '1|flat', '', MY_TURN));

    expect(b.source).toEqual({ square: 'b4', height: 3 });
  });

  it('goes inert again when a streamed board says the turn has passed away', () => {
    const b = board();
    b.cellClick(cell('a1'));
    expect(b.move).toBe('a1');

    b.cellClick(cell('c3', 0, '', '', { canMove: '0', viewerSeat: '1', selfPlay: '0' }));

    expect(b.move).toBe('a1');
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

/** A history entry's clickable element, as `renderHistory` renders it. */
function move(number: number, tps: string, total = number): HTMLElement {
  return { dataset: { moveNumber: String(number), tps, total: String(total) } } as unknown as HTMLElement;
}

/** The review bar's element, carrying the move total as of its last render. */
function reviewBar(total: number): HTMLElement {
  return { dataset: { totalMoves: String(total) } } as unknown as HTMLElement;
}

const AFTER_MOVE_1 = 'x,2,x3/x5/x5/x5/x5 2 1';
const AFTER_MOVE_2 = 'x,2,x3/x5/x5/x5/1,x4 1 2';

describe('review mode', () => {
  it('starts live: not reviewing, nothing to show', () => {
    const b = board();
    expect(b.reviewing).toBe(false);
    expect(b.reviewAt).toBeNull();
    expect(b.reviewCell('a1')).toBe('');
  });

  it('enters review at the clicked move, rendering that position', () => {
    const b = board();
    b.scrubTo(move(1, AFTER_MOVE_1));
    expect(b.reviewing).toBe(true);
    expect(b.reviewAt).toBe(1);
    expect(b.reviewCell('b5')).toBe('○'); // the opponent's opening flat, placed at b5
    expect(b.reviewCell('a1')).toBe('·');
  });

  it('moves between reviewed positions on further clicks', () => {
    const b = board();
    b.scrubTo(move(1, AFTER_MOVE_1));
    b.scrubTo(move(2, AFTER_MOVE_2));
    expect(b.reviewAt).toBe(2);
    expect(b.reviewCell('a1')).toBe('●');
  });

  it('snaps back to live, clearing the reviewed position', () => {
    const b = board();
    b.scrubTo(move(1, AFTER_MOVE_1));
    b.snapToEnd();
    expect(b.reviewing).toBe(false);
    expect(b.reviewAt).toBeNull();
    expect(b.reviewCell('b5')).toBe('');
  });

  it('ignores a click carrying TPS that will not parse, rather than entering a broken review', () => {
    const b = board();
    b.scrubTo(move(1, 'not tps'));
    expect(b.reviewing).toBe(false);
  });

  it('refuses every board click while reviewing, however the turn stands', () => {
    const b = board();
    b.scrubTo(move(1, AFTER_MOVE_1));
    b.cellClick(cell('c3', 0, '', '', MY_TURN));
    expect(b.move).toBe('');
    expect(b.source).toBeNull();
  });

  it('drops an in-progress composition on entering review, so no stale path lingers', () => {
    const b = board();
    b.cellClick(cell('b4', 3, '1|flat'));
    expect(b.source).not.toBeNull();

    b.scrubTo(move(1, AFTER_MOVE_1));
    expect(b.source).toBeNull();
    expect(b.move).toBe('');
  });

  it('reads reserves off the reviewed position, and nothing while live', () => {
    const b = board();
    expect(b.reviewReserve(1, 'stones')).toBe('');

    b.scrubTo(move(1, AFTER_MOVE_1));
    // 5x5 starts with 21 stones each; the opening move placed one of player 2's.
    expect(b.reviewReserve(2, 'stones')).toBe('20');
    expect(b.reviewReserve(1, 'stones')).toBe('21');
  });

  it('notices a move streamed in since review started, and stays quiet before that', () => {
    const b = board();
    b.scrubTo(move(1, AFTER_MOVE_1, 1));
    expect(b.newMoveWhileReviewing(reviewBar(1))).toBe(false);
    expect(b.newMoveWhileReviewing(reviewBar(2))).toBe(true);
  });

  it('never flags a new move while live — there is nothing to compare against', () => {
    const b = board();
    expect(b.newMoveWhileReviewing(reviewBar(2))).toBe(false);
  });
});

/** A form as `handleKey`'s `submitForm` finds it: only its action and a spy on submit. */
function form(action: string): HTMLFormElement {
  return { action, requestSubmit: vi.fn() } as unknown as HTMLFormElement;
}

/** The page's root, scoped to the move-links and forms a test wants `handleKey` to find. */
function root(links: HTMLElement[] = [], forms: HTMLFormElement[] = []): HTMLElement {
  return {
    querySelectorAll: (selector: string) => (selector === '.move-link' ? links : []),
    querySelector: (selector: string) => {
      const suffix = /^form\[action\$="(.+)"\]$/.exec(selector)?.[1];
      if (suffix === undefined) return null;
      return forms.find((f) => f.action.endsWith(suffix)) ?? null;
    },
  } as unknown as HTMLElement;
}

/** A keystroke as `handleKey` reads it — a plain object, no DOM. */
function key(k: string, target: { tagName?: string; isContentEditable?: boolean } | null = null): {
  key: string;
  target: typeof target;
  preventDefault: () => void;
} {
  return { key: k, target, preventDefault: vi.fn() };
}

describe('keyboard shortcuts', () => {
  it('ignores a key with no binding, and one typed into an input', () => {
    const b = board();
    const e = key('x');
    b.handleKey(e);
    expect(e.preventDefault).not.toHaveBeenCalled();

    const typing = key('u', { tagName: 'INPUT' });
    b.handleKey(typing);
    expect(typing.preventDefault).not.toHaveBeenCalled();
  });

  it('"?" toggles the help panel', () => {
    const b = board();
    b.handleKey(key('?'));
    expect(b.helpVisible).toBe(true);
    b.handleKey(key('?'));
    expect(b.helpVisible).toBe(false);
  });

  it('Escape cancels an in-progress composition', () => {
    const b = board();
    b.cellClick(cell('b4', 3, '1|flat'));
    expect(b.source).not.toBeNull();
    b.handleKey(key('Escape'));
    expect(b.source).toBeNull();
  });

  it('Escape snaps back to live when reviewing, in preference to cancelling', () => {
    const b = board();
    b.$root = root([move(1, AFTER_MOVE_1)]);
    b.scrubTo(move(1, AFTER_MOVE_1));
    b.handleKey(key('Escape'));
    expect(b.reviewing).toBe(false);
  });

  it('Enter submits the move form', () => {
    const b = board();
    const moveForm = form('/games/1/move');
    b.$root = root([], [moveForm]);
    b.handleKey(key('Enter'));
    expect(moveForm.requestSubmit).toHaveBeenCalledOnce();
  });

  it('Enter does nothing while reviewing — the form is not there to submit', () => {
    const b = board();
    const moveForm = form('/games/1/move');
    const links = [move(1, AFTER_MOVE_1)];
    b.$root = root(links, [moveForm]);
    b.scrubTo(links[0]!);
    b.handleKey(key('Enter'));
    expect(moveForm.requestSubmit).not.toHaveBeenCalled();
  });

  it('"u" submits the take-back form when one is offered', () => {
    const b = board();
    const takeBackForm = form('/games/1/take-back');
    b.$root = root([], [takeBackForm]);
    b.handleKey(key('u'));
    expect(takeBackForm.requestSubmit).toHaveBeenCalledOnce();
  });

  it('"u" is a no-op when no take-back form is rendered', () => {
    const b = board();
    b.$root = root();
    expect(() => b.handleKey(key('u'))).not.toThrow();
  });

  it('"[" from live enters review at the last move', () => {
    const b = board();
    const links = [move(1, AFTER_MOVE_1, 2), move(2, AFTER_MOVE_2, 2)];
    b.$root = root(links);
    b.handleKey(key('['));
    expect(b.reviewAt).toBe(2);
  });

  it('"[" steps further back, stopping at the start', () => {
    const b = board();
    const links = [move(1, AFTER_MOVE_1, 2), move(2, AFTER_MOVE_2, 2)];
    b.$root = root(links);
    b.scrubTo(links[1]!);
    b.handleKey(key('['));
    expect(b.reviewAt).toBe(1);
    b.handleKey(key('[')); // at the start: no-op
    expect(b.reviewAt).toBe(1);
  });

  it('"]" from live is a no-op — there is nothing beyond it', () => {
    const b = board();
    const links = [move(1, AFTER_MOVE_1, 1)];
    b.$root = root(links);
    b.handleKey(key(']'));
    expect(b.reviewing).toBe(false);
  });

  it('"]" steps forward, snapping to live from the last move', () => {
    const b = board();
    const links = [move(1, AFTER_MOVE_1, 2), move(2, AFTER_MOVE_2, 2)];
    b.$root = root(links);
    b.scrubTo(links[0]!);
    b.handleKey(key(']'));
    expect(b.reviewAt).toBe(2);
    b.handleKey(key(']'));
    expect(b.reviewing).toBe(false);
  });
});
