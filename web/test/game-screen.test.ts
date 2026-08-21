import { describe, it, expect } from 'vitest';
import {
  gameRegions,
  renderExportPage,
  renderGamePage,
  renderNotFoundPage,
} from '../src/game-screen.js';
import type { SessionUser } from '../src/auth.js';
import type { BoardSquareView, GameView, MoveView, StoneView } from '../src/game-views.js';

/**
 * The game screen on its own. Every render function here is
 * `GameView -> string`, so a hand-built view is the whole fixture: no database,
 * no migration, no sign-in, no proposed game. What a rule *is* — whose turn it
 * is, whether the viewer may resign, which seat's stone the opening places —
 * belongs to `game-views.test.ts`; what the screen *shows* given that rule
 * belongs here. `games-http.test.ts` keeps only the end-to-end cover: that the
 * route serves this page at all.
 */

const aoife: SessionUser = {
  id: 1,
  username: 'aoife',
  displayName: 'Aoife Nolan',
  role: 'player',
  forcePasswordChange: false,
  blocked: false,
};

const takashi = { id: 2, displayName: 'Takashi Mori' };
const aoifeRef = { id: 1, displayName: 'Aoife Nolan' };

/** An empty board of `size`, rows top-down and files left-to-right, as `GameView.board` holds it. */
function emptyBoard(size: 5 | 6): readonly (readonly BoardSquareView[])[] {
  const files = ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, size);
  return Array.from({ length: size }, (_, i) =>
    files.map((file) => ({ file, rank: size - i, stack: [] as readonly StoneView[] })),
  );
}

/** Put a stack on one square of an otherwise empty board. */
function withStack(
  board: readonly (readonly BoardSquareView[])[],
  square: string,
  stack: readonly StoneView[],
): readonly (readonly BoardSquareView[])[] {
  return board.map((row) =>
    row.map((cell) => (`${cell.file}${cell.rank}` === square ? { ...cell, stack } : cell)),
  );
}

function move(number: number, notation: string, overrides: Partial<MoveView> = {}): MoveView {
  return {
    number,
    seat: number % 2 === 1 ? 1 : 2,
    player: number % 2 === 1 ? aoifeRef : takashi,
    notation,
    imported: false,
    tps: 'x5/x5/x5/x5/x5 1 1',
    ...overrides,
  };
}

/** A game in play, viewed by its proposer on their turn — the common case each test narrows. */
function view(overrides: Partial<GameView> = {}): GameView {
  return {
    id: 7,
    boardSize: 5,
    state: 'in_play',
    joinType: 'open',
    proposer: aoifeRef,
    opponent: takashi,
    imported: false,
    viewerSeat: 1,
    selfPlay: false,
    moves: [],
    board: emptyBoard(5),
    toMove: aoifeRef,
    toMoveSeat: 1,
    proposerSeat: 1,
    canMove: true,
    pending: null,
    canRespond: false,
    canResign: true,
    canOfferDraw: true,
    canOfferTakeBack: false,
    resultText: null,
    reserves: { 1: { stones: 21, capstones: 1 }, 2: { stones: 21, capstones: 1 } },
    isOpeningTurn: false,
    stoneSeat: 1,
    viewerShared: false,
    canHide: true,
    canAdminDelete: false,
    adminRemoved: false,
    ...overrides,
  };
}

describe('the board', () => {
  it('draws one cell per square, with files across the top and ranks down the side', () => {
    const html = gameRegions(view()).board;

    expect(html).toContain('data-square="a1"');
    expect(html).toContain('data-square="e5"');
    expect(html).not.toContain('data-square="f1"');
    expect(html).toContain('<span class="axis">a</span>');
    expect(html).toContain('<span class="axis">e</span>');
    expect(html).toContain('<span class="axis">5</span>');
    expect(html).toContain('grid-template-columns: auto repeat(5, 2.75rem)');
  });

  it('draws a 6×6 board from the same view, one file and rank wider', () => {
    const html = gameRegions(view({ boardSize: 6, board: emptyBoard(6) })).board;

    expect(html).toContain('data-square="f6"');
    expect(html).toContain('<span class="axis">f</span>');
    expect(html).toContain('grid-template-columns: auto repeat(6, 2.75rem)');
  });

  it('carries a stack bottom-to-top, with its height and top stone, for the builder to read', () => {
    const stack: StoneView[] = [
      { player: 1, kind: 'flat' },
      { player: 2, kind: 'flat' },
      { player: 2, kind: 'capstone' },
    ];

    const html = gameRegions(view({ board: withStack(emptyBoard(5), 'c3', stack) })).board;

    // `data-stack` is bottom-to-top so the adapter can read the top `lift`
    // glyphs off the end as the hand a stack move carries.
    expect(html).toContain('data-stack="●○□"');
    expect(html).toContain('data-height="3"');
    expect(html).toContain('data-top="2|capstone"');
    expect(html).toContain('<span class="cell-height">3</span>');
  });

  it('leaves an empty square empty: no height badge, no stack tip', () => {
    const html = gameRegions(view()).board;

    expect(html).toContain('data-height="0"');
    expect(html).toContain('data-top=""');
    expect(html).not.toContain('cell-height');
    expect(html).not.toContain('stack-tip');
  });

  it('shows on each square what the move being built would drop there', () => {
    const html = gameRegions(view()).board;

    expect(html).toContain(`x-text="dropsOn('a1')"`);
    expect(html).toContain(`x-show="dropsOn('a1') > 0"`);
    expect(html).toContain(`'is-path': dropsOn('a1') > 0`);
    expect(html).toContain(`'is-source': isSource('a1')`);
  });

  it('states what the viewer may do with the board inside the region, so a stream swap refreshes it', () => {
    const mine = gameRegions(view({ canMove: true, viewerSeat: 1, selfPlay: false })).board;
    const theirs = gameRegions(view({ canMove: false, viewerSeat: null, selfPlay: false })).board;

    expect(mine).toContain('data-can-move="1"');
    expect(mine).toContain('data-viewer-seat="1"');
    expect(mine).toContain('data-self-play="0"');
    expect(theirs).toContain('data-can-move="0"');
    expect(theirs).toContain('data-viewer-seat=""');
  });
});

describe('the status line', () => {
  it('names your colour and your turn', () => {
    const html = gameRegions(view()).status;

    expect(html).toContain('You play ● (filled)');
    expect(html).toContain('Your turn.');
  });

  it('says whose stone an opening turn places, because it is the opponent’s', () => {
    const html = gameRegions(view({ isOpeningTurn: true, stoneSeat: 2 })).status;

    expect(html).toContain("your opening move places your opponent's stone (open).");
  });

  it('names the other player when the turn is not yours', () => {
    const html = gameRegions(view({ canMove: false, toMove: takashi, toMoveSeat: 2, viewerSeat: 1 })).status;

    expect(html).toContain('Takashi Mori to move.');
    expect(html).not.toContain('Your turn');
  });

  it('reads a proposal as waiting, naming who will start', () => {
    const proposed = view({ state: 'proposed', opponent: null, toMove: null, toMoveSeat: null, canMove: false });

    expect(gameRegions(proposed).status).toContain('Aoife Nolan will start.');
    expect(gameRegions({ ...proposed, proposerSeat: 2 }).status).toContain('The joiner will start.');
    expect(gameRegions({ ...proposed, proposerSeat: null }).status).toContain('A coin flip will decide who starts.');
  });

  it('reports the result once the game is finished', () => {
    const html = gameRegions(view({ state: 'finished', resultText: 'Aoife Nolan won by road', canMove: false })).status;

    expect(html).toContain('Aoife Nolan won by road.');
  });

  it('speaks in colours, not names, for a self-play game', () => {
    const html = gameRegions(view({ selfPlay: true, opponent: aoifeRef, toMoveSeat: 2 })).status;

    expect(html).toContain('You play both colours.');
    expect(html).toContain('Open to move.');
  });

  it('says an admin removed the game, and nothing else', () => {
    const html = gameRegions(view({ adminRemoved: true, state: 'finished' })).status;

    expect(html).toBe('<p class="notice">This game was removed by an admin.</p>');
  });

  it('escapes a display name rather than letting it into the markup', () => {
    const html = gameRegions(
      view({ canMove: false, toMove: { id: 2, displayName: '<script>x</script>' } }),
    ).status;

    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('the move controls', () => {
  it('offers the move form with a stone picker in the colour about to be placed', () => {
    const html = gameRegions(view()).controls;

    expect(html).toContain('action="/games/7/move"');
    expect(html).toContain('aria-label="Place a flat stone"');
    expect(html).toContain(`x-on:click="pick('flat')"`);
    // Seat 1 places filled stones.
    expect(html).toContain('stone-glyph">●</span>');
    expect(html).not.toContain('<select');
  });

  it('shows the opponent’s open glyphs on an opening turn, because that is the stone placed', () => {
    const html = gameRegions(view({ isOpeningTurn: true, stoneSeat: 2 })).controls;

    expect(html).toContain('stone-glyph">○</span>');
    expect(html).toContain('stone-glyph">△</span>');
    expect(html).toContain('stone-glyph">□</span>');
  });

  it('offers the stack-move builder: a lift stepper and one drop adjuster per path square', () => {
    const html = gameRegions(view()).controls;

    expect(html).toContain('Stones to lift');
    expect(html).toContain('x-on:click="bumpLift(-1)"');
    expect(html).toContain('x-on:click="bumpLift(1)"');
    // The stepper's bounds are the builder's, so the buttons cannot compose a bad lift.
    expect(html).toContain(':disabled="lift <= liftFloor"');
    expect(html).toContain(':disabled="lift >= liftCeiling"');
    expect(html).toContain('x-on:click="cancel()"');
    expect(html).toContain('Stones dropped');
    expect(html).toContain('x-for="(step, i) in path"');
    expect(html).toContain('x-on:click="shiftDrop(i, -1)"');
    expect(html).toContain('x-on:click="shiftDrop(i, 1)"');
    // A shift that would do nothing is disabled rather than silently refused.
    expect(html).toContain(':disabled="!canShiftDrop(i, -1)"');
    expect(html).toContain(':disabled="!canShiftDrop(i, 1)"');
  });

  it('gives a spectator no move form at all', () => {
    const html = gameRegions(view({ canMove: false, viewerSeat: null, canResign: false, canOfferDraw: false })).controls;

    expect(html).not.toContain('Stones to lift');
    expect(html).not.toContain('action="/games/7/move"');
    // The bundle names these methods, so assert on the markup that calls them.
    expect(html).not.toContain('x-on:click="shiftDrop(i, -1)"');
    expect(html).not.toContain('x-on:click="bumpLift(1)"');
  });

  it('offers resign, draw and take-back only as the view allows each', () => {
    const all = gameRegions(view({ canOfferTakeBack: true })).controls;
    const none = gameRegions(view({ canResign: false, canOfferDraw: false, canOfferTakeBack: false })).controls;

    expect(all).toContain('action="/games/7/resign"');
    expect(all).toContain('action="/games/7/draw"');
    expect(all).toContain('action="/games/7/take-back"');
    expect(none).not.toContain('/resign');
    expect(none).not.toContain('/take-back');
  });

  it('puts accept and reject in front of the respondent to a pending offer, and no move form', () => {
    const html = gameRegions(
      view({ pending: { kind: 'draw', requester: takashi }, canRespond: true, canMove: false }),
    ).controls;

    expect(html).toContain('Takashi Mori offers a draw.');
    expect(html).toContain('action="/games/7/draw/accept"');
    expect(html).toContain('action="/games/7/draw/reject"');
    expect(html).not.toContain('action="/games/7/move"');
  });

  it('tells the requester they are waiting, with nothing to click', () => {
    const html = gameRegions(
      view({ pending: { kind: 'take-back', requester: aoifeRef }, canRespond: false, canMove: false }),
    ).controls;

    expect(html).toContain('Take-back requested — waiting for a response.');
    expect(html).not.toContain('/accept');
  });

  it('leaves a finished game the review bar and nothing else', () => {
    const html = gameRegions(view({ state: 'finished', canMove: false, canResign: false, canOfferDraw: false })).controls;

    expect(html).toContain('review-bar');
    expect(html).not.toContain('action="/games/7/move"');
    expect(html).not.toContain('/resign');
  });
});

describe('the review bar', () => {
  it('counts the moves it is scrubbing through, and hides until the client says otherwise', () => {
    const html = gameRegions(view({ moves: [move(1, 'a1'), move(2, 'e5'), move(3, 'b1')] })).controls;

    expect(html).toContain('<div class="review-bar panel" x-show="reviewing" x-cloak>');
    expect(html).toContain('of 3.');
    expect(html).toContain('data-total-moves="3"');
    expect(html).toContain('x-on:click="snapToEnd()"');
    expect(html).toContain('Snap to end');
  });

  it('says the game is waiting on a scrubbed player, so review cannot hide their turn', () => {
    const waiting = gameRegions(view({ canMove: true })).controls;
    const notWaiting = gameRegions(view({ canMove: false })).controls;

    expect(waiting).toContain('they’re waiting on you.');
    expect(notWaiting).not.toContain('waiting on you');
  });
});

describe('the move history', () => {
  it('pairs the two halves of a full move under one number, PTN style', () => {
    const html = gameRegions(view({ moves: [move(1, 'a1'), move(2, 'e5'), move(3, 'b1')] })).moves;

    expect(html).toContain('<span class="mono">1.</span>');
    expect(html).toContain('<span class="mono">2.</span>');
    expect(html).not.toContain('<span class="mono">3.</span>');
  });

  it('carries each move’s own TPS and number, so a click can scrub to it', () => {
    const html = gameRegions(
      view({ moves: [move(1, 'a1', { tps: 'x5/x5/x5/x5/2,x4 2 1' })] }),
    ).moves;

    expect(html).toContain('data-move-number="1"');
    expect(html).toContain('data-tps="x5/x5/x5/x5/2,x4 2 1"');
    expect(html).toContain('data-total="1"');
    expect(html).toContain('x-on:click="scrubTo($el)"');
  });

  it('offers PTN and TPS links for the whole game and from each move', () => {
    const html = gameRegions(view({ moves: [move(1, 'a1')] })).moves;

    expect(html).toContain('href="/games/7/export?format=ptn"');
    expect(html).toContain('href="/games/7/export?format=ptn&amp;through=1"');
    expect(html).toContain('href="/games/7/export?format=tps&amp;through=1"');
    // Every export is trailed, so crawlers must not walk two links per move.
    expect(html).toContain('rel="nofollow"');
  });

  it('still offers the whole-game record when no move has been played', () => {
    const html = gameRegions(view()).moves;

    expect(html).toContain('No moves yet.');
    expect(html).toContain('href="/games/7/export?format=ptn"');
  });

  it('marks a history that carries imported moves as fixed', () => {
    const imported = gameRegions(view({ moves: [move(1, 'a1', { imported: true })] })).moves;
    const played = gameRegions(view({ moves: [move(1, 'a1')] })).moves;

    expect(imported).toContain('Imported moves are fixed history.');
    expect(played).not.toContain('fixed history');
  });
});

describe('the reserves', () => {
  it('counts each seat’s stones and capstones, marking the viewer’s row', () => {
    const html = gameRegions(view({ reserves: { 1: { stones: 18, capstones: 1 }, 2: { stones: 20, capstones: 0 } } })).reserves;

    expect(html).toContain('<h2>Stones left</h2>');
    expect(html).toContain('Aoife Nolan (you)');
    expect(html).toContain('Takashi Mori');
    expect(html).not.toContain('Takashi Mori (you)');
    expect(html).toContain('>18<');
    expect(html).toContain('>0<');
  });

  it('marks both rows as yours in self-play', () => {
    const html = gameRegions(view({ selfPlay: true, opponent: aoifeRef })).reserves;

    expect(html.match(/\(you\)/g)).toHaveLength(2);
  });

  it('shows nothing at all for a proposal, which has no position yet', () => {
    expect(gameRegions(view({ state: 'proposed', opponent: null })).reserves).toBe('');
  });
});

describe('the whole game page', () => {
  it('nests every region inside the one stream wrapper (ADR-0007)', () => {
    const html = renderGamePage(aoife, view({ moves: [move(1, 'a1')] }));

    const wrapper = html.indexOf('x-data="takStream(');
    expect(wrapper).toBeGreaterThan(-1);
    for (const name of ['status', 'board', 'controls', 'reserves', 'moves']) {
      expect(html.indexOf(`data-region="${name}"`)).toBeGreaterThan(wrapper);
    }
  });

  it('renders each region’s HTML exactly as the stream would push it', () => {
    const game = view({ moves: [move(1, 'a1')] });
    const html = renderGamePage(aoife, game);

    for (const [name, markup] of Object.entries(gameRegions(game))) {
      expect(html).toContain(`<div data-region="${name}">${markup}</div>`);
    }
  });

  it('keeps the board scope inside the stream wrapper but outside every region', () => {
    const html = renderGamePage(aoife, view());

    const stream = html.indexOf('x-data="takStream(');
    const board = html.indexOf('x-data="takBoard(');
    expect(board).toBeGreaterThan(stream);
    expect(board).toBeLessThan(html.indexOf('data-region="board"'));
  });

  it('leaves visibility controls outside the regions: only the viewer changes them', () => {
    const html = renderGamePage(aoife, view({ viewerShared: true, canHide: true }));

    expect(html).toContain('action="/games/7/share"');
    expect(html).toContain('Stop sharing');
    expect(html).toContain('Hide from my games');
    expect(html).not.toContain('data-region="visibility"');
  });

  it('offers an admin removal only to an admin who can still remove', () => {
    expect(renderGamePage(aoife, view({ canAdminDelete: true }))).toContain('action="/games/7/admin-delete"');
    expect(renderGamePage(aoife, view({ canAdminDelete: false }))).not.toContain('admin-delete');
  });

  it('ships the client bundle, the shortcuts panel and the legend', () => {
    const html = renderGamePage(aoife, view());

    expect(html).toContain('src="/client.js"');
    expect(html).toContain('class="shortcuts-help panel"');
    expect(html).toContain('x-show="helpVisible"');
    expect(html).toContain('x-on:keydown.window="handleKey($event)"');
    expect(html).toContain('x-on:click="toggleHelp()"');
    expect(html).toContain('Press <kbd>?</kbd> for keyboard shortcuts.');
    expect(html).toContain('■ capstone');
    expect(html).toContain('Move syntax');
  });

  it('shows a refusal above the board without disturbing the regions', () => {
    const html = renderGamePage(aoife, view(), { error: 'Not your turn' });

    expect(html).toContain('<p class="error">Not your turn</p>');
    expect(html).toContain('data-region="board"');
  });
});

describe('the export page', () => {
  it('shows the record with a copy button and a link to the other format', () => {
    const html = renderExportPage(aoife, 7, {
      type: 'export',
      format: 'ptn',
      text: '[Size "5"]\n1. a1 e5',
      throughMove: 2,
      totalMoves: 2,
    });

    expect(html).toContain('<h1>PTN</h1>');
    expect(html).toContain('[Size &quot;5&quot;]');
    expect(html).toContain('href="/games/7/export?format=tps"');
    expect(html).toContain('The full game as Portable Tak Notation');
  });

  it('says which move a partial export runs through, and carries it to the other format', () => {
    const html = renderExportPage(aoife, 7, {
      type: 'export',
      format: 'tps',
      text: 'x5/x5/x5/x5/2,x4 2 1',
      throughMove: 1,
      totalMoves: 4,
    });

    expect(html).toContain('The position after move 1 of 4');
    expect(html).toContain('href="/games/7/export?format=ptn&amp;through=1"');
  });
});

describe('the not-found page', () => {
  it('explains both reasons a game may be missing, and offers the way back', () => {
    const html = renderNotFoundPage();

    expect(html).toContain('it may have been deleted, or it is not shared with you');
    expect(html).toContain('href="/games"');
  });
});
