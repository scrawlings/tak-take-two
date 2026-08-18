import { breadcrumb, escapeHtml, renderShell } from './html.js';
import type { SessionUser } from './auth.js';

/**
 * Server-rendered auth/admin views. Keep the markup thin: these pages only
 * prove the auth seam; ticket 09–11 build the real game views on top.
 */

const ACCOUNT = { href: '/account', label: 'Account' };
const USERS = { href: '/admin/users', label: 'Users' };

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
