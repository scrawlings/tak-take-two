import { escapeHtml, renderShell } from './html.js';
import type { SessionUser } from './auth.js';

/**
 * Server-rendered auth/admin views. Keep the markup thin: these pages only
 * prove the auth seam; ticket 09–11 build the real game views on top.
 */

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
<h1>Sign in</h1>
${notice}
<form method="post" action="/login">
  <p>
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" required>
  </p>
  <p>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
  </p>
  <p><button type="submit">Sign in</button></p>
</form>`;
  return renderShell('Sign in', body);
}

export function renderAccountPage(user: SessionUser): string {
  const body = `
<h1>Account</h1>
<p>Signed in as <strong>${escapeHtml(user.displayName)}</strong> (${escapeHtml(user.username)}).</p>
<ul>
  <li><a href="/account/password">Change password</a></li>
  <li><a href="/account/display-name">Change display name</a></li>
</ul>
<form method="post" action="/logout"><button type="submit">Sign out</button></form>`;
  return renderShell('Account', body);
}

export interface ChangePasswordView {
  forced: boolean;
  error?: string;
}

export function renderChangePasswordPage(view: ChangePasswordView): string {
  const notice = view.forced
    ? `<p class="notice">You must choose a new password before continuing.</p>`
    : '';
  const error = view.error ? `<p class="error">${escapeHtml(view.error)}</p>` : '';
  const body = `
<h1>Change password</h1>
${notice}
${error}
<form method="post" action="/account/password">
  <p>
    <label for="old_password">Current password</label>
    <input id="old_password" name="old_password" type="password" autocomplete="current-password" required>
  </p>
  <p>
    <label for="new_password">New password</label>
    <input id="new_password" name="new_password" type="password" autocomplete="new-password" required>
  </p>
  <p><button type="submit">Change password</button></p>
</form>`;
  return renderShell('Change password', body);
}

export interface ChangeDisplayNameView {
  error?: string;
}

export function renderChangeDisplayNamePage(user: SessionUser, view: ChangeDisplayNameView = {}): string {
  const error = view.error ? `<p class="error">${escapeHtml(view.error)}</p>` : '';
  const body = `
<h1>Change display name</h1>
<p>Current display name: <strong>${escapeHtml(user.displayName)}</strong>. Your username (${escapeHtml(user.username)}) cannot be changed.</p>
${error}
<form method="post" action="/account/display-name">
  <p>
    <label for="display_name">New display name</label>
    <input id="display_name" name="display_name" value="${escapeHtml(user.displayName)}" required>
  </p>
  <p><button type="submit">Change display name</button></p>
</form>`;
  return renderShell('Change display name', body);
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
      const status = [u.blocked ? 'blocked' : '', u.forcePasswordChange ? 'password change required' : '']
        .filter(Boolean)
        .join(', ');
      const self = u.id === actor.id;
      const actions = self
        ? `<form method="post" action="/admin/users/${u.id}/force-password-change" style="display:inline"><button type="submit">Force change</button></form>
           <form method="post" action="/admin/users/${u.id}/reset-password" style="display:inline"><button type="submit">Reset password</button></form>`
        : `<form method="post" action="/admin/users/${u.id}/block" style="display:inline"><button type="submit">Block</button></form>
           <form method="post" action="/admin/users/${u.id}/unblock" style="display:inline"><button type="submit">Unblock</button></form>
           <form method="post" action="/admin/users/${u.id}/force-password-change" style="display:inline"><button type="submit">Force change</button></form>
           <form method="post" action="/admin/users/${u.id}/reset-password" style="display:inline"><button type="submit">Reset password</button></form>`;
      return `<tr>
  <td>${escapeHtml(u.username)}</td>
  <td>${escapeHtml(u.displayName)}</td>
  <td>${escapeHtml(u.role)}</td>
  <td>${status ? escapeHtml(status) : '—'}</td>
  <td>${actions}</td>
</tr>`;
    })
    .join('');

  const body = `
<h1>Admin — users</h1>
${notice}
<h2>Create user</h2>
<form method="post" action="/admin/users">
  <p>
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="off" required>
  </p>
  <p>
    <label for="password">Initial password</label>
    <input id="password" name="password" type="text" autocomplete="off" required>
  </p>
  <p>
    <label for="display_name">Display name (defaults to username)</label>
    <input id="display_name" name="display_name" autocomplete="off">
  </p>
  <p>
    <label for="role">Role</label>
    <select id="role" name="role">
      <option value="player">player</option>
      <option value="admin">admin</option>
    </select>
  </p>
  <p><button type="submit">Create user</button></p>
</form>
<h2>Users</h2>
<table border="1" cellpadding="6">
  <thead><tr><th>Username</th><th>Display name</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<p><a href="/account">Back to account</a></p>`;
  return renderShell('Admin — users', body);
}

export function renderResetPasswordResult(username: string, password: string): string {
  const body = `
<h1>Password reset</h1>
<p>New password for <strong>${escapeHtml(username)}</strong>:</p>
<pre><code id="reset-password">${escapeHtml(password)}</code></pre>
<p>Communicate it to the user out of band. It forces a password change on next sign-in.</p>
<p><a href="/admin/users">Back to users</a></p>`;
  return renderShell('Password reset', body);
}
