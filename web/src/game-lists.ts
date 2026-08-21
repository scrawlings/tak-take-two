import { escapeHtml, region, renderShell, streamed, type Regions } from './html.js';
import type { SessionUser } from './auth.js';
import type { GameSummary } from './games.js';
import { gamePath } from './paths.js';
import {
  FIND_GAMES_DEFAULT,
  FIND_GAMES_SCHEMA,
  MY_GAMES_DEFAULT,
  MY_GAMES_SCHEMA,
  isNarrowed,
  queryString,
  type FindGamesSearch,
  type MyGamesQuery,
} from './list-query.js';

/**
 * The two games lists a player works from: "Your games" and "Find a game".
 * They share this module because they share their rows — one status tag, one
 * opponent cell, one action group — and differ only in the surrounding search.
 * Each renders from `GameSummary` alone, so a row's markup is testable without
 * a database (`game-lists.test.ts`).
 */

export interface MyGamesView {
  error?: string;
  /** The filter/sort controls as resolved (`list-query.ts`), so the form and the list stream match. */
  filters?: MyGamesQuery;
  /** Values to put back in the propose form when it comes back with an error. */
  submitted?: {
    boardSize?: string | null;
    joinType?: string | null;
    invitedDisplayName?: string | null;
    starter?: string | null;
    ptn?: string | null;
  };
}

function gameStatusTag(game: GameSummary): string {
  if (game.adminRemoved) return '<span class="tag tag-flag">removed by an admin</span>';
  if (game.state === 'in_play') return '<span class="tag">in play</span>';
  // Ticket 03: `listMyGames` now returns finished games too (not only
  // admin-removed ones), so this needs its own branch, not just the two above.
  if (game.state === 'finished') {
    return `<span class="tag">finished${game.result === null ? '' : ` · ${escapeHtml(game.result)}`}</span>`;
  }
  const kind = game.joinType === 'open' ? 'open' : 'invited';
  return `<span class="tag">proposed · ${kind}</span>`;
}

/** Who the viewer is playing, or who the proposal is still waiting on. */
function opponentCell(game: GameSummary): string {
  if (game.otherPlayer !== null) return escapeHtml(game.otherPlayer.displayName);
  if (game.invitedPlayer !== null) {
    return `<span class="dim">waiting for ${escapeHtml(game.invitedPlayer.displayName)}</span>`;
  }
  return '<span class="dim">waiting for anyone</span>';
}

/**
 * Who starts a proposal, phrased for the viewer. Only proposals have a starter
 * that is not yet settled — once the game is in play the seat is fixed and the
 * game screen's colour line names it.
 */
function starterHint(game: GameSummary, user: SessionUser): string {
  if (game.state !== 'proposed') return '';
  if (game.proposerSeat === null) return ' · random start';
  const youStart = (game.proposerSeat === 1) === (game.proposer.id === user.id);
  return ` · ${youStart ? 'you start' : 'you go second'}`;
}

/** Which list a game action was taken from — a rendering-only choice (button visibility), never sent to the server: `returnTo` already tells the server where to land. */
type GameListPage = 'games' | 'find';

/** The actions a viewer may take on a game, as the module decided them. `extra` appends
 *  pre-rendered buttons that aren't game actions per se (the find page's follow button). */
function gameActions(game: GameSummary, list: GameListPage, returnTo: string, extra = ''): string {
  const hiddenReturnTo = `<input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">`;
  // Claiming your own proposal starts a self-play game, so the button says
  // what that means rather than a bare “join” (CONTEXT.md: Self-play).
  const join =
    game.canJoin
      ? `<form method="post" action="${gamePath(game.id, 'join')}">${hiddenReturnTo}<button type="submit" class="btn btn-sm"${
          game.canSolo ? ' title="Claim your own game and play both seats yourself."' : ''
        }>${game.canSolo ? 'Solo' : 'Join'}</button></form>`
      : '';
  const buttons = [
    join,
    game.canDelete
      ? `<form method="post" action="${gamePath(game.id, 'delete')}">${hiddenReturnTo}<button type="submit" class="btn btn-danger btn-sm">Delete</button></form>`
      : '',
    // A finished game still opens: the board and history stay reviewable
    // (ticket 01's review mode covers finished games), and this was the row's
    // only way in — the previous `in_play`-only condition left a filtered-in
    // finished game with no actions at all.
    game.state === 'in_play' || game.state === 'finished'
      ? `<a class="btn btn-sm" href="${gamePath(game.id)}">Open</a>`
      : '',
    // Ticket 05: hide from the row, without opening the game. Restricted to
    // `games` deliberately, not just by `canHide` happening to be false on
    // find: the viewer's own open proposal can appear there too (joinable by
    // themselves for self-play), and `canHide` is already true for it then —
    // hide belongs to "your games", not to a page for finding one to join.
    list === 'games' && game.canHide
      ? `<form method="post" action="${gamePath(game.id, 'hide')}">${hiddenReturnTo}<button type="submit" class="btn btn-quiet btn-sm">Hide</button></form>`
      : '',
    extra,
  ].filter(Boolean);
  return `<div class="row-actions">${buttons.join('')}</div>`;
}

/** The player's own games as the list draws them — the one streamed region. */
export function myGamesRegions(
  user: SessionUser,
  games: readonly GameSummary[],
  filters: MyGamesQuery = MY_GAMES_DEFAULT,
): Regions<'games'> {
  return { games: myGamesTable(user, games, filters) };
}

function myGamesTable(user: SessionUser, games: readonly GameSummary[], filters: MyGamesQuery = MY_GAMES_DEFAULT): string {
  const returnTo = `/games${queryString(MY_GAMES_SCHEMA, filters)}`;
  const rows = games
    .map(
      (game) => `<tr>
  <td class="num">${game.boardSize}×${game.boardSize}</td>
  <td>${gameStatusTag(game)}${starterHint(game, user)}</td>
  <td>${opponentCell(game)}</td>
  <td>${game.toMove === null ? '<span class="dim">—</span>' : escapeHtml(game.toMove.displayName)}</td>
  <td>${game.imported ? '<span class="tag">imported</span>' : '<span class="dim">empty board</span>'}</td>
  <td>${gameActions(game, 'games', returnTo)}</td>
</tr>`,
    )
    .join('');

  const table =
    games.length === 0
      ? `<p class="lede">${
          // Keyed on `status` specifically, not the broader narrowed-ness
          // (ticket 06 adds `showRemoved` to that): showing removed games only
          // ever adds rows, so it can't explain an empty list on its own — the
          // find page's `curated` follows the same one-message-per-toggle idiom.
          filters.status
            ? 'No games match that status.'
            : 'No games yet. Propose one below and it will appear here.'
        }</p>`
      : `<div class="table-scroll">
    <table class="data">
      <thead><tr><th>Board</th><th>State</th><th>Opponent</th><th>To move</th><th>Started from</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
  return table;
}

export function renderMyGamesPage(
  user: SessionUser,
  games: readonly GameSummary[],
  view: MyGamesView = {},
): string {
  const error = view.error ? `<p class="error">${escapeHtml(view.error)}</p>` : '';
  const submitted = view.submitted ?? {};
  const filters = view.filters ?? MY_GAMES_DEFAULT;
  const sizeSelected = (size: string): string => (submitted.boardSize === size ? ' selected' : '');
  const joinSelected = (kind: string): string => (submitted.joinType === kind ? ' selected' : '');
  const starterSelected = (value: string): string => (submitted.starter === value ? ' selected' : '');
  const returnTo = `/games${queryString(MY_GAMES_SCHEMA, filters)}`;

  // Only the table streams: the propose form below holds what the player has
  // typed, and a stream that replaced it would throw their draft away.
  const list = streamed(
    `/games/stream${queryString(MY_GAMES_SCHEMA, filters)}`,
    region('games', myGamesTable(user, games, filters)),
  );

  const statusOptions = MY_GAMES_SCHEMA.status.options
    .map((o) => `<option value="${o.value}"${selected(filters.status, o.value)}>${o.label}</option>`)
    .join('');
  const sortOptions = MY_GAMES_SCHEMA.sort.options
    .map((o) => `<option value="${o.value}"${selected(filters.sort, o.value)}>${o.label}</option>`)
    .join('');
  const directionOptions = MY_GAMES_SCHEMA.direction.options
    .map((o) => `<option value="${o.value}"${selected(filters.direction, o.value)}>${o.label}</option>`)
    .join('');

  const body = `
<h1>Your games</h1>
${error}
<div class="block">
  <h2>In progress</h2>
  <form class="panel" method="get" action="/games">
    <div class="field-grid">
      <div class="field">
        <label for="status">Status</label>
        <select id="status" name="status">
          <option value=""${selected(filters.status, null)}>any</option>
          ${statusOptions}
        </select>
      </div>
      <div class="field">
        <label for="sort">Sort by</label>
        <select id="sort" name="sort">
          ${sortOptions}
        </select>
      </div>
      <div class="field">
        <label for="direction">Order</label>
        <select id="direction" name="direction">
          ${directionOptions}
        </select>
      </div>
    </div>
    <div class="field">
      <label class="check"><input type="checkbox" id="show_removed" name="show_removed" value="1"${filters.showRemoved ? ' checked' : ''}> Show removed games</label>
    </div>
    <p class="actions">
      <button type="submit" class="btn">Apply</button>
      ${isNarrowed(MY_GAMES_SCHEMA, filters) ? '<a class="btn btn-quiet" href="/games">Clear</a>' : ''}
    </p>
  </form>
  ${list}
</div>
<div class="block">
  <h2>Propose a game</h2>
  <form class="panel" method="post" action="/games" x-data="{ join: '${submitted.joinType === 'invited' ? 'invited' : 'open'}', ptn: ${escapeHtml(JSON.stringify(submitted.ptn ?? ''))} }">
    <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
    <div class="field-grid">
      <!-- A pasted record carries its own [Size], and the module takes the size
           from the record. Disabling the select says so rather than letting a
           contradicting choice be silently discarded. -->
      <div class="field">
        <label for="board_size">Board</label>
        <select id="board_size" name="board_size" x-bind:disabled="ptn.trim() !== ''">
          <option value="5"${sizeSelected('5')}>5×5</option>
          <option value="6"${sizeSelected('6')}>6×6</option>
        </select>
        <p class="hint" x-show="ptn.trim() !== ''">Set by the record below.</p>
      </div>
      <div class="field">
        <label for="join_type">Who can join</label>
        <select id="join_type" name="join_type" x-model="join">
          <option value="open"${joinSelected('open')}>anyone</option>
          <option value="invited"${joinSelected('invited')}>one player I name</option>
        </select>
      </div>
      <div class="field">
        <label for="starter">Who starts</label>
        <select id="starter" name="starter">
          <option value="me"${starterSelected('me')}>I start (filled)</option>
          <option value="opponent"${starterSelected('opponent')}>The other player starts</option>
          <option value="random"${starterSelected('random')}>Random — decided when they join</option>
        </select>
        <p class="hint">Player 1 moves first. Importing a past record, choosing “the other player starts” lets you replay it from the other seat.</p>
      </div>
    </div>
    <!-- Only an invited game needs a name. Without Alpine the field simply
         stays visible, so the form still works with scripting off. -->
    <div class="field" x-show="join === 'invited'">
      <label for="invited_display_name">Player to invite</label>
      <input id="invited_display_name" name="invited_display_name" autocomplete="off" value="${escapeHtml(submitted.invitedDisplayName ?? '')}">
      <p class="hint">Their display name, as other players see it.</p>
    </div>
    <div class="field">
      <label for="ptn">Start from a record (optional)</label>
      <textarea id="ptn" name="ptn" rows="6" spellcheck="false" x-model="ptn" placeholder='[Size "5"]&#10;1. a1 e5&#10;2. c3 c4'>${escapeHtml(submitted.ptn ?? '')}</textarea>
    </div>
    <p class="actions"><button type="submit" class="btn">Propose game</button></p>
    <p class="hint">Paste Portable Tak Notation to carry a game in from elsewhere. Its moves are replayed and fixed, and the record sets the board size.</p>
  </form>
</div>`;
  return renderShell('Your games', body, { user, path: '/games', scripts: 'client' });
}

/**
 * Who a proposal is for. The find page lists only proposals the viewer can
 * join, so an invited one here is always addressed to them.
 */
function proposalKind(game: GameSummary): string {
  return game.joinType === 'open'
    ? '<span class="tag">open to anyone</span>'
    : '<span class="tag">invited to you</span>';
}

export interface FindGamesView {
  error?: string;
  /** The search as resolved (`list-query.ts`), so the form comes back the way it was left. */
  filters?: FindGamesSearch;
}

/**
 * The matching proposals as the search draws them — the one streamed region.
 * The filters are the caller's, so the stream route runs the same search and
 * this renders the same answer.
 */
export function findGamesRegions(
  user: SessionUser,
  games: readonly GameSummary[],
  filters: FindGamesSearch = FIND_GAMES_DEFAULT,
): Regions<'games'> {
  return { games: findGamesResults(user, games, filters) };
}

/**
 * The follow/unfollow button on a find-page row (ticket 04; CONTEXT.md:
 * Follow). Absent for the viewer's own proposal (`canFollow` is false). The
 * hidden `return_to` carries the current search back to the redirect, so
 * following someone never drops the filters or the curated toggle the player
 * had set.
 */
function followButton(game: GameSummary, returnTo: string): string {
  if (!game.canFollow) return '';
  const action = game.followed ? '/games/find/unfollow' : '/games/find/follow';
  const label = game.followed ? 'Unfollow' : 'Follow';
  return `<form method="post" action="${action}">
  <input type="hidden" name="user_id" value="${game.proposer.id}">
  <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
  <button type="submit" class="btn btn-quiet btn-sm">${label}</button>
</form>`;
}

function findGamesResults(
  user: SessionUser,
  games: readonly GameSummary[],
  filters: FindGamesSearch,
): string {
  const filtered = isNarrowed(FIND_GAMES_SCHEMA, filters);
  const returnTo = `/games/find${queryString(FIND_GAMES_SCHEMA, filters)}`;
  const rows = games
    .map(
      (game) => `<tr>
  <td class="num">${game.boardSize}×${game.boardSize}</td>
  <td>${proposalKind(game)}${starterHint(game, user)}</td>
  <td>${escapeHtml(game.proposer.displayName)}${game.followed ? ' <span class="tag">followed</span>' : ''}</td>
  <td>${game.imported ? '<span class="tag">imported</span>' : '<span class="dim">empty board</span>'}</td>
  <td>${gameActions(game, 'find', returnTo, followButton(game, returnTo))}</td>
</tr>`,
    )
    .join('');

  const results =
    games.length === 0
      ? `<p class="lede">${
          filters.curated
            ? 'Nobody you follow has proposed a game right now.'
            : filtered
              ? 'No proposals match those filters. Try widening them.'
              : 'Nobody is waiting for an opponent right now. Propose a game and someone can join it.'
        }</p>`
      : `<div class="table-scroll">
    <table class="data">
      <thead><tr><th>Board</th><th>Kind</th><th>Proposed by</th><th>Started from</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
  return results;
}

/** Whether `option` is the one a `<select>`'s current value names — shared by every filter/sort form. `null` marks the "any" option. */
function selected<V extends string | number>(value: V | null, option: V | null): string {
  return value === option ? ' selected' : '';
}

export function renderFindGamesPage(
  user: SessionUser,
  games: readonly GameSummary[],
  view: FindGamesView = {},
): string {
  const error = view.error ? `<p class="error">${escapeHtml(view.error)}</p>` : '';
  const filters = view.filters ?? FIND_GAMES_DEFAULT;
  const filtered = isNarrowed(FIND_GAMES_SCHEMA, filters);

  // Only the results stream: the filter form above holds what the player typed.
  const results = streamed(
    `/games/find/stream${queryString(FIND_GAMES_SCHEMA, filters)}`,
    region('games', findGamesResults(user, games, filters)),
  );

  const boardSizeOptions = FIND_GAMES_SCHEMA.boardSize.options
    .map((o) => `<option value="${o.value}"${selected(filters.boardSize, o.value)}>${o.label}</option>`)
    .join('');
  const joinTypeOptions = FIND_GAMES_SCHEMA.joinType.options
    .map((o) => `<option value="${o.value}"${selected(filters.joinType, o.value)}>${o.label}</option>`)
    .join('');

  const body = `
<h1>Find a game</h1>
<p class="lede">Games you can take up: every open proposal, plus any invitation addressed to you. Invitations to other players stay private.</p>
${error}
<form class="panel" method="get" action="/games/find">
  <div class="field-grid">
    <div class="field">
      <label for="board_size">Board</label>
      <select id="board_size" name="board_size">
        <option value=""${selected(filters.boardSize, null)}>any</option>
        ${boardSizeOptions}
      </select>
    </div>
    <div class="field">
      <label for="join_type">Kind</label>
      <select id="join_type" name="join_type">
        <option value=""${selected(filters.joinType, null)}>any</option>
        ${joinTypeOptions}
      </select>
    </div>
  </div>
  <div class="field">
    <label class="check"><input type="checkbox" id="curated" name="curated" value="1"${filters.curated ? ' checked' : ''}> Only show games from players I follow</label>
  </div>
  <div class="field">
    <label for="proposer">Proposed by</label>
    <input id="proposer" name="proposer" autocomplete="off" value="${escapeHtml(filters.proposerDisplayName ?? '')}" placeholder="any part of a display name">
  </div>
  <p class="actions">
    <button type="submit" class="btn">Search</button>
    ${filtered ? '<a class="btn btn-quiet" href="/games/find">Clear</a>' : ''}
  </p>
</form>
<div class="block">
  <h2>${filtered ? 'Matching proposals' : 'Waiting for an opponent'}</h2>
  ${results}
</div>`;
  return renderShell('Find a game', body, { user, path: '/games/find', scripts: 'client' });
}
