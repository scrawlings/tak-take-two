import { breadcrumb, escapeHtml, renderShell } from './html.js';
import type { SessionUser } from './auth.js';
import type { GameSummary } from './games.js';

/**
 * Server-rendered auth/admin views. Keep the markup thin: these pages only
 * prove the auth seam; ticket 09–11 build the real game views on top.
 */

const ACCOUNT = { href: '/account', label: 'Account' };
const USERS = { href: '/admin/users', label: 'Users' };


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

export interface MyGamesView {
  error?: string;
  /** Values to put back in the propose form when it comes back with an error. */
  submitted?: {
    boardSize?: string | null;
    joinType?: string | null;
    invitedDisplayName?: string | null;
    ptn?: string | null;
  };
}

function gameStatusTag(game: GameSummary): string {
  if (game.state === 'in_play') return '<span class="tag">in play</span>';
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

/** Which list a game action was taken from, so a refusal returns there. */
export type GameListPage = 'games' | 'find';

/** The actions a viewer may take on a game, as the module decided them. */
function gameActions(game: GameSummary, from: GameListPage): string {
  const buttons = [
    game.canJoin
      ? `<form method="post" action="/games/${game.id}/join"><input type="hidden" name="from" value="${from}"><button type="submit" class="btn btn-sm">Join</button></form>`
      : '',
    game.canDelete
      ? `<form method="post" action="/games/${game.id}/delete"><button type="submit" class="btn btn-danger btn-sm">Delete</button></form>`
      : '',
  ].filter(Boolean);
  return `<div class="row-actions">${buttons.join('')}</div>`;
}

export function renderMyGamesPage(
  user: SessionUser,
  games: readonly GameSummary[],
  view: MyGamesView = {},
): string {
  const error = view.error ? `<p class="error">${escapeHtml(view.error)}</p>` : '';
  const submitted = view.submitted ?? {};
  const sizeSelected = (size: string): string => (submitted.boardSize === size ? ' selected' : '');
  const joinSelected = (kind: string): string => (submitted.joinType === kind ? ' selected' : '');

  const rows = games
    .map(
      (game) => `<tr>
  <td class="num">${game.boardSize}×${game.boardSize}</td>
  <td>${gameStatusTag(game)}</td>
  <td>${opponentCell(game)}</td>
  <td>${game.toMove === null ? '<span class="dim">—</span>' : escapeHtml(game.toMove.displayName)}</td>
  <td>${game.imported ? '<span class="tag">imported</span>' : '<span class="dim">empty board</span>'}</td>
  <td>${gameActions(game, 'games')}</td>
</tr>`,
    )
    .join('');

  const table =
    games.length === 0
      ? `<p class="lede">No games yet. Propose one below and it will appear here.</p>`
      : `<div class="table-scroll">
    <table class="data">
      <thead><tr><th>Board</th><th>State</th><th>Opponent</th><th>To move</th><th>Started from</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;

  const body = `
<h1>Your games</h1>
${error}
<div class="block">
  <h2>In progress</h2>
  ${table}
</div>
<div class="block">
  <h2>Propose a game</h2>
  <form class="panel" method="post" action="/games" x-data="{ join: '${submitted.joinType === 'invited' ? 'invited' : 'open'}', ptn: ${escapeHtml(JSON.stringify(submitted.ptn ?? ''))} }">
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
  return renderShell('Your games', body, { user, path: '/games' });
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
  /** The filters as submitted, so the form comes back the way it was left. */
  filters?: {
    boardSize?: string | null;
    joinType?: string | null;
    proposerDisplayName?: string | null;
  };
}

export function renderFindGamesPage(
  user: SessionUser,
  games: readonly GameSummary[],
  view: FindGamesView = {},
): string {
  const error = view.error ? `<p class="error">${escapeHtml(view.error)}</p>` : '';
  const filters = view.filters ?? {};
  const filtered = Boolean(filters.boardSize || filters.joinType || filters.proposerDisplayName);
  const selected = (value: string | null | undefined, option: string): string =>
    value === option ? ' selected' : '';

  const rows = games
    .map(
      (game) => `<tr>
  <td class="num">${game.boardSize}×${game.boardSize}</td>
  <td>${proposalKind(game)}</td>
  <td>${escapeHtml(game.proposer.displayName)}</td>
  <td>${game.imported ? '<span class="tag">imported</span>' : '<span class="dim">empty board</span>'}</td>
  <td>${gameActions(game, 'find')}</td>
</tr>`,
    )
    .join('');

  const results =
    games.length === 0
      ? `<p class="lede">${
          filtered
            ? 'No proposals match those filters. Try widening them.'
            : 'Nobody is waiting for an opponent right now. Propose a game and someone can join it.'
        }</p>`
      : `<div class="table-scroll">
    <table class="data">
      <thead><tr><th>Board</th><th>Kind</th><th>Proposed by</th><th>Started from</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;

  const body = `
<h1>Find a game</h1>
<p class="lede">Games you can take up: every open proposal, plus any invitation addressed to you. Invitations to other players stay private.</p>
${error}
<form class="panel" method="get" action="/games/find">
  <div class="field-grid">
    <div class="field">
      <label for="board_size">Board</label>
      <select id="board_size" name="board_size">
        <option value=""${selected(filters.boardSize, '')}>any</option>
        <option value="5"${selected(filters.boardSize, '5')}>5×5</option>
        <option value="6"${selected(filters.boardSize, '6')}>6×6</option>
      </select>
    </div>
    <div class="field">
      <label for="join_type">Kind</label>
      <select id="join_type" name="join_type">
        <option value=""${selected(filters.joinType, '')}>any</option>
        <option value="open"${selected(filters.joinType, 'open')}>open to anyone</option>
        <option value="invited"${selected(filters.joinType, 'invited')}>invitations to me</option>
      </select>
    </div>
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
  return renderShell('Find a game', body, { user, path: '/games/find' });
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
