import { Hono, type Context } from 'hono';
import { routePath } from 'hono/route';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { Persistence, PersistenceSnapshot } from './persistence.js';
import { Metrics } from './metrics.js';
import type { Logger } from './logging.js';
import { newRequestId } from './logging.js';
import { escapeHtml, renderShell } from './html.js';
import { createAuth, type Auth, type AuthError, type SessionUser } from './auth.js';
import {
  renderAccountPage,
  renderAdminUsersPage,
  renderChangeDisplayNamePage,
  renderChangePasswordPage,
  renderLoginPage,
  renderResetPasswordResult,
} from './views.js';

export interface AppDeps {
  persistence: Persistence;
  metrics: Metrics;
  logger: Logger;
  /** Mark the session cookie Secure. True when TLS terminates at this process. */
  secureCookies?: boolean;
}

type Variables = {
  requestId: string;
  user: SessionUser;
};

export type App = Hono<{ Variables: Variables }>;

const SESSION_COOKIE = 'tak_session';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function renderStatusPage(snapshot: PersistenceSnapshot, httpErrors: number): string {
  const rows: Array<[string, string]> = [
    ['active sessions', String(snapshot.activeSessions)],
    ['http errors', String(httpErrors)],
    ['database size (bytes)', String(snapshot.databaseSizeBytes)],
  ];
  for (const entry of snapshot.gamesByState) {
    rows.push([`games in state "${entry.state}"`, String(entry.count)]);
  }
  const body = rows
    .map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`)
    .join('');
  return `<h1>Status</h1><table border="1" cellpadding="6">${body}</table>`;
}

/** A form field coerced to a string, or null when absent/non-textual. */
function formField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function createApp(deps: AppDeps): App {
  const { persistence, metrics, logger } = deps;
  const secureCookies = deps.secureCookies ?? false;
  const auth: Auth = createAuth(persistence);
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? newRequestId();
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);
    const start = Date.now();
    await next();
    const durationMs = Date.now() - start;
    const status = c.res.status;
    const route = routePath(c) ?? 'unmatched';
    metrics.observeHttp(c.req.method, route, status, durationMs);
    logger.log('info', 'request', {
      requestId,
      method: c.req.method,
      path: c.req.path,
      route,
      status,
      durationMs,
    });
  });

  const setSessionCookie = (c: Context<{ Variables: Variables }>, sessionId: string): void => {
    setCookie(c, SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: secureCookies,
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
  };
  const clearSessionCookie = (c: Context<{ Variables: Variables }>): void => {
    deleteCookie(c, SESSION_COOKIE, { httpOnly: true, sameSite: 'Lax', path: '/', secure: secureCookies });
  };

  const requireUser = createMiddleware<{ Variables: Variables }>(async (c, next) => {
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (!sessionId) return c.redirect('/login', 303);

    const result = auth.getSessionUser(sessionId);
    if (result.isErr()) {
      if (result.error.code === 'not-authenticated') return c.redirect('/login', 303);
      logger.log('error', 'auth lookup failed', { error: result.error });
      return c.json({ error: 'Internal Server Error' }, 500);
    }

    const user = result.value;
    if (user.blocked) return c.redirect('/login?error=blocked', 303);
    if (user.forcePasswordChange && !isForceChangeExempt(c.req.method, c.req.path)) {
      return c.redirect('/account/password', 303);
    }

    c.set('user', user);
    await next();
  });

  const forbiddenPage = (c: Context<{ Variables: Variables }>): Response =>
    c.html(renderShell('Forbidden', '<h1>Forbidden</h1><p>Admin only.</p>'), 403);

  const adminUsersPage = (
    c: Context<{ Variables: Variables }>,
    actor: SessionUser,
    view?: { error?: string; message?: string },
    status: 200 | 400 | 404 = 200,
  ): Response => {
    const list = auth.listUsers(actor);
    if (list.isErr()) {
      if (list.error.code === 'forbidden') return forbiddenPage(c);
      logger.log('error', 'failed to list users', { error: list.error });
      return c.json({ error: 'Internal Server Error' }, 500);
    }
    return c.html(renderAdminUsersPage(actor, list.value, view), status);
  };

  const handleAdminActionError = (
    c: Context<{ Variables: Variables }>,
    actor: SessionUser,
    error: AuthError,
  ): Response => {
    if (error.code === 'forbidden') return forbiddenPage(c);
    if (error.code === 'persistence') {
      logger.log('error', 'admin action failed', { error });
      return c.json({ error: 'Internal Server Error' }, 500);
    }
    return adminUsersPage(c, actor, { error: error.message }, 400);
  };

  const userIdFrom = (c: Context<{ Variables: Variables }>): number | null => {
    const id = Number(c.req.param('id'));
    return Number.isInteger(id) && id >= 1 ? id : null;
  };

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.get('/readyz', (c) => {
    const result = persistence.ping();
    if (result.isErr()) {
      return c.json({ status: 'unavailable', db: 'error' }, 503);
    }
    return c.json({ status: 'ok', db: 'ok' });
  });

  app.get('/metrics', (c) => {
    return c.text(metrics.render(persistence.metricsSnapshot()), 200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    });
  });

  app.get('/status', (c) => {
    return c.html(renderShell('Status', renderStatusPage(persistence.metricsSnapshot(), metrics.httpErrors())));
  });

  app.get('/', (c) => c.html(renderShell('Tak', '<h1>Tak</h1><p>The game hosting site.</p>')));

  app.get('/login', (c) => {
    const message = c.req.query('changed') ? 'Password changed — sign in again.' : undefined;
    return c.html(renderLoginPage({ message }));
  });

  app.post('/login', async (c) => {
    const body = await c.req.parseBody();
    const username = formField(body.username);
    const password = formField(body.password);
    if (username === null || password === null || username === '' || password === '') {
      return c.html(renderLoginPage({ error: 'Enter a username and password.' }), 400);
    }

    const result = await auth.login(username, password);
    if (result.isErr()) {
      if (result.error.code === 'persistence') {
        logger.log('error', 'login failed', { error: result.error });
        return c.json({ error: 'Internal Server Error' }, 500);
      }
      const message =
        result.error.code === 'user-blocked' ? 'This account is blocked.' : 'Unknown username or password.';
      return c.html(renderLoginPage({ error: message }), 401);
    }

    setSessionCookie(c, result.value.sessionId);
    return c.redirect('/account', 303);
  });

  app.get('/account', requireUser, (c) => {
    return c.html(renderAccountPage(c.get('user')));
  });

  app.get('/account/password', requireUser, (c) => {
    return c.html(renderChangePasswordPage({ forced: c.get('user').forcePasswordChange }));
  });

  app.post('/account/password', requireUser, async (c) => {
    const user = c.get('user');
    const body = await c.req.parseBody();
    const oldPassword = formField(body.old_password);
    const newPassword = formField(body.new_password);
    if (oldPassword === null || newPassword === null || oldPassword === '' || newPassword === '') {
      return c.html(
        renderChangePasswordPage({ forced: user.forcePasswordChange, error: 'Enter both passwords.' }),
        400,
      );
    }

    const result = await auth.changePassword(user.id, oldPassword, newPassword);
    if (result.isErr()) {
      if (result.error.code === 'persistence') {
        logger.log('error', 'password change failed', { error: result.error });
        return c.json({ error: 'Internal Server Error' }, 500);
      }
      return c.html(
        renderChangePasswordPage({ forced: user.forcePasswordChange, error: result.error.message }),
        400,
      );
    }

    // All sessions (including this one) were invalidated; sign in again.
    clearSessionCookie(c);
    return c.redirect('/login?changed=1', 303);
  });

  app.post('/logout', requireUser, (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (sessionId) {
      const result = auth.logout(sessionId);
      if (result.isErr()) logger.log('error', 'logout failed', { error: result.error });
    }
    clearSessionCookie(c);
    return c.redirect('/login', 303);
  });

  app.get('/account/display-name', requireUser, (c) => {
    return c.html(renderChangeDisplayNamePage(c.get('user')));
  });

  app.post('/account/display-name', requireUser, async (c) => {
    const user = c.get('user');
    const body = await c.req.parseBody();
    const displayName = formField(body.display_name) ?? '';

    const result = auth.changeDisplayName(user, displayName);
    if (result.isErr()) {
      if (result.error.code === 'persistence') {
        logger.log('error', 'display name change failed', { error: result.error });
        return c.json({ error: 'Internal Server Error' }, 500);
      }
      return c.html(renderChangeDisplayNamePage(user, { error: result.error.message }), 400);
    }
    return c.redirect('/account', 303);
  });

  app.get('/admin', requireUser, (c) => c.redirect('/admin/users', 303));

  app.get('/admin/users', requireUser, (c) => {
    const user = c.get('user');
    const result = auth.listUsers(user);
    if (result.isErr()) {
      if (result.error.code === 'forbidden') return forbiddenPage(c);
      logger.log('error', 'failed to list users', { error: result.error });
      return c.json({ error: 'Internal Server Error' }, 500);
    }
    return c.html(renderAdminUsersPage(user, result.value));
  });

  app.post('/admin/users', requireUser, async (c) => {
    const actor = c.get('user');
    const body = await c.req.parseBody();
    const username = formField(body.username) ?? '';
    const password = formField(body.password) ?? '';
    const displayName = formField(body.display_name);
    const role = formField(body.role) === 'admin' ? 'admin' : 'player';

    const result = await auth.createUser(actor, {
      username,
      password,
      displayName: displayName ?? undefined,
      role,
    });
    if (result.isErr()) {
      if (result.error.code === 'forbidden') return forbiddenPage(c);
      if (result.error.code === 'persistence') {
        logger.log('error', 'create user failed', { error: result.error });
        return c.json({ error: 'Internal Server Error' }, 500);
      }
      return adminUsersPage(c, actor, { error: result.error.message }, 400);
    }
    return c.redirect('/admin/users', 303);
  });

  app.post('/admin/users/:id/block', requireUser, (c) => {
    const actor = c.get('user');
    const id = userIdFrom(c);
    if (id === null) return adminUsersPage(c, actor, { error: 'Unknown user.' }, 404);
    const result = auth.blockUser(actor, id);
    if (result.isErr()) return handleAdminActionError(c, actor, result.error);
    return c.redirect('/admin/users', 303);
  });

  app.post('/admin/users/:id/unblock', requireUser, (c) => {
    const actor = c.get('user');
    const id = userIdFrom(c);
    if (id === null) return adminUsersPage(c, actor, { error: 'Unknown user.' }, 404);
    const result = auth.unblockUser(actor, id);
    if (result.isErr()) return handleAdminActionError(c, actor, result.error);
    return c.redirect('/admin/users', 303);
  });

  app.post('/admin/users/:id/force-password-change', requireUser, (c) => {
    const actor = c.get('user');
    const id = userIdFrom(c);
    if (id === null) return adminUsersPage(c, actor, { error: 'Unknown user.' }, 404);
    const result = auth.forcePasswordChange(actor, id);
    if (result.isErr()) return handleAdminActionError(c, actor, result.error);
    return c.redirect('/admin/users', 303);
  });

  app.post('/admin/users/:id/reset-password', requireUser, async (c) => {
    const actor = c.get('user');
    const id = userIdFrom(c);
    if (id === null) return adminUsersPage(c, actor, { error: 'Unknown user.' }, 404);
    const result = await auth.resetPassword(actor, id);
    if (result.isErr()) return handleAdminActionError(c, actor, result.error);
    return c.html(renderResetPasswordResult(result.value.username, result.value.password));
  });

  app.notFound((c) => c.json({ error: 'Not Found' }, 404));

  app.onError((err, c) => {
    metrics.incErrors();
    const requestId = c.get('requestId') ?? 'unknown';
    logger.log('error', 'unhandled error', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    c.header('x-request-id', requestId);
    return c.json({ error: 'Internal Server Error' }, 500);
  });

  return app;
}

function isForceChangeExempt(method: string, path: string): boolean {
  return path === '/account/password' || (method === 'POST' && path === '/logout');
}
