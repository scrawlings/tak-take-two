import { breadcrumb, escapeHtml, renderShell } from './html.js';
import type { SessionUser } from './auth.js';
import type { ExportFormat, GameExport, GameSummary, GameView } from './games.js';
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
import {
  BOARD_CLASS,
  CAN_MOVE_ATTR,
  COMPONENTS,
  FLAG_OFF,
  FLAG_ON,
  HEIGHT_ATTR,
  METHODS,
  MOVE_LINK_CLASS,
  MOVE_MODEL,
  MOVE_NUMBER_ATTR,
  REGION_ATTR,
  SELF_PLAY_ATTR,
  SQUARE_ATTR,
  STACK_ATTR,
  stoneGlyph,
  TOP_ATTR,
  TOTAL_ATTR,
  TOTAL_MOVES_ATTR,
  TPS_ATTR,
  VIEWER_SEAT_ATTR,
  type BoardConfig,
  type StreamConfig,
} from './contract.js';

/**
 * Server-rendered auth/admin views. Keep the markup thin: these pages only
 * prove the auth seam; ticket 09–11 build the real game views on top.
 */

const ACCOUNT = { href: '/account', label: 'Account' };
const USERS = { href: '/admin/users', label: 'Users' };

/**
 * The parts of a page the SSE stream re-renders (ticket 14), keyed by the
 * `data-region` name the client swaps them into. A region is whole rendered
 * HTML from the very same view function the page used, so what a stream pushes
 * and what a reload would serve cannot drift apart.
 *
 * Each page names its own regions as a literal union, so a page and its stream
 * route cannot disagree about which parts exist; `Regions` unparameterised is
 * what the stream route carries, having stopped caring which page it serves.
 */
export type Regions<K extends string = string> = Readonly<Record<K, string>>;

/** Mark a region so the stream component can find and replace it. */
function region(name: string, html: string): string {
  return `<div ${REGION_ATTR}="${name}">${html}</div>`;
}

/**
 * The wrapper that holds a page's live connection. It must enclose every
 * region but nothing whose state the browser owns — a half-typed form, or the
 * click-builder's composition — because the stream replaces what is inside it.
 */
function streamed(url: string, html: string): string {
  return `<div x-data="${COMPONENTS.stream}(${escapeHtml(JSON.stringify({ url } satisfies StreamConfig))})">
  <p class="hint stream-lapsed" x-show="!live" x-cloak>Live updates have stopped — reload the page to catch up.</p>
  ${html}
</div>`;
}


export function renderStatusPageBody(body: string): string {
    return `<h1>Status</h1>
<p class="lede">Live figures for this server. The same numbers are available to Prometheus at <span class="mono">/metrics</span>.</p>
<div class="table-scroll">
  <table class="data">
    <thead><tr><th>Measure</th><th>Value</th></tr></thead>
    <tbody>${body}</tbody>
  </table>
</div>`;
}

export function renderForbiddenPage(): string {
  return `<div class="narrow">
  <h1>Forbidden</h1>
  <p class="lede">This page is for admins. Your account can't open it.</p>
  <p class="actions"><a class="btn btn-quiet" href="/account">Go to your account</a></p>
</div>`;
}

export function renderRoot(user?: SessionUser): string {
  const action = user
    ? `<a class="btn" href="/account">Go to your account</a>`
    : `<a class="btn" href="/login">Sign in</a>`;
  const body = `
<h1>A place to record games of Tak.</h1>
<p class="lede">Players keep the game on a real board. The site validates each move and holds the record.</p>
<div class="record">
  <p class="record-line">5b4&gt;212</p>
  <p class="record-gloss">A stack move in Portable Tak Notation: lift five stones from b4, carry them right, and drop two on c4, one on d4, two on e4.</p>
</div>
<p class="actions">${action}</p>`;
  return renderShell('Tak', body, { user, path: '/' });
}

export interface LoginView {
  error?: string;
  message?: string;
}

export function renderLoginPage(view: LoginView = {}): string {
  const notice = view.message
    ? `<p class="notice">${escapeHtml(view.message)}</p>`
    : view.error
      ? `<p class="error">${escapeHtml(view.error)}</p>`
      : '';
  const body = `
<div class="narrow">
  <h1>Sign in</h1>
  ${notice}
  <form class="panel" method="post" action="/login">
    <div class="field">
      <label for="username">Username</label>
      <input id="username" name="username" autocomplete="username" required>
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
    </div>
    <p class="actions"><button type="submit" class="btn">Sign in</button></p>
  </form>
  <p class="hint">Forgotten your password? An admin can reset it for you.</p>
</div>`;
  return renderShell('Sign in', body, { path: '/login' });
}

export function renderAccountPage(user: SessionUser): string {
  const body = `
<h1>Account</h1>
<p class="lede">Signed in as <strong>${escapeHtml(user.displayName)}</strong>, username <span class="mono">${escapeHtml(user.username)}</span>.</p>
<div class="block">
  <h2>Settings</h2>
  <div class="actions">
    <a class="btn btn-quiet" href="/account/password">Change password</a>
    <a class="btn btn-quiet" href="/account/display-name">Change display name</a>
  </div>
</div>
<div class="block">
  <h2>Session</h2>
  <form method="post" action="/logout" class="actions"><button type="submit" class="btn btn-quiet">Sign out</button></form>
</div>`;
  return renderShell('Account', body, { user, path: '/account' });
}

export interface ChangePasswordView {
  forced: boolean;
  error?: string;
}

export function renderChangePasswordPage(user: SessionUser, view: ChangePasswordView): string {
  // While forced, this page is the only way forward — don't offer a trail back.
  const crumbs = view.forced ? '' : breadcrumb(ACCOUNT, 'Change password');
  const notice = view.forced
    ? `<p class="notice">Choose a new password before continuing. Enter your current password first.</p>`
    : '';
  const error = view.error ? `<p class="error">${escapeHtml(view.error)}</p>` : '';
  const body = `
<div class="narrow">
  ${crumbs}
  <h1>Change password</h1>
  ${notice}
  ${error}
  <form class="panel" method="post" action="/account/password">
    <div class="field">
      <label for="old_password">Current password</label>
      <input id="old_password" name="old_password" type="password" autocomplete="current-password" required>
    </div>
    <div class="field">
      <label for="new_password">New password</label>
      <input id="new_password" name="new_password" type="password" autocomplete="new-password" required>
    </div>
    <p class="actions"><button type="submit" class="btn">Change password</button></p>
    <p class="hint">Changing your password signs you out everywhere. Sign in again with the new one.</p>
  </form>
</div>`;
  return renderShell('Change password', body, { user, path: '/account/password' });
}

export interface ChangeDisplayNameView {
  error?: string;
}

export function renderChangeDisplayNamePage(user: SessionUser, view: ChangeDisplayNameView = {}): string {
  const error = view.error ? `<p class="error">${escapeHtml(view.error)}</p>` : '';
  const body = `
<div class="narrow">
  ${breadcrumb(ACCOUNT, 'Change display name')}
  <h1>Change display name</h1>
  <p class="lede">This is the name other players see. Your username, <span class="mono">${escapeHtml(user.username)}</span>, stays the same.</p>
  ${error}
  <form class="panel" method="post" action="/account/display-name">
    <div class="field">
      <label for="display_name">New display name</label>
      <input id="display_name" name="display_name" value="${escapeHtml(user.displayName)}" required>
    </div>
    <p class="actions"><button type="submit" class="btn">Change display name</button></p>
  </form>
</div>`;
  return renderShell('Change display name', body, { user, path: '/account/display-name' });
}

export interface AdminUsersView {
  error?: string;
  message?: string;
}

export function renderAdminUsersPage(actor: SessionUser, users: readonly SessionUser[], view: AdminUsersView = {}): string {
  const notice = view.message
    ? `<p class="notice">${escapeHtml(view.message)}</p>`
    : view.error
      ? `<p class="error">${escapeHtml(view.error)}</p>`
      : '';

  const rows = users
    .map((u) => {
      const tags = [
        u.blocked ? '<span class="tag tag-flag">blocked</span>' : '',
        // Routine for every new account, so it stays neutral; only `blocked` is a flag.
        u.forcePasswordChange ? '<span class="tag">password change required</span>' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const self = u.id === actor.id;
      const actions = self
        ? `<form method="post" action="/admin/users/${u.id}/force-password-change"><button type="submit" class="btn btn-quiet btn-sm">Force change</button></form>
           <form method="post" action="/admin/users/${u.id}/reset-password"><button type="submit" class="btn btn-quiet btn-sm">Reset password</button></form>`
        : `<form method="post" action="/admin/users/${u.id}/block"><button type="submit" class="btn btn-danger btn-sm">Block</button></form>
           <form method="post" action="/admin/users/${u.id}/unblock"><button type="submit" class="btn btn-quiet btn-sm">Unblock</button></form>
           <form method="post" action="/admin/users/${u.id}/force-password-change"><button type="submit" class="btn btn-quiet btn-sm">Force change</button></form>
           <form method="post" action="/admin/users/${u.id}/reset-password"><button type="submit" class="btn btn-quiet btn-sm">Reset password</button></form>`;
      return `<tr>
  <td class="key">${escapeHtml(u.username)}</td>
  <td>${escapeHtml(u.displayName)}</td>
  <td><span class="tag">${escapeHtml(u.role)}</span></td>
  <td>${tags || '<span class="dim">—</span>'}</td>
  <td><div class="row-actions">${actions}</div></td>
</tr>`;
    })
    .join('');

  const body = `
<h1>Users</h1>
${notice}
<div class="block">
  <h2>Create user</h2>
  <form class="panel" method="post" action="/admin/users">
    <div class="field-grid">
      <div class="field">
        <label for="username">Username</label>
        <input id="username" name="username" autocomplete="off" required>
      </div>
      <div class="field">
        <label for="password">Initial password</label>
        <input id="password" name="password" type="text" autocomplete="off" required>
      </div>
      <div class="field">
        <label for="display_name">Display name</label>
        <input id="display_name" name="display_name" autocomplete="off">
      </div>
      <div class="field">
        <label for="role">Role</label>
        <select id="role" name="role">
          <option value="player">player</option>
          <option value="admin">admin</option>
        </select>
      </div>
    </div>
    <p class="actions"><button type="submit" class="btn">Create user</button></p>
    <p class="hint">Leave the display name empty to use the username. The new account must change its password at first sign-in.</p>
  </form>
</div>
<div class="block">
  <h2>All users</h2>
  <div class="table-scroll">
    <table class="data">
      <thead><tr><th>Username</th><th>Display name</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</div>`;
  return renderShell('Users', body, { user: actor, path: '/admin/users' });
}

export interface AdminGamesView {
  error?: string;
}

/**
 * Ticket 13's admin face: every game on the site, share state aside, so an
 * admin can open any game (admin viewing) or remove one (admin deletion). The
 * `removed` flag renders like the players' lists do, so a removed game is
 * recognisable at a glance. Only the module's `listAllGames` decides who may
 * see this page.
 */
export function renderAdminGamesPage(actor: SessionUser, games: readonly GameSummary[], view: AdminGamesView = {}): string {
  const notice = view.error ? `<p class="error">${escapeHtml(view.error)}</p>` : '';

  const rows = games
    .map((game) => {
      const state = game.adminRemoved
        ? '<span class="tag tag-flag">removed by an admin</span>'
        : game.state === 'in_play'
          ? '<span class="tag">in play</span>'
          : game.state === 'proposed'
            ? `<span class="tag">proposed · ${game.joinType === 'open' ? 'open' : 'invited'}</span>`
            : '<span class="tag">finished</span>';
      const players =
        game.opponent === null
          ? `${escapeHtml(game.proposer.displayName)} <span class="dim">waiting for ${
              game.invitedPlayer === null ? 'anyone' : escapeHtml(game.invitedPlayer.displayName)
            }</span>`
          : `${escapeHtml(game.proposer.displayName)} <span class="dim">vs</span> ${escapeHtml(game.opponent.displayName)}`;
      const toMove = game.toMove === null ? '<span class="dim">—</span>' : escapeHtml(game.toMove.displayName);
      const result = game.result === null ? '<span class="dim">—</span>' : `<span class="mono">${escapeHtml(game.result)}</span>`;
      const remove =
        game.adminRemoved
          ? ''
          : `<form method="post" action="/games/${game.id}/admin-delete"><button type="submit" class="btn btn-danger btn-sm">Remove</button></form>`;
      return `<tr>
  <td class="num"><a href="/games/${game.id}">${game.id}</a></td>
  <td class="num">${game.boardSize}×${game.boardSize}</td>
  <td>${players}</td>
  <td>${state}</td>
  <td>${toMove}</td>
  <td>${result}</td>
  <td><div class="row-actions"><a class="btn btn-sm" href="/games/${game.id}">Open</a>${remove}</div></td>
</tr>`;
    })
    .join('');

  const table =
    games.length === 0
      ? `<p class="lede">No games have been proposed yet.</p>`
      : `<div class="table-scroll">
    <table class="data">
      <thead><tr><th>Game</th><th>Board</th><th>Players</th><th>State</th><th>To move</th><th>Result</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;

  const body = `
<h1>Games</h1>
${notice}
<p class="lede">Every game on the site, shared or not. Open one to view the position and history; Remove ends it, leaving the players a notice of the removal.</p>
<div class="block">
  <h2>All games</h2>
  ${table}
</div>`;
  return renderShell('Games', body, { user: actor, path: '/admin/games' });
}

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
      ? `<form method="post" action="/games/${game.id}/join">${hiddenReturnTo}<button type="submit" class="btn btn-sm"${
          game.canSolo ? ' title="Claim your own game and play both seats yourself."' : ''
        }>${game.canSolo ? 'Solo' : 'Join'}</button></form>`
      : '';
  const buttons = [
    join,
    game.canDelete
      ? `<form method="post" action="/games/${game.id}/delete">${hiddenReturnTo}<button type="submit" class="btn btn-danger btn-sm">Delete</button></form>`
      : '',
    // A finished game still opens: the board and history stay reviewable
    // (ticket 01's review mode covers finished games), and this was the row's
    // only way in — the previous `in_play`-only condition left a filtered-in
    // finished game with no actions at all.
    game.state === 'in_play' || game.state === 'finished'
      ? `<a class="btn btn-sm" href="/games/${game.id}">Open</a>`
      : '',
    // Ticket 05: hide from the row, without opening the game. Restricted to
    // `games` deliberately, not just by `canHide` happening to be false on
    // find: the viewer's own open proposal can appear there too (joinable by
    // themselves for self-play), and `canHide` is already true for it then —
    // hide belongs to "your games", not to a page for finding one to join.
    list === 'games' && game.canHide
      ? `<form method="post" action="/games/${game.id}/hide">${hiddenReturnTo}<button type="submit" class="btn btn-quiet btn-sm">Hide</button></form>`
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

export function renderResetPasswordResult(actor: SessionUser, username: string, password: string): string {
  const body = `
<div class="narrow">
  ${breadcrumb(USERS, 'Password reset')}
  <h1>Password reset</h1>
  <p class="lede">New password for <strong>${escapeHtml(username)}</strong>:</p>
  <p class="secret"><code id="reset-password">${escapeHtml(password)}</code></p>
  <p class="hint">This is shown once. Pass it to the user out of band — they must change it at their next sign-in.</p>
</div>`;
  return renderShell('Password reset', body, { user: actor, path: '/admin/users' });
}

/** A page for a game the viewer cannot see or that no longer exists. */
export function renderNotFoundPage(): string {
  return `<div class="narrow">
  <h1>Not found</h1>
  <p class="lede">There is no game here — it may have been deleted, or it is not shared with you.</p>
  <p class="actions"><a class="btn btn-quiet" href="/games">Your games</a></p>
</div>`;
}

/** The board glyph for one stone — one table for server and bundle, in `contract.ts` (ADR-0013). */

function playerColor(seat: 1 | 2): string {
  return seat === 1 ? '●' : '○';
}

/** The word for a seat's stones — seat 1 plays filled, seat 2 open. */
function seatColourWord(seat: 1 | 2): string {
  return seat === 1 ? 'filled' : 'open';
}

export interface GameViewPageView {
  error?: string;
}

function renderBoard(game: GameView): string {
  const files = ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, game.boardSize);
  const top = `<span class="axis"></span>${files.map((f) => `<span class="axis">${f}</span>`).join('')}`;
  const rows: string[] = [];
  for (const row of game.board) {
    const rank = row[0]!.rank;
    const cells = row
      .map((cell) => {
        const topStone = cell.stack.length === 0 ? null : cell.stack[cell.stack.length - 1]!;
        const glyph = topStone === null ? '·' : stoneGlyph(topStone.player, topStone.kind);
        const topAttr = topStone === null ? '' : `${topStone.player}|${topStone.kind}`;
        // Bottom to top, so the adapter can read off the top `lift` glyphs as
        // the hand a stack move carries, in the order it drops them.
        const stackAttr = cell.stack.map((s) => stoneGlyph(s.player, s.kind)).join('');
        const height = cell.stack.length > 1 ? `<span class="cell-height">${cell.stack.length}</span>` : '';
        const square = `${cell.file}${cell.rank}`;
        // What this square receives if the move is played: the builder's own
        // count, so the board shows the distribution rather than just the path.
        const drops = `<span class="cell-drops" x-show="${METHODS.dropsOn}('${square}') > 0" x-cloak x-text="${METHODS.dropsOn}('${square}')"></span>`;
        const stackTip =
          cell.stack.length === 0
            ? ''
            : `<span class="stack-tip">${[...cell.stack]
                .reverse()
                .map((s) => `<span>${stoneGlyph(s.player, s.kind)}</span>`)
                .join('')}</span>`;
        // Two overlaid spans per concern, one live and one reviewed, so a
        // stream swap (which always re-renders this whole cell, ADR-0007)
        // needs nothing beyond the same `x-show="reviewing"` toggle to keep
        // showing the reviewed position: Alpine re-binds the fresh nodes
        // against the surviving review state on every swap.
        const content = `<span x-show="!reviewing">${glyph}${height}</span><span x-show="reviewing" x-cloak x-html="${METHODS.reviewCell}('${square}')"></span>`;
        const tip = `<span x-show="!reviewing">${stackTip}</span><span x-show="reviewing" x-cloak x-html="${METHODS.reviewStackTip}('${square}')"></span>`;
        return `<button type="button" class="cell" ${SQUARE_ATTR}="${square}" ${HEIGHT_ATTR}="${cell.stack.length}" ${TOP_ATTR}="${topAttr}" ${STACK_ATTR}="${stackAttr}" x-on:click="${METHODS.cellClick}($el)" :class="{ 'is-source': ${METHODS.isSource}('${square}'), 'is-path': ${METHODS.dropsOn}('${square}') > 0 }" aria-label="${square}">${content}${drops}${tip}</button>`;
      })
      .join('');
    rows.push(`<span class="axis">${rank}</span>${cells}`);
  }
  // What the viewer may do with this board, for the adapter to read on every
  // click. It belongs here, inside the streamed region, because it changes as
  // the game does: a move passes the turn, and a joiner settles a random start.
  // Held in the `x-data` config instead, it would freeze at page load and a
  // streamed update would leave a live move form above an inert board.
  const standing = [
    `${CAN_MOVE_ATTR}="${game.canMove ? FLAG_ON : FLAG_OFF}"`,
    `${VIEWER_SEAT_ATTR}="${game.viewerSeat ?? ''}"`,
    `${SELF_PLAY_ATTR}="${game.selfPlay ? FLAG_ON : FLAG_OFF}"`,
  ].join(' ');
  return `<div class="${BOARD_CLASS}" ${standing} style="grid-template-columns: auto repeat(${game.boardSize}, 2.75rem)">${top}${rows.join('')}</div>`;
}

function renderGameStatus(game: GameView): string {
  if (game.adminRemoved) {
    return `<p class="notice">This game was removed by an admin.</p>`;
  }
  if (game.state === 'proposed') {
    // Who starts is the proposer's choice, and until a random start is resolved
    // at join the seat is only a promise — say so rather than guess.
    const starter =
      game.proposerSeat === null
        ? 'A coin flip will decide who starts.'
        : game.proposerSeat === 1
          ? `${escapeHtml(game.proposer.displayName)} will start.`
          : `${game.opponent === null ? 'The joiner' : escapeHtml(game.opponent.displayName)} will start.`;
    return `<p class="lede">Proposed by ${escapeHtml(game.proposer.displayName)}${game.imported ? ', starting from an imported record' : ''}. Waiting for an opponent. ${starter}</p>`;
  }
  if (game.state === 'finished') {
    return `<p class="lede">${escapeHtml(game.resultText ?? 'Finished')}.</p>`;
  }

  if (game.selfPlay) {
    // One account holds both seats (CONTEXT.md: Self-play), so the only
    // meaningful "who" is the colour whose turn it is.
    const youPlay = game.viewerSeat !== null ? 'You play both colours. ' : '';
    const seat = game.toMoveSeat;
    if (seat === null) {
      return `<p class="lede">Self-play — ${escapeHtml(game.proposer.displayName)}. ${youPlay}</p>`;
    }
    const colour = seat === 1 ? 'Filled' : 'Open';
    const turn =
      game.isOpeningTurn && game.stoneSeat !== null
        ? `${colour}'s opening places an ${seatColourWord(game.stoneSeat)} stone.`
        : `${colour} to move.`;
    return `<p class="lede">Self-play — ${escapeHtml(game.proposer.displayName)}. ${youPlay}${turn}</p>`;
  }

  const youPlay =
    game.viewerSeat === null
      ? ''
      : `You play ${playerColor(game.viewerSeat)} (${seatColourWord(game.viewerSeat)}). `;
  let turn: string;
  if (game.canMove && game.isOpeningTurn && game.stoneSeat !== null) {
    turn = `Your turn — your opening move places your opponent's stone (${seatColourWord(game.stoneSeat)}).`;
  } else if (game.canMove) {
    turn = 'Your turn.';
  } else {
    turn = `${game.toMove ? escapeHtml(game.toMove.displayName) : '—'} to move.`;
  }
  return `<p class="lede">${escapeHtml(game.proposer.displayName)} vs ${escapeHtml(game.opponent?.displayName ?? '—')}. ${youPlay}${turn}</p>`;
}

/**
 * The sticky bar review mode replaces the move form with (ticket 01): which
 * move is showing, a snap-to-end button, and — when the live position is
 * waiting on the viewer while they are scrubbed away — a plain statement of
 * that, so review can never quietly hide that the game needs them. `canMove`
 * is server-decided and this region re-renders on every game change (ADR-0007
 * always replaces `controls`), so the phrase is always current; only its
 * visibility is client state.
 */
function renderReviewBar(game: GameView): string {
  const waiting = game.canMove ? `<p class="review-waiting">Your turn — they’re waiting on you.</p>` : '';
  return `<div class="review-bar panel" x-show="reviewing" x-cloak>
  <p>Viewing move <span x-text="reviewAt"></span> of ${game.moves.length}.</p>
  <p class="review-pulse" ${TOTAL_MOVES_ATTR}="${game.moves.length}" x-show="${METHODS.newMoveWhileReviewing}($el)" x-cloak>New move.</p>
  ${waiting}
  <p class="actions"><button type="button" class="btn btn-sm" x-on:click="${METHODS.snapToEnd}()">Snap to end</button></p>
</div>`;
}

function renderGameControls(game: GameView): string {
  const reviewBar = renderReviewBar(game);
  if (game.state === 'finished') return reviewBar;
  const parts: string[] = [reviewBar];

  if (game.pending !== null) {
    // The single pending request/offer: the respondent may accept or reject;
    // the requester waits. Either way, no move form while pending.
    const requester = escapeHtml(game.pending.requester.displayName);
    if (game.canRespond) {
      const text =
        game.pending.kind === 'draw'
          ? `${requester} offers a draw.`
          : `${requester} requests a take-back of their last move.`;
      const base = `/games/${game.id}/${game.pending.kind === 'draw' ? 'draw' : 'take-back'}`;
      parts.push(`
<div class="notice">
  <p>${text}</p>
  <p class="actions">
    <form method="post" action="${base}/accept"><button type="submit" class="btn btn-sm">Accept</button></form>
    <form method="post" action="${base}/reject"><button type="submit" class="btn btn-quiet btn-sm">Reject</button></form>
  </p>
</div>`);
    } else {
      const waiting =
        game.pending.kind === 'draw'
          ? 'Draw offered — waiting for a response.'
          : 'Take-back requested — waiting for a response.';
      parts.push(`<p class="notice">${waiting}</p>`);
    }
  } else if (game.canMove && game.stoneSeat !== null) {
    // The picker shows the glyph of the stone about to be placed, which on an
    // opening turn is the opponent's — `game-views.ts` decides that, this reads it.
    const placing = game.stoneSeat;
    const stoneButtons = (['flat', 'standing', 'capstone'] as const)
      .map(
        (kind) => `<button type="button" class="stone-btn" x-on:click="${METHODS.pick}('${kind}')" :class="{ 'is-selected': stone === '${kind}' }" :aria-pressed="stone === '${kind}'" aria-label="Place a ${kind} stone"><span class="stone-glyph">${stoneGlyph(placing, kind)}</span><span class="stone-btn-name">${kind}</span></button>`,
      )
      .join('');
    parts.push(`
<form class="panel" method="post" action="/games/${game.id}/move" x-show="!reviewing" x-cloak>
  <div class="field">
    <label for="move">Your move</label>
    <input id="move" name="move" x-model="${MOVE_MODEL}" placeholder="a1, Sa1, or 5b4&gt;212" autocomplete="off" spellcheck="false">
    <p class="hint">Type Portable Tak Notation, or build it by clicking the board above.</p>
  </div>
  <div class="field">
    <span class="label" id="stone-label">Stone to place</span>
    <div class="stone-picker" role="group" aria-labelledby="stone-label">
      ${stoneButtons}
    </div>
  </div>
  <div class="field" x-show="source !== null" x-cloak>
    <span class="label" id="lift-label">Stones to lift</span>
    <div class="stepper" role="group" aria-labelledby="lift-label">
      <button type="button" class="step-btn" x-on:click="${METHODS.bumpLift}(-1)" :disabled="lift <= liftFloor" aria-label="Lift one stone fewer">−</button>
      <span class="stepper-value" x-text="lift + ' of ' + (source ? source.height : 0)"></span>
      <button type="button" class="step-btn" x-on:click="${METHODS.bumpLift}(1)" :disabled="lift >= liftCeiling" aria-label="Lift one stone more">+</button>
      <button type="button" class="btn btn-quiet btn-sm" x-on:click="${METHODS.cancel}()">Cancel</button>
    </div>
    <p class="hint">Holding <span x-text="lift"></span> from <span class="mono" x-text="sourceSquare"></span> — click a square in a straight line, or the source again to put them back.</p>
    <p class="stack-partition mono" aria-hidden="true" x-text="partition"></p>
  </div>
  <div class="field" x-show="path.length > 0" x-cloak>
    <span class="label" id="drops-label">Stones dropped</span>
    <div class="drop-row" role="group" aria-labelledby="drops-label">
      <template x-for="(step, i) in path" :key="step.square">
        <span class="drop-step">
          <span class="mono drop-square" x-text="step.square"></span>
          <button type="button" class="step-btn" x-on:click="${METHODS.shiftDrop}(i, -1)" :disabled="!${METHODS.canShiftDrop}(i, -1)" :aria-label="'Move a stone from ' + step.square + ' to the square before it'">◀</button>
          <span class="drop-count" x-text="step.drops"></span>
          <button type="button" class="step-btn" x-on:click="${METHODS.shiftDrop}(i, 1)" :disabled="!${METHODS.canShiftDrop}(i, 1)" :aria-label="'Move a stone from ' + step.square + ' to the square after it'">▶</button>
        </span>
      </template>
    </div>
    <p class="hint">The arrows shift one stone to the neighbouring square, so raise a square by pushing a stone into it from the one beside it. Every square crossed keeps at least one stone, and the counts always add up to the lift.</p>
  </div>
  <p class="actions"><button type="submit" class="btn">Play move</button></p>
</form>`);
  }

  if (game.canOfferTakeBack || game.canOfferDraw || game.canResign) {
    parts.push(`
<div class="actions">
  ${game.canOfferTakeBack ? `<form method="post" action="/games/${game.id}/take-back"><button type="submit" class="btn btn-quiet">Request take-back</button></form>` : ''}
  ${game.canOfferDraw ? `<form method="post" action="/games/${game.id}/draw"><button type="submit" class="btn btn-quiet">Offer draw</button></form>` : ''}
  ${game.canResign ? `<form method="post" action="/games/${game.id}/resign"><button type="submit" class="btn btn-quiet">Resign</button></form>` : ''}
</div>`);
  }
  return parts.join('');
}

/**
 * The pair of export links offered at one point in the game (ticket 15): the
 * PTN through that move, and the TPS of the position after it. `through`
 * numbers the full history, so move 0 is the starting position.
 */
function exportLinks(gameId: number, through: number | null): string {
  // `&amp;` because this is an HTML attribute, not a bare URL; the browser
  // hands the server back a plain `&`.
  const query = (format: string): string =>
    `/games/${gameId}/export?format=${format}${through === null ? '' : `&amp;through=${through}`}`;
  const at = through === null ? 'the whole game' : `move ${through}`;
  // Every export is recorded in the activity trail, so keep crawlers from
  // walking two links per move and filling it with exports nobody asked for.
  const link = (format: string, title: string): string =>
    `<a class="export-link" rel="nofollow" href="${query(format)}" title="${title}">${format.toUpperCase()}</a>`;
  return (
    link('ptn', `Copy the PTN through ${at}`) +
    link('tps', `Copy the TPS of the position after ${at}`)
  );
}

function renderHistory(game: GameView): string {
  const whole = `<p class="hint">Copy the record: ${exportLinks(game.id, null)} for the whole game, or from any move below.</p>`;
  if (game.moves.length === 0) {
    // Even with no moves there is a position to copy — the empty board.
    return `<div class="block"><h2>Moves</h2><p class="lede">No moves yet.</p>${whole}</div>`;
  }
  const total = game.moves.length;
  const lines: string[] = [];
  for (let i = 0; i < game.moves.length; i += 2) {
    const turn = i / 2 + 1;
    // Clicking a move scrubs to the position right after it (ticket 01): the
    // element carries its own TPS and move number, the same self-contained
    // idiom the board cells use, so the adapter needs nothing beyond the
    // click target.
    const cell = (m: GameView['moves'][number]): string =>
      `<button type="button" class="${MOVE_LINK_CLASS} mono" ${MOVE_NUMBER_ATTR}="${m.number}" ${TPS_ATTR}="${escapeHtml(m.tps)}" ${TOTAL_ATTR}="${total}" x-on:click="${METHODS.scrubTo}($el)" :class="{ 'is-reviewed': reviewAt === ${m.number} }">${escapeHtml(m.notation)}</button> <span class="dim">${escapeHtml(m.player.displayName)}</span> ${exportLinks(game.id, m.number)}`;
    const second = game.moves[i + 1];
    lines.push(`<li><span class="mono">${turn}.</span> ${cell(game.moves[i]!)}${second ? ` ${cell(second)}` : ''}</li>`);
  }
  const imported = game.moves.some((m) => m.imported);
  const note = imported ? '<p class="hint">Imported moves are fixed history.</p>' : '';
  return `<div class="block"><h2>Moves</h2><ol class="moves">${lines.join('')}</ol>${note}${whole}</div>`;
}

function renderLegend(): string {
  return `<p class="hint">● flat (filled) · ○ flat (open) · ▲ wall · ■ capstone — hover a square to read its stack. Press <kbd>?</kbd> for keyboard shortcuts.</p>`;
}

/**
 * The one-line shortcuts help panel (ticket 02): server-rendered, toggled by
 * `helpVisible` on `takBoard` — the same "island" pattern as the review bar,
 * so there is no client-only copy of this text to keep in step.
 */
function renderShortcutsHelp(): string {
  return `<p class="shortcuts-help panel" x-show="helpVisible" x-cloak>
  <kbd>Enter</kbd> play the move · <kbd>[</kbd> <kbd>]</kbd> step the history · <kbd>u</kbd> request a take-back · <kbd>Esc</kbd> cancel / snap to live · <kbd>?</kbd> toggle this help
  <button type="button" class="btn btn-quiet btn-sm" x-on:click="${METHODS.toggleHelp}()">Close</button>
</p>`;
}

/** A reserve count: the live figure, or the reviewed one while scrubbed — see `renderBoard`'s cells. */
function reserveCount(seat: 1 | 2, kind: 'stones' | 'capstones', live: number): string {
  return `<span x-show="!reviewing">${live}</span><span x-show="reviewing" x-cloak x-text="${METHODS.reviewReserve}(${seat}, '${kind}')"></span>`;
}

function renderReserves(game: GameView): string {
  if (game.state === 'proposed') return '';
  const you = game.viewerSeat;
  const label = (seat: 1 | 2, name: string): string =>
    `${escapeHtml(name)}${game.selfPlay || you === seat ? ' (you)' : ''}`;
  const p1 = game.reserves[1];
  const p2 = game.reserves[2];
  return `<div class="block">
  <h2>Stones left</h2>
  <div class="table-scroll">
    <table class="data">
      <thead><tr><th>Player</th><th>Colour</th><th>Flats</th><th>Capstones</th></tr></thead>
      <tbody>
        <tr><td>${label(1, game.proposer.displayName)}</td><td>● filled</td><td class="num">●▲ ${reserveCount(1, 'stones', p1.stones)}</td><td class="num">■ ${reserveCount(1, 'capstones', p1.capstones)}</td></tr>
        <tr><td>${label(2, game.opponent?.displayName ?? 'Opponent')}</td><td>○ open</td><td class="num">○△ ${reserveCount(2, 'stones', p2.stones)}</td><td class="num">□ ${reserveCount(2, 'capstones', p2.capstones)}</td></tr>
      </tbody>
    </table>
  </div>
</div>`;
}

function renderMoveSyntax(): string {
  return `<div class="block">
  <h2>Move syntax</h2>
  <ul class="moves">
    <li><span class="mono">a1</span> — place a flat stone on a1</li>
    <li><span class="mono">Sa1</span> — place a standing stone (wall)</li>
    <li><span class="mono">Ca1</span> — place a capstone</li>
    <li><span class="mono">5b4&gt;212</span> — lift 5 from b4, move right, drop 2, 1, 2</li>
    <li>Directions: <span class="mono">&lt;</span> left · <span class="mono">&gt;</span> right · <span class="mono">+</span> up · <span class="mono">-</span> down</li>
  </ul>
</div>`;
}

/**
 * Ticket 13: the viewer's own share toggle and hide button (any participant),
 * plus an admin's removal. Rendered regardless of lifecycle state — an admin
 * may still want to remove a finished game, and a participant may still want
 * to stop sharing or hide one.
 */
function renderGameManagement(game: GameView): string {
  const parts: string[] = [];
  if (game.viewerShared !== null) {
    parts.push(
      game.viewerShared
        ? `<form method="post" action="/games/${game.id}/share"><input type="hidden" name="on" value="0"><button type="submit" class="btn btn-quiet btn-sm">Stop sharing</button></form>`
        : `<form method="post" action="/games/${game.id}/share"><input type="hidden" name="on" value="1"><button type="submit" class="btn btn-quiet btn-sm">Share with spectators</button></form>`,
    );
  }
  if (game.canHide) {
    parts.push(
      // `return_to` naming the game's own page (ticket 05) routes a refusal
      // back here rather than the games list — the same "where did the click
      // come from" idiom the list row's hide button and the join button share.
      `<form method="post" action="/games/${game.id}/hide"><input type="hidden" name="return_to" value="/games/${game.id}"><button type="submit" class="btn btn-quiet btn-sm">Hide from my games</button></form>`,
    );
  }
  if (game.canAdminDelete) {
    parts.push(
      `<form method="post" action="/games/${game.id}/admin-delete"><button type="submit" class="btn btn-danger btn-sm">Remove this game</button></form>`,
    );
  }
  if (parts.length === 0) return '';
  return `<div class="block"><h2>Visibility</h2><p class="hint">${
    game.viewerShared === null
      ? 'Only an admin can see this here.'
      : game.viewerShared
        ? 'Shared: anyone can view this game.'
        : 'Not shared: only the two players can view this game.'
  }</p><div class="row-actions">${parts.join('')}</div></div>`;
}

/**
 * Everything on the game screen that a move changes (ticket 14). The controls
 * and the reserves are here alongside ADR-0007's three regions because a move
 * changes them too: a fresh board beside a stale stone count, or beside a move
 * form that says it is still your turn, is exactly the inconsistency the
 * stream exists to remove.
 */
export function gameRegions(game: GameView): Regions<'status' | 'board' | 'controls' | 'reserves' | 'moves'> {
  return {
    status: renderGameStatus(game),
    board: renderBoard(game),
    controls: renderGameControls(game),
    reserves: renderReserves(game),
    moves: renderHistory(game),
  };
}

export function renderGamePage(user: SessionUser, game: GameView, view: GameViewPageView = {}): string {
  const error = view.error ? `<p class="error">${escapeHtml(view.error)}</p>` : '';
  const regions = gameRegions(game);
  // Only the board's size: everything else the adapter needs changes while the
  // page is open, so it rides in the streamed board element instead.
  const boardConfig = { size: game.boardSize };

  // The `takBoard` scope sits *inside* the stream wrapper and *outside* the
  // board, controls, reserves and moves regions, so a swap replaces them while
  // the composition and review state on the scope survives (ADR-0007). The
  // swap itself is skipped when the HTML is unchanged, so an idle stream never
  // touches the board at all. Reserves and moves join board and controls here
  // (ticket 01): review needs to reach all four to show a reviewed position,
  // the same reason ticket 14 drew that boundary around board and controls.
  //
  // The keydown listener sits on this same wrapper (ticket 02): shortcuts
  // read and drive the same survives-the-stream state review does, so they
  // belong on the scope that already owns it rather than a second component.
  const live = `
${region('status', regions.status)}
${error}
${renderLegend()}
<div x-data="${COMPONENTS.board}(${escapeHtml(JSON.stringify(boardConfig satisfies BoardConfig))})" x-cloak x-on:keydown.window="${METHODS.handleKey}($event)">
  ${renderShortcutsHelp()}
  ${region('board', regions.board)}
  ${region('controls', regions.controls)}
  ${/* Deliberately not a region: share, hide and admin-removal change only by
       the viewer's own action, which is a POST and a redirect, so there is
       nothing for a stream to tell them. It sits inside the wrapper because the
       wrapper touches only what carries `data-region`. */ ''}
  ${renderGameManagement(game)}
  ${region('reserves', regions.reserves)}
  ${region('moves', regions.moves)}
</div>`;

  const body = `
${breadcrumb({ href: '/games', label: 'Games' }, `Game ${game.id}`)}
<h1>Game ${game.id}</h1>
${streamed(`/games/${game.id}/stream`, live)}
${renderMoveSyntax()}`;
  return renderShell(`Game ${game.id}`, body, { user, path: '/games', scripts: 'client' });
}

/** Register the copy button as an Alpine component. It stays inline beside
 *  the one page that uses it, rather than joining the bundle (ADR-0006). */
const TAK_COPY_SCRIPT = `<script>
document.addEventListener('alpine:init', () => {
  Alpine.data('takCopy', () => ({
    // The clipboard API is absent over plain HTTP away from localhost, and can
    // still refuse at the point of use, so the button only shows where it
    // works. The record stays selectable either way.
    supported: Boolean(navigator.clipboard),
    copied: false,
    copy() {
      navigator.clipboard.writeText(this.$refs.record.textContent).then(
        () => {
          this.copied = true;
          setTimeout(() => { this.copied = false }, 1500);
        },
        () => { this.supported = false },
      );
    }
  }));
});
</script>`;

/**
 * The copy-out page for one export (ticket 15). The record is selectable on
 * its own (`user-select: all`), so copying works with scripting off; the Copy
 * button is an enhancement that only appears where the clipboard API exists.
 */
export function renderExportPage(user: SessionUser, gameId: number, view: GameExport): string {
  const whole = view.throughMove === view.totalMoves;
  const other: ExportFormat = view.format === 'ptn' ? 'tps' : 'ptn';
  const through = whole ? '' : `&amp;through=${view.throughMove}`;

  const what =
    view.format === 'ptn'
      ? whole
        ? 'The full game as Portable Tak Notation. Paste it anywhere that reads PTN — including this site, to carry the game in.'
        : `The game as Portable Tak Notation up to and including move ${view.throughMove} of ${view.totalMoves}. It replays on its own.`
      : whole
        ? 'The final position as the Tak Positional System describes it.'
        : `The position after move ${view.throughMove} of ${view.totalMoves}, as the Tak Positional System describes it.`;

  const body = `
${breadcrumb({ href: `/games/${gameId}`, label: `Game ${gameId}` }, view.format.toUpperCase())}
<h1>${view.format.toUpperCase()}</h1>
<p class="lede">${what}</p>
${TAK_COPY_SCRIPT}
<div x-data="takCopy">
  <pre class="export-text" x-ref="record">${escapeHtml(view.text)}</pre>
  <p class="actions">
    <button type="button" class="btn" x-on:click="copy()" x-show="supported" x-cloak x-text="copied ? 'Copied' : 'Copy'">Copy</button>
    <a class="btn btn-quiet" href="/games/${gameId}/export?format=${other}${through}">Show ${other.toUpperCase()} instead</a>
    <a class="btn btn-quiet" href="/games/${gameId}">Back to the game</a>
  </p>
</div>
<p class="hint">Select the record above to copy it by hand.</p>`;
  return renderShell(`${view.format.toUpperCase()} — game ${gameId}`, body, { user, path: '/games', scripts: 'alpine' });
}
