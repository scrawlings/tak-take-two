import { breadcrumb, escapeHtml, renderShell } from './html.js';
import type { SessionUser } from './auth.js';
import type { ExportFormat, GameExport, GameSummary, GameView } from './games.js';
import type { StoneKind } from '@tak/core';

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
  // listMyGames only ever returns 'finished' rows that are admin-removed
  // (ACTIVE_STATES excludes 'finished' otherwise), so that is the only
  // 'finished' case this ever needs to render.
  if (game.adminRemoved) return '<span class="tag tag-flag">removed by an admin</span>';
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
    game.state === 'in_play'
      ? `<a class="btn btn-sm" href="/games/${game.id}">Open</a>`
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

/** A page for a game the viewer cannot see or that no longer exists. */
export function renderNotFoundPage(): string {
  return `<div class="narrow">
  <h1>Not found</h1>
  <p class="lede">There is no game here — it may have been deleted, or it is not shared with you.</p>
  <p class="actions"><a class="btn btn-quiet" href="/games">Your games</a></p>
</div>`;
}

/** The board glyph for one stone. P1 fills; P2 outlines. */
function stoneGlyph(player: 1 | 2, kind: StoneKind): string {
  if (kind === 'flat') return player === 1 ? '●' : '○';
  if (kind === 'standing') return player === 1 ? '▲' : '△';
  return player === 1 ? '■' : '□';
}

function playerColor(seat: 1 | 2): string {
  return seat === 1 ? '●' : '○';
}

export interface GameViewPageView {
  error?: string;
}

/** Register the board's click builder as an Alpine component. */
const TAK_BOARD_SCRIPT = `<script>
document.addEventListener('alpine:init', () => {
  Alpine.data('takBoard', (config) => ({
    move: '', stone: 'flat', source: null,
    canMove: config.canMove, viewerSeat: config.viewerSeat, size: config.size, selfPlay: config.selfPlay,
    cellClick(el) {
      if (!this.canMove) return;
      const sq = el.dataset.square;
      const height = Number(el.dataset.height);
      const top = el.dataset.top;
      const mine = top !== '' && (this.selfPlay || top[0] === String(this.viewerSeat));
      if (this.source === null) {
        if (height === 0) {
          const prefix = this.stone === 'standing' ? 'S' : this.stone === 'capstone' ? 'C' : '';
          this.move = prefix + sq;
        } else if (mine) {
          this.source = { sq, height };
        }
        return;
      }
      if (this.source.sq === sq) { this.source = null; return; }
      const sf = this.source.sq[0], sr = Number(this.source.sq[1]);
      const df = sq[0], dr = Number(sq[1]);
      if (sf !== df && sr !== dr) return;
      let dir, dist;
      if (sf === df) { dir = dr > sr ? '+' : '-'; dist = Math.abs(dr - sr); }
      else { dir = df > sf ? '>' : '<'; dist = Math.abs(df.charCodeAt(0) - sf.charCodeAt(0)); }
      const lift = Math.min(this.source.height, this.size);
      if (lift < dist) return;
      const drops = new Array(dist).fill(1);
      drops[dist - 1] = lift - (dist - 1);
      this.move = lift + this.source.sq + dir + drops.join('');
      this.source = null;
    }
  }));
});
</script>`;

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
        const height = cell.stack.length > 1 ? `<span class="cell-height">${cell.stack.length}</span>` : '';
        const stackTip =
          cell.stack.length === 0
            ? ''
            : `<span class="stack-tip">${[...cell.stack]
                .reverse()
                .map((s) => `<span>${stoneGlyph(s.player, s.kind)}</span>`)
                .join('')}</span>`;
        return `<button type="button" class="cell" data-square="${cell.file}${cell.rank}" data-height="${cell.stack.length}" data-top="${topAttr}" x-on:click="cellClick($el)" :class="{ 'is-source': source !== null && source.sq === '${cell.file}${cell.rank}' }" aria-label="${cell.file}${cell.rank}">${glyph}${height}${stackTip}</button>`;
      })
      .join('');
    rows.push(`<span class="axis">${rank}</span>${cells}`);
  }
  return `<div class="board" style="grid-template-columns: auto repeat(${game.boardSize}, 2.75rem)">${top}${rows.join('')}</div>`;
}

function renderGameStatus(game: GameView): string {
  if (game.adminRemoved) {
    return `<p class="notice">This game was removed by an admin.</p>`;
  }
  if (game.state === 'proposed') {
    return `<p class="lede">Proposed by ${escapeHtml(game.proposer.displayName)}${game.imported ? ', starting from an imported record' : ''}. Waiting for an opponent.</p>`;
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
    const other = seat === 1 ? 'open' : 'filled';
    const turn = game.opened[seat]
      ? `${colour} to move.`
      : `${colour}'s opening places an ${other} stone.`;
    return `<p class="lede">Self-play — ${escapeHtml(game.proposer.displayName)}. ${youPlay}${turn}</p>`;
  }

  const youPlay =
    game.viewerSeat === null
      ? ''
      : `You play ${playerColor(game.viewerSeat)} (${game.viewerSeat === 1 ? 'filled' : 'open'}). `;
  let turn: string;
  if (game.canMove && game.viewerSeat !== null && !game.opened[game.viewerSeat]) {
    // The opening move places an opponent stone, so the player's first turn is
    // played in the other colour.
    const placing = game.viewerSeat === 1 ? 'open' : 'filled';
    turn = `Your turn — your opening move places your opponent's stone (${placing}).`;
  } else if (game.canMove) {
    turn = 'Your turn.';
  } else {
    turn = `${game.toMove ? escapeHtml(game.toMove.displayName) : '—'} to move.`;
  }
  return `<p class="lede">${escapeHtml(game.proposer.displayName)} vs ${escapeHtml(game.opponent?.displayName ?? '—')}. ${youPlay}${turn}</p>`;
}

function renderGameControls(game: GameView): string {
  if (game.state === 'finished') return '';
  const parts: string[] = [];

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
  } else if (game.canMove) {
    // The picker shows the glyph of the stone the viewer is about to place: in
    // self-play the colour to move; otherwise the viewer's own colour, except
    // on the opening move, which places an opponent's stone (CONTEXT.md: Place).
    const viewer = game.viewerSeat ?? 1;
    const placing: 1 | 2 = game.selfPlay
      ? game.toMoveSeat ?? viewer
      : game.opened[viewer]
        ? viewer
        : viewer === 1 ? 2 : 1;
    const stoneButtons = (['flat', 'standing', 'capstone'] as const)
      .map(
        (kind) => `<button type="button" class="stone-btn" x-on:click="stone = '${kind}'" :class="{ 'is-selected': stone === '${kind}' }" :aria-pressed="stone === '${kind}'" aria-label="Place a ${kind} stone"><span class="stone-glyph">${stoneGlyph(placing, kind)}</span><span class="stone-btn-name">${kind}</span></button>`,
      )
      .join('');
    parts.push(`
<form class="panel" method="post" action="/games/${game.id}/move">
  <div class="field">
    <label for="move">Your move</label>
    <input id="move" name="move" x-model="move" placeholder="a1, Sa1, or 5b4&gt;212" autocomplete="off" spellcheck="false">
    <p class="hint">Type Portable Tak Notation, or build it by clicking the board above.</p>
  </div>
  <div class="field">
    <span class="label" id="stone-label">Stone to place</span>
    <div class="stone-picker" role="group" aria-labelledby="stone-label">
      ${stoneButtons}
    </div>
    <p class="hint" x-show="source !== null">Moving from <span x-text="source ? source.sq : ''"></span> — click a square in a straight line, or the source again to cancel.</p>
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
  const lines: string[] = [];
  for (let i = 0; i < game.moves.length; i += 2) {
    const turn = i / 2 + 1;
    const cell = (m: GameView['moves'][number]): string =>
      `<span class="mono">${escapeHtml(m.notation)}</span> <span class="dim">${escapeHtml(m.player.displayName)}</span> ${exportLinks(game.id, m.number)}`;
    const second = game.moves[i + 1];
    lines.push(`<li><span class="mono">${turn}.</span> ${cell(game.moves[i]!)}${second ? ` ${cell(second)}` : ''}</li>`);
  }
  const imported = game.moves.some((m) => m.imported);
  const note = imported ? '<p class="hint">Imported moves are fixed history.</p>' : '';
  return `<div class="block"><h2>Moves</h2><ol class="moves">${lines.join('')}</ol>${note}${whole}</div>`;
}

function renderLegend(): string {
  return `<p class="hint">● flat (filled) · ○ flat (open) · ▲ wall · ■ capstone — hover a square to read its stack.</p>`;
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
        <tr><td>${label(1, game.proposer.displayName)}</td><td>● filled</td><td class="num">●▲ ${p1.stones}</td><td class="num">■ ${p1.capstones}</td></tr>
        <tr><td>${label(2, game.opponent?.displayName ?? 'Opponent')}</td><td>○ open</td><td class="num">○△ ${p2.stones}</td><td class="num">□ ${p2.capstones}</td></tr>
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
      `<form method="post" action="/games/${game.id}/hide"><button type="submit" class="btn btn-quiet btn-sm">Hide from my games</button></form>`,
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

export function renderGamePage(user: SessionUser, game: GameView, view: GameViewPageView = {}): string {
  const error = view.error ? `<p class="error">${escapeHtml(view.error)}</p>` : '';
  const body = `
${breadcrumb({ href: '/games', label: 'Games' }, `Game ${game.id}`)}
<h1>Game ${game.id}</h1>
${renderGameStatus(game)}
${error}
${renderLegend()}
${TAK_BOARD_SCRIPT}
<div x-data="takBoard(${escapeHtml(JSON.stringify({ canMove: game.canMove, viewerSeat: game.viewerSeat, size: game.boardSize, selfPlay: game.selfPlay }))})" x-cloak>
  ${renderBoard(game)}
  ${renderGameControls(game)}
</div>
${renderGameManagement(game)}
${renderReserves(game)}
${renderHistory(game)}
${renderMoveSyntax()}`;
  return renderShell(`Game ${game.id}`, body, { user, path: '/games' });
}

/** Register the copy button as an Alpine component, as the board does. */
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
  return renderShell(`${view.format.toUpperCase()} — game ${gameId}`, body, { user, path: '/games' });
}
