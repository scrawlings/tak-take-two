import { describe, it, expect } from 'vitest';
import {
  findGamesRegions,
  myGamesRegions,
  renderFindGamesPage,
  renderMyGamesPage,
} from '../src/game-lists.js';
import type { SessionUser } from '../src/auth.js';
import type { GameSummary } from '../src/game-views.js';

/**
 * The two players' games lists on their own: `GameSummary -> string`, with no
 * database behind it. Whether a viewer *may* join, delete or hide is decided in
 * `game-views.ts` and tested there; this file says what a row looks like once
 * that is decided, and what the surrounding search form carries.
 */

const aoife: SessionUser = {
  id: 1,
  username: 'aoife',
  displayName: 'Aoife Nolan',
  role: 'player',
  forcePasswordChange: false,
  blocked: false,
};

const aoifeRef = { id: 1, displayName: 'Aoife Nolan' };
const takashi = { id: 2, displayName: 'Takashi Mori' };

/** An open proposal by someone else, which the viewer can join — each test narrows it. */
function summary(overrides: Partial<GameSummary> = {}): GameSummary {
  return {
    id: 7,
    boardSize: 5,
    state: 'proposed',
    joinType: 'open',
    proposer: takashi,
    opponent: null,
    invitedPlayer: null,
    otherPlayer: null,
    imported: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    canDelete: false,
    canJoin: true,
    canSolo: false,
    toMove: null,
    result: null,
    proposerSeat: 1,
    adminRemoved: false,
    lastActivity: '2026-01-01T00:00:00.000Z',
    followed: false,
    canFollow: true,
    canHide: false,
    ...overrides,
  };
}

const rows = (games: readonly GameSummary[]): string => myGamesRegions(aoife, games).games;
const found = (games: readonly GameSummary[]): string => findGamesRegions(aoife, games).games;

describe('a row on "Your games"', () => {
  it('tags each lifecycle state, and carries a finished game’s result', () => {
    expect(rows([summary()])).toContain('proposed · open');
    expect(rows([summary({ joinType: 'invited' })])).toContain('proposed · invited');
    expect(rows([summary({ state: 'in_play' })])).toContain('>in play<');
    expect(rows([summary({ state: 'finished', result: 'R-0' })])).toContain('finished · R-0');
    expect(rows([summary({ adminRemoved: true })])).toContain('removed by an admin');
  });

  it('names the opponent, or who the proposal is still waiting on', () => {
    expect(rows([summary({ otherPlayer: takashi })])).toContain('Takashi Mori');
    expect(rows([summary({ invitedPlayer: takashi })])).toContain('waiting for Takashi Mori');
    expect(rows([summary()])).toContain('waiting for anyone');
  });

  it('says whether the viewer starts, but only while the game is still a proposal', () => {
    // The viewer proposed and holds seat 1, which moves first.
    expect(rows([summary({ proposer: aoifeRef, proposerSeat: 1 })])).toContain('you start');
    expect(rows([summary({ proposer: aoifeRef, proposerSeat: 2 })])).toContain('you go second');
    expect(rows([summary({ proposerSeat: null })])).toContain('random start');
    expect(rows([summary({ state: 'in_play' })])).not.toContain('you start');
  });

  it('distinguishes an imported game from one begun on an empty board', () => {
    expect(rows([summary({ imported: true })])).toContain('>imported<');
    expect(rows([summary()])).toContain('empty board');
  });

  it('offers exactly the actions the summary allows, and no others', () => {
    const html = rows([summary({ canJoin: true, canDelete: true, canHide: true })]);

    expect(html).toContain('action="/games/7/join"');
    expect(html).toContain('action="/games/7/delete"');
    expect(html).toContain('action="/games/7/hide"');

    const bare = rows([summary({ canJoin: false, canDelete: false, canHide: false })]);
    expect(bare).not.toContain('/join');
    expect(bare).not.toContain('/delete');
    expect(bare).not.toContain('/hide');
  });

  it('calls claiming your own proposal “Solo”, because that is a self-play game', () => {
    const solo = rows([summary({ proposer: aoifeRef, canJoin: true, canSolo: true })]);

    expect(solo).toContain('>Solo</button>');
    expect(solo).toContain('play both seats yourself');
    expect(rows([summary()])).toContain('>Join</button>');
  });

  it('opens a finished game as readily as one in play, since both stay reviewable', () => {
    expect(rows([summary({ state: 'finished' })])).toContain('href="/games/7">Open</a>');
    expect(rows([summary({ state: 'in_play' })])).toContain('href="/games/7">Open</a>');
    expect(rows([summary()])).not.toContain('>Open</a>');
  });

  it('carries the current filters back with every action, so a refusal lands where the click was', () => {
    const html = myGamesRegions(aoife, [summary({ canDelete: true })], {
      status: 'proposed',
      sort: 'size',
      direction: 'asc',
      showRemoved: false,
    }).games;

    expect(html).toContain('name="return_to" value="/games?status=proposed&amp;sort=size&amp;direction=asc"');
  });

  it('explains an empty list differently when a status filter could be the reason', () => {
    expect(rows([])).toContain('No games yet. Propose one below');
    const filtered = myGamesRegions(aoife, [], {
      status: 'finished',
      sort: 'activity',
      direction: 'desc',
      showRemoved: false,
    }).games;
    expect(filtered).toContain('No games match that status.');
  });
});

describe('a row on "Find a game"', () => {
  it('says what kind of proposal it is, from the viewer’s side', () => {
    expect(found([summary()])).toContain('open to anyone');
    expect(found([summary({ joinType: 'invited' })])).toContain('invited to you');
  });

  it('offers follow or unfollow, and neither on your own proposal', () => {
    expect(found([summary({ followed: false })])).toContain('action="/games/find/follow"');
    expect(found([summary({ followed: true })])).toContain('action="/games/find/unfollow"');
    expect(found([summary({ followed: true })])).toContain('>followed<');
    expect(found([summary({ canFollow: false })])).not.toContain('/games/find/follow');
  });

  it('never offers Hide here — hiding belongs to "your games"', () => {
    // `canHide` can be true for the viewer's own proposal, which appears on
    // find too (joinable by themselves for self-play).
    expect(found([summary({ proposer: aoifeRef, canHide: true })])).not.toContain('/games/7/hide');
    expect(rows([summary({ canHide: true })])).toContain('/games/7/hide');
  });

  it('carries the whole search back through a follow, so filters survive the redirect', () => {
    const html = findGamesRegions(aoife, [summary()], {
      boardSize: 6,
      joinType: 'open',
      proposerDisplayName: 'tak',
      curated: true,
    }).games;

    expect(html).toContain(
      'name="return_to" value="/games/find?board_size=6&amp;join_type=open&amp;proposer=tak&amp;curated=1"',
    );
  });

  it('explains an empty result by whichever narrowing could account for it', () => {
    const wide = { boardSize: null, joinType: null, proposerDisplayName: null, curated: false } as const;

    expect(found([])).toContain('Nobody is waiting for an opponent right now.');
    expect(findGamesRegions(aoife, [], { ...wide, boardSize: 6 }).games).toContain(
      'No proposals match those filters.',
    );
    expect(findGamesRegions(aoife, [], { ...wide, curated: true }).games).toContain(
      'Nobody you follow has proposed a game right now.',
    );
  });
});

describe('the "Your games" page', () => {
  it('streams only the table, leaving the propose form the player is typing into alone', () => {
    const html = renderMyGamesPage(aoife, [summary()]);

    const wrapper = html.indexOf('x-data="takStream(');
    const region = html.indexOf('data-region="games"');
    const propose = html.indexOf('action="/games"');
    expect(region).toBeGreaterThan(wrapper);
    expect(html.indexOf('<h2>Propose a game</h2>')).toBeGreaterThan(region);
    expect(propose).toBeGreaterThan(-1);
  });

  it('points the stream at the same status and sort the page was drawn with', () => {
    const html = renderMyGamesPage(aoife, [], {
      filters: { status: 'in_play', sort: 'size', direction: 'asc', showRemoved: false },
    });

    expect(html).toContain('/games/stream?status=in_play&amp;sort=size&amp;direction=asc');
    expect(html).toContain('<option value="in_play" selected>');
  });

  it('offers a Clear link only once the list is actually narrowed', () => {
    expect(renderMyGamesPage(aoife, [])).not.toContain('>Clear</a>');
    expect(
      renderMyGamesPage(aoife, [], {
        filters: { status: 'finished', sort: 'activity', direction: 'desc', showRemoved: false },
      }),
    ).toContain('href="/games">Clear</a>');
  });

  it('puts a rejected propose form back the way it was submitted, with the error above it', () => {
    const html = renderMyGamesPage(aoife, [], {
      error: 'That record does not replay',
      submitted: { boardSize: '6', joinType: 'invited', starter: 'them', ptn: '1. a1 e5' },
    });

    expect(html).toContain('<p class="error">That record does not replay</p>');
    expect(html).toContain('<option value="6" selected>6×6</option>');
    expect(html).toContain('<option value="invited" selected>');
    expect(html).toContain('1. a1 e5');
  });
});

describe('the "Find a game" page', () => {
  it('points the stream at the curated mode and filters the page was drawn with', () => {
    const html = renderFindGamesPage(aoife, [], {
      filters: { boardSize: 5, joinType: null, proposerDisplayName: null, curated: true },
    });

    expect(html).toContain('/games/find/stream?board_size=5&amp;curated=1');
    expect(html).toContain('name="curated" value="1" checked');
  });

  it('heads the results by whether a search narrowed them', () => {
    expect(renderFindGamesPage(aoife, [])).toContain('<h2>Waiting for an opponent</h2>');
    expect(
      renderFindGamesPage(aoife, [], {
        filters: { boardSize: null, joinType: 'open', proposerDisplayName: null, curated: false },
      }),
    ).toContain('<h2>Matching proposals</h2>');
  });

  it('keeps the search in the form when it comes back with an error', () => {
    const html = renderFindGamesPage(aoife, [], {
      error: 'You cannot follow yourself',
      filters: { boardSize: null, joinType: null, proposerDisplayName: 'takashi', curated: false },
    });

    expect(html).toContain('<p class="error">You cannot follow yourself</p>');
    expect(html).toContain('value="takashi"');
  });
});
