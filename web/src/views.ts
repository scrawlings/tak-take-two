import { escapeHtml, renderShell, boardMark, type ShellUser } from './html.js';
import type { SessionUser } from './auth.js';

/**
 * Server-rendered auth/admin views. Keep the markup thin: these pages only
 * prove the auth seam; ticket 09–11 build the real game views on top.
 */

function shellUser(user: SessionUser): ShellUser {
  return { displayName: user.displayName, username: user.username, role: user.role };
}

export interface LoginView {
  error?: string;
  message?: string;
}

export function renderRoot() {
  const content = `<p class="eyebrow">/</p>
<section class="hero">
  ${boardMark({ hero: true })}
  <h1>The game of the road and the stone.</h1>
  <p class="lede">A Tak server. Propose games, join open tables, and keep every move in Portable Tak Notation — a whole game, or a single position, in one line.</p>
  <div class="hero-actions">
    <a class="btn btn--primary" href="/login">sign in</a>
    <a class="btn btn--ghost" href="/status">status</a>
  </div>
</section>
<section class="section">
  <h2>On the table</h2>
  <a class="link-tile" href="/account"><span><span class="t">Account</span> <span class="d">— your display name, password, and sessions</span></span><span class="go">→</span></a>
  <a class="link-tile" href="/admin/users"><span><span class="t">Admin</span> <span class="d">— create and manage player accounts</span></span><span class="go">→</span></a>
  <a class="link-tile" href="/status"><span><span class="t">Status</span> <span class="d">— sessions, games, and database vitals</span></span><span class="go">→</span></a>
</section>`;
  return renderShell('Tak', content);
}

export function renderLoginPage(view: LoginView = {}): string {
  const notice = view.message
    ? `<p class="ok">${escapeHtml(view.message)}</p>`
    : view.error
      ? `<p class="error">${escapeHtml(view.error)}</p>`
      : '';
  const body = `
<div class="narrow">
  <p class="eyebrow">/login</p>
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
    <p class="form-actions"><button type="submit" class="btn btn--primary">Sign in</button></p>
  </form>
  <p class="form-note">Forgot your password? Ask an admin to reset it.</p>
</div>`;
  return renderShell('Sign in', body);
}

export function renderAccountPage(user: SessionUser): string {
  const body = `
<p class="eyebrow">/account</p>
<h1>Account</h1>
<p class="who-iam">
  <i class="stone stone--light" aria-hidden="true"></i>
  <span class="name">${escapeHtml(user.displayName)}</span>
  <span class="handle">@${escapeHtml(user.username)}</span>
</p>
<a class="link-tile" href="/account/password"><span><span class="t">Change password</span> <span class="d">— keep your credentials fresh</span></span><span class="go">→</span></a>
<a class="link-tile" href="/account/display-name"><span><span class="t">Change display name</span> <span class="d">— what other players see</span></span><span class="go">→</span></a>
<form method="post" action="/logout" class="form-actions"><button type="submit" class="btn btn--ghost">Sign out</button></form>`;
  return renderShell('Account', body, shellUser(user));
}

export interface ChangePasswordView {
  forced: boolean;
  error?: string;
}

export function renderChangePasswordPage(user: SessionUser, view: ChangePasswordView): string {
  const notice = view.forced
    ? `<p class="notice">You must choose a new password before continuing.</p>`
    : '';
  const error = view.error ? `<p class="error">${escapeHtml(view.error)}</p>` : '';
  const body = `
<p class="eyebrow">/account/password</p>
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
  <p class="form-actions"><button type="submit" class="btn btn--primary">Change password</button></p>
</form>
<p><a href="/account">Back to account</a></p>`;
  return renderShell('Change password', body, shellUser(user));
}

export interface ChangeDisplayNameView {
  error?: string;
}

export function renderChangeDisplayNamePage(user: SessionUser, view: ChangeDisplayNameView = {}): string {
  const error = view.error ? `<p class="error">${escapeHtml(view.error)}</p>` : '';
  const body = `
<p class="eyebrow">/account/display-name</p>
<h1>Change display name</h1>
<p class="lede">Current display name: <strong>${escapeHtml(user.displayName)}</strong>. Your username (${escapeHtml(user.username)}) cannot be changed.</p>
${error}
<form class="panel" method="post" action="/account/display-name">
  <div class="field">
    <label for="display_name">New display name</label>
    <input id="display_name" name="display_name" value="${escapeHtml(user.displayName)}" autocomplete="nickname" required>
  </div>
  <p class="form-actions"><button type="submit" class="btn btn--primary">Change display name</button></p>
</form>
<p><a href="/account">Back to account</a></p>`;
  return renderShell('Change display name', body, shellUser(user));
}

export interface AdminUsersView {
  error?: string;
  message?: string;
}

export function renderAdminUsersPage(actor: SessionUser, users: readonly SessionUser[], view: AdminUsersView = {}): string {
  const notice = view.message
    ? `<p class="ok">${escapeHtml(view.message)}</p>`
    : view.error
      ? `<p class="error">${escapeHtml(view.error)}</p>`
      : '';

  const rows = users
    .map((u) => {
      const self = u.id === actor.id;
      const stone = `<i class="stone ${u.blocked ? 'stone--off' : 'stone--light'}" aria-hidden="true"></i>`;
      const chips = [
        u.blocked ? '<span class="chip chip--blocked">blocked</span>' : '',
        u.forcePasswordChange ? '<span class="chip chip--warn">password change required</span>' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const status = chips ? `${stone} ${chips}` : `<span class="dim">${stone} —</span>`;

      const actions = self
        ? `<form method="post" action="/admin/users/${u.id}/force-password-change"><button type="submit" class="btn btn--sm btn--ghost">force change</button></form>
           <form method="post" action="/admin/users/${u.id}/reset-password"><button type="submit" class="btn btn--sm btn--primary">reset password</button></form>`
        : `<form method="post" action="/admin/users/${u.id}/block"><button type="submit" class="btn btn--sm btn--danger">block</button></form>
           <form method="post" action="/admin/users/${u.id}/unblock"><button type="submit" class="btn btn--sm btn--ghost">unblock</button></form>
           <form method="post" action="/admin/users/${u.id}/force-password-change"><button type="submit" class="btn btn--sm btn--ghost">force change</button></form>
           <form method="post" action="/admin/users/${u.id}/reset-password"><button type="submit" class="btn btn--sm btn--primary">reset password</button></form>`;
      return `<tr>
  <td class="u">${escapeHtml(u.username)}</td>
  <td>${escapeHtml(u.displayName)}</td>
  <td><span class="chip">${escapeHtml(u.role)}</span></td>
  <td>${status}</td>
  <td><div class="actions">${actions}</div></td>
</tr>`;
    })
    .join('');

  const body = `
<p class="eyebrow">/admin/users</p>
<h1>Users</h1>
${notice}
<section class="section">
  <h2>Create user</h2>
  <form class="panel" method="post" action="/admin/users">
    <div class="form-grid">
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
    <p class="form-actions"><button type="submit" class="btn btn--primary">Create user</button></p>
    <p class="form-note">Display name defaults to the username.</p>
  </form>
</section>
<section class="section">
  <h2>Players</h2>
  <div class="table-scroll">
    <table class="data">
      <thead><tr><th>Username</th><th>Display name</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</section>
<p><a href="/account">Back to account</a></p>`;
  return renderShell('Admin — users', body, shellUser(actor));
}

export function renderResetPasswordResult(username: string, password: string): string {
  const body = `
<p class="eyebrow">/admin/users</p>
<h1>Password reset</h1>
<p class="lede">New password for <strong>${escapeHtml(username)}</strong>:</p>
<div class="secret"><code id="reset-password">${escapeHtml(password)}</code></div>
<p>Communicate it to the user out of band. It forces a password change on next sign-in.</p>
<p><a href="/admin/users">Back to users</a></p>`;
  return renderShell('Password reset', body);
}
