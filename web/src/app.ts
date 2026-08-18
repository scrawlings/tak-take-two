import { Hono, type Context } from 'hono';
import { routePath } from 'hono/route';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { err } from 'neverthrow';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Persistence, PersistenceSnapshot } from './persistence.js';
import { Metrics } from './metrics.js';
import type { Logger } from './logging.js';
import { newRequestId } from './logging.js';
import { escapeHtml, renderShell, siteCss } from './html.js';
import { createAuth, type Auth, type AuthError, type SessionUser } from './auth.js';
import { createFormAction, statusForAuthError } from './forms.js';
import {
  renderAccountPage,
  renderAdminUsersPage,
  renderChangeDisplayNamePage,
  renderChangePasswordPage,
  renderLoginPage,
  renderResetPasswordResult,
  renderRoot,
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
    .map(([key, value]) => `<tr><td class="key">${escapeHtml(key)}</td><td class="num">${escapeHtml(value)}</td></tr>`)
    .join('');
  return `<h1>Status</h1>
<p class="lede">Live figures for this server. The same numbers are available to Prometheus at <span class="mono">/metrics</span>.</p>
<div class="table-scroll">
  <table class="data">
    <thead><tr><th>Measure</th><th>Value</th></tr></thead>
    <tbody>${body}</tbody>
  </table>
</div>`;
}

/** A form field coerced to a string, or null when absent/non-textual. */
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

  /**
   * The signed-in user, or undefined, without redirecting. Public pages use it
   * to draw the right masthead; it grants no access on its own.
   */
  const navUser = (c: Context<{ Variables: Variables }>): SessionUser | undefined => {
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (!sessionId) return undefined;
    const result = auth.getSessionUser(sessionId);
    return result.isOk() && !result.value.blocked ? result.value : undefined;
  };

  const forbiddenPage = (c: Context<{ Variables: Variables }>): Response =>
    c.html(
      renderShell(
        'Forbidden',
        `<div class="narrow">
  <h1>Forbidden</h1>
  <p class="lede">This page is for admins. Your account can't open it.</p>
  <p class="actions"><a class="btn btn-quiet" href="/account">Go to your account</a></p>
</div>`,
        { user: navUser(c) },
      ),
      403,
    );

  const adminUsersPage = (
    c: Context<{ Variables: Variables }>,
    actor: SessionUser,
    view?: { error?: string; message?: string },
    status: ContentfulStatusCode = 200,
  ): Response => {
    const list = auth.listUsers(actor);
    if (list.isErr()) {
      if (list.error.code === 'forbidden') return forbiddenPage(c);
      logger.log('error', 'failed to list users', { error: list.error });
      return c.json({ error: 'Internal Server Error' }, 500);
    }
    return c.html(renderAdminUsersPage(actor, list.value, view), status);
  };

  /** Shared error rendering for admin forms: forbidden → 403, else the list at the mapped status. */
  const adminFormError = (c: Context<{ Variables: Variables }>, error: AuthError): Response => {
    if (error.code === 'forbidden') return forbiddenPage(c);
    return adminUsersPage(c, c.get('user'), { error: error.message }, statusForAuthError(error));
  };

  const formAction = createFormAction<{ Variables: Variables }>(logger);

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

  app.get('/site.css', (c) =>
    c.text(siteCss(), 200, { 'content-type': 'text/css; charset=utf-8' }),
  );

  app.get('/status', (c) => {
    return c.html(
      renderShell('Status', renderStatusPage(persistence.metricsSnapshot(), metrics.httpErrors()), {
        user: navUser(c),
        path: '/status',
      }),
    );
  });

  app.get('/', (c) => c.html(renderRoot(navUser(c))));

  app.get('/login', (c) => {
    const message = c.req.query('changed') ? 'Password changed — sign in again.' : undefined;
    return c.html(renderLoginPage({ message }));
  });

  app.post('/login', formAction({
    fields: ['username', 'password'],
    run: (c, f) =>
      auth.applyAuth(null, { type: 'login', username: f.username ?? '', password: f.password ?? '' }),
    onOk: (c, r) => {
      if (r.type !== 'login') {
        logger.log('error', 'unexpected login result', { result: r });
        return c.json({ error: 'Internal Server Error' }, 500);
      }
      setSessionCookie(c, r.sessionId);
      return c.redirect('/account', 303);
    },
    renderError: (c, e) =>
      c.html(
        renderLoginPage({
          error: e.code === 'user-blocked' ? 'This account is blocked.' : 'Unknown username or password.',
        }),
        statusForAuthError(e),
      ),
  }));

  app.get('/account', requireUser, (c) => {
    return c.html(renderAccountPage(c.get('user')));
  });

  app.get('/account/password', requireUser, (c) => {
    return c.html(renderChangePasswordPage(c.get('user'), { forced: c.get('user').forcePasswordChange }));
  });

  app.post('/account/password', requireUser, formAction({
    fields: ['old_password', 'new_password'],
    run: (c, f) => {
      const user = c.get('user');
      return auth.applyAuth(c.get('user'), {
        type: 'changePassword',
        userId: user.id,
        oldPassword: f.old_password ?? '',
        newPassword: f.new_password ?? '',
      });
    },
    onOk: (c) => {
      // All sessions (including this one) were invalidated; sign in again.
      clearSessionCookie(c);
      return c.redirect('/login?changed=1', 303);
    },
    renderError: (c, e) =>
      c.html(
        renderChangePasswordPage(c.get('user'), { forced: c.get('user').forcePasswordChange, error: e.message }),
        statusForAuthError(e),
      ),
  }));

  app.post('/logout', requireUser, async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (sessionId) {
      const result = await auth.applyAuth(c.get('user'), { type: 'logout', sessionId });
      if (result.isErr()) logger.log('error', 'logout failed', { error: result.error });
    }
    clearSessionCookie(c);
    return c.redirect('/login', 303);
  });

  app.get('/account/display-name', requireUser, (c) => {
    return c.html(renderChangeDisplayNamePage(c.get('user')));
  });

  app.post('/account/display-name', requireUser, formAction({
    fields: ['display_name'],
    run: (c, f) => auth.applyAuth(c.get('user'), { type: 'changeDisplayName', displayName: f.display_name ?? '' }),
    onOk: (c) => c.redirect('/account', 303),
    renderError: (c, e) =>
      c.html(renderChangeDisplayNamePage(c.get('user'), { error: e.message }), statusForAuthError(e)),
  }));

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

  app.post('/admin/users', requireUser, formAction({
    fields: ['username', 'password', 'display_name', 'role'],
    run: (c, f) =>
      auth.applyAuth(c.get('user'), {
        type: 'createUser',
        username: f.username ?? '',
        password: f.password ?? '',
        displayName: f.display_name ?? undefined,
        role: f.role === 'admin' ? 'admin' : 'player',
      }),
    onOk: (c) => c.redirect('/admin/users', 303),
    renderError: adminFormError,
  }));

  app.post('/admin/users/:id/block', requireUser, formAction({
    fields: [],
    run: (c) => {
      const id = userIdFrom(c);
      if (id === null) return Promise.resolve(err({ code: 'not-found', message: 'Unknown user.' }));
      return auth.applyAuth(c.get('user'), { type: 'blockUser', userId: id });
    },
    onOk: (c) => c.redirect('/admin/users', 303),
    renderError: adminFormError,
  }));

  app.post('/admin/users/:id/unblock', requireUser, formAction({
    fields: [],
    run: (c) => {
      const id = userIdFrom(c);
      if (id === null) return Promise.resolve(err({ code: 'not-found', message: 'Unknown user.' }));
      return auth.applyAuth(c.get('user'), { type: 'unblockUser', userId: id });
    },
    onOk: (c) => c.redirect('/admin/users', 303),
    renderError: adminFormError,
  }));

  app.post('/admin/users/:id/force-password-change', requireUser, formAction({
    fields: [],
    run: (c) => {
      const id = userIdFrom(c);
      if (id === null) return Promise.resolve(err({ code: 'not-found', message: 'Unknown user.' }));
      return auth.applyAuth(c.get('user'), { type: 'forcePasswordChange', userId: id });
    },
    onOk: (c) => c.redirect('/admin/users', 303),
    renderError: adminFormError,
  }));

  app.post('/admin/users/:id/reset-password', requireUser, formAction({
    fields: [],
    run: (c) => {
      const id = userIdFrom(c);
      if (id === null) return Promise.resolve(err({ code: 'not-found', message: 'Unknown user.' }));
      return auth.applyAuth(c.get('user'), { type: 'resetPassword', userId: id });
    },
    onOk: (c, r) => {
      if (r.type !== 'resetPassword') {
        logger.log('error', 'unexpected reset result', { result: r });
        return c.json({ error: 'Internal Server Error' }, 500);
      }
      return c.html(renderResetPasswordResult(c.get('user'), r.username, r.password));
    },
    renderError: adminFormError,
  }));

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
