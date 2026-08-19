import { describe, expect, it } from 'vitest';
import { streamComponent } from '../src/client/stream.js';
import type { StreamComponent } from '../src/client/stream.js';

/**
 * The stream component as plain data (ADR-0006's precedent for the board
 * adapter): regions are objects with an `innerHTML`, so driving it needs no
 * browser. What is pinned here is the swap rule — the one thing that decides
 * whether a player keeps their half-composed move.
 */

/**
 * A page region, standing in for the element the component would find. Only
 * `innerHTML` is touched, so the cast is honest — the same shortcut
 * `board-adapter.test.ts` takes for its cells.
 */
function region(html = ''): { innerHTML: string } {
  return { innerHTML: html };
}

function stream(regions: Record<string, { innerHTML: string }>): StreamComponent {
  const component = streamComponent({ url: '/games/1/stream' });
  component.regions = regions as unknown as Record<string, HTMLElement>;
  return component;
}

function frame(regions: Record<string, string>): string {
  return JSON.stringify({ regions });
}

describe('swapping regions', () => {
  it('replaces a region whose HTML changed', () => {
    const board = region('<p>old</p>');
    stream({ board }).apply(frame({ board: '<p>new</p>' }));

    expect(board.innerHTML).toBe('<p>new</p>');
  });

  it('leaves a region whose HTML is unchanged untouched', () => {
    // The frame a stream sends on connect is normally exactly what the server
    // just rendered. Rewriting the board then would tear down the cells the
    // player is mid-composition on, for no change at all.
    let writes = 0;
    const board = {
      get innerHTML(): string {
        return '<p>same</p>';
      },
      set innerHTML(_html: string) {
        writes += 1;
      },
    };

    stream({ board }).apply(frame({ board: '<p>same</p>' }));

    expect(writes).toBe(0);
  });

  it('applies every region in the frame together, so the page is never half-updated', () => {
    const status = region('a');
    const board = region('b');
    const moves = region('c');

    stream({ status, board, moves }).apply(frame({ status: 'A', board: 'B', moves: 'C' }));

    expect([status.innerHTML, board.innerHTML, moves.innerHTML]).toEqual(['A', 'B', 'C']);
  });

  it('ignores a region the page does not have', () => {
    const status = region('a');

    expect(() => stream({ status }).apply(frame({ status: 'A', absent: 'x' }))).not.toThrow();
    expect(status.innerHTML).toBe('A');
  });

  it('ignores a frame that carries no regions', () => {
    const status = region('a');

    stream({ status }).apply(JSON.stringify({}));

    expect(status.innerHTML).toBe('a');
  });

  it('keeps the page as it is when a frame does not parse', () => {
    const status = region('a');

    expect(() => stream({ status }).apply('not json')).not.toThrow();
    expect(status.innerHTML).toBe('a');
  });
});

describe('the connection', () => {
  it('reads as live until something goes wrong, then again once it reopens', () => {
    const component = stream({});
    expect(component.live).toBe(true);

    component.dropped();
    expect(component.live).toBe(false);

    component.opened();
    expect(component.live).toBe(true);
  });

  it('stops listening when the game is gone, rather than reconnecting into a refusal', () => {
    const component = stream({});
    let closed = false;
    component.source = { close: () => (closed = true) } as unknown as EventSource;

    component.gone();

    expect(closed).toBe(true);
  });

  it('stops listening when the component is torn down', () => {
    const component = stream({});
    let closed = false;
    component.source = { close: () => (closed = true) } as unknown as EventSource;

    component.destroy();

    expect(closed).toBe(true);
  });
});
