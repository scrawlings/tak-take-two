import { Hono, type Context } from 'hono';
import { routePath } from 'hono/route';
import { streamSSE } from 'hono/streaming';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { err, type Result } from 'neverthrow';
import type { Persistence, PersistenceSnapshot } from './persistence.js';
import { Metrics } from './metrics.js';
import type { Logger } from './logging.js';
import { newRequestId } from './logging.js';
import { escapeHtml, renderShell, siteCss } from './html.js';
import { createAuth, type Auth, type AuthError, type SessionUser } from './auth.js';
import { createGames, type GameError, type Games } from './games.js';
import { GAMES_TOPIC, announceGameChanges, createUpdates, gameTopic } from './updates.js';
import {
  createFormAction,
  createPageAction,
  createPageError,
  forbiddenPage,
  paramId,
  statusForAuthError,
  statusForGameError,
} from './actions.js';
import {
  FIND_GAMES_SCHEMA,
  MY_GAMES_SCHEMA,
  matchesBasePath,
  parseQuery,
  parseReturnTo,
  queryString,
} from './list-query.js';
import {
  renderAccountPage,
  renderAdminUsersPage,
  renderChangeDisplayNamePage,
  renderChangePasswordPage,
  renderExportPage,
  renderLoginPage,
  renderFindGamesPage,
  renderAdminGamesPage,
  renderGamePage,
  renderMyGamesPage,
  renderNotFoundPage,
  renderResetPasswordResult,
  renderRoot,
  renderStatusPageBody,
  findGamesRegions,
  gameRegions,
  myGamesRegions,
  type AdminUsersView,
  type FindGamesView,
  type GameViewPageView,
  type MyGamesView,
  type Regions,
} from './views.js';

export interface AppDeps {
  persistence: Persistence;
  metrics: Metrics;
  logger: Logger;
  /** Mark the session cookie Secure. True when TLS terminates at this process. */
  secureCookies?: boolean;
  /**
   * How long an SSE stream waits for a change before sending a keep-alive
   * comment. Injected so tests need not wait on the real one.
   */
  heartbeatMs?: number;
}

type Variables = {
  requestId: string;
  user: SessionUser;
};

export type App = Hono<{ Variables: Variables }>;

const SESSION_COOKIE = 'tak_session';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Long enough to be quiet, short enough that a connection killed silently in
 * the middle is noticed within the minute. Nothing sits between this process
 * and the browser by design (no reverse proxy is assumed), so this is only
 * about the connection itself.
 */
const DEFAULT_HEARTBEAT_MS = 25_000;

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
  return renderStatusPageBody(body);
}

/** A form field coerced to a string, or null when absent/non-textual. */
export function createApp(deps: AppDeps): App {
  const { persistence, metrics, logger } = deps;
  const secureCookies = deps.secureCookies ?? false;
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const auth: Auth = createAuth(persistence);
  const updates = createUpdates();
  // Every successful command wakes the streams watching it. Wrapping the module
  // once is what keeps real-time delivery at the routes, where ADR-0004 put it,
  // rather than inside the module it deliberately kept free of events.
  const games: Games = announceGameChanges(createGames(persistence), updates);
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

  const formAction = createFormAction<{ Variables: Variables }>(logger);
  const pageAction = createPageAction<{ Variables: Variables }>(logger);
  const pageError = createPageError<{ Variables: Variables }>(logger);

  /** A refused auth command is reported on the users list, re-read fresh. */
  const usersError = (c: Context<{ Variables: Variables }>, error: AuthError): Response =>
    pageError(
      c,
      c.get('user'),
      {
        name: 'list users',
        reload: () => auth.listUsers(c.get('user')),
        render: (data, view: AdminUsersView, status) => c.html(renderAdminUsersPage(c.get('user'), data, view), status),
        view: (e): AdminUsersView => ({ error: e.message }),
        statusOf: statusForAuthError,
      },
      error,
    );

  /**
   * A list-mutating form (hide/join/follow/propose/delete) carries where it
   * was drawn from in one `return_to` hidden field — the page's own current
   * URL — rather than one hidden field per filter (`list-query.ts`). These
   * two read what `return_to` names, so a refusal or a redirect lands back on
   * the right list, still narrowed the way the player had it.
   */
  const isFindReturn = (returnTo: string | null | undefined): boolean => matchesBasePath('/games/find', returnTo);
  const gameViewReturn = (returnTo: string | null | undefined): boolean =>
    !!returnTo && /^\/games\/\d+$/.test(returnTo);

  /** A refused game command is reported on the player's own games list, still narrowed as `returnTo` had it. */
  const myGamesError = (
    c: Context<{ Variables: Variables }>,
    error: GameError,
    returnTo: string | null | undefined,
    extra?: Partial<MyGamesView>,
  ): Response => {
    const asked = parseReturnTo(MY_GAMES_SCHEMA, '/games', returnTo);
    return pageError(
      c,
      c.get('user'),
      {
        name: 'list games',
        reload: () => games.listMyGames(c.get('user'), asked),
        render: (data, view: MyGamesView, status) => c.html(renderMyGamesPage(c.get('user'), data, view), status),
        view: (e): MyGamesView => ({ ...extra, error: e.message, filters: asked }),
        statusOf: statusForGameError,
      },
      error,
    );
  };

  /** A refused follow/unfollow, or a join reported back on the find page — re-run narrowed as `returnTo` had it. */
  const findGamesError = (
    c: Context<{ Variables: Variables }>,
    error: GameError,
    returnTo: string | null | undefined,
  ): Response => {
    const asked = parseReturnTo(FIND_GAMES_SCHEMA, '/games/find', returnTo);
    return pageError(
      c,
      c.get('user'),
      {
        name: 'search games',
        reload: () => games.searchProposed(c.get('user'), asked),
        render: (data, view: FindGamesView, status) => c.html(renderFindGamesPage(c.get('user'), data, view), status),
        view: (e): FindGamesView => ({ error: e.message, filters: asked }),
        statusOf: statusForGameError,
      },
      error,
    );
  };

  /**
   * A refused join is reported on whichever list offered the button, so the
   * player stays where they were and can pick another game.
   */
  const gameJoinError = (
    c: Context<{ Variables: Variables }>,
    error: GameError,
    returnTo: string | null | undefined,
  ): Response => {
    if (error.code === 'forbidden') return forbiddenPage(c, c.get('user'));
    return isFindReturn(returnTo) ? findGamesError(c, error, returnTo) : myGamesError(c, error, returnTo);
  };

  /**
   * A refused hide (ticket 05) is reported back wherever the button was: the
   * game page's own hide button stays on the game page, the list row's stays
   * on the list — the same "where did the click come from" idiom as
   * `gameJoinError`, just with a two-way split instead of a three-way one.
   */
  const gameHideError = (
    c: Context<{ Variables: Variables }>,
    error: GameError,
    returnTo: string | null | undefined,
  ): Response => (gameViewReturn(returnTo) ? gameViewError(c, error) : myGamesError(c, error, returnTo));

  /** A refused game command on the game screen is reported there, re-read fresh. */
  const gameViewError = (c: Context<{ Variables: Variables }>, error: GameError): Response => {
    const id = paramId(c, 'id', 'That game no longer exists.');
    if (id.isErr()) {
      return c.html(renderShell('Not found', renderNotFoundPage(), { user: c.get('user') }), 404);
    }
    return pageError(
      c,
      c.get('user'),
      {
        name: 'game view',
        reload: () => games.getGame(c.get('user'), id.value),
        render: (data, view: GameViewPageView, status) => c.html(renderGamePage(c.get('user'), data, view), status),
        view: (e): GameViewPageView => ({ error: e.message }),
        statusOf: statusForGameError,
      },
      error,
    );
  };

  /** A query parameter, or undefined when absent or blank ("any"). */
  const query = (c: Context<{ Variables: Variables }>, name: string): string | undefined => {
    const value = c.req.query(name);
    return value === undefined || value.trim() === '' ? undefined : value;
  };

  /** What a streamed page needs: a topic to listen on, and how to draw itself. */
  interface StreamSpec<D> {
    /** Named for log lines, as the page adapters are. */
    readonly name: string;
    /** The change topic this page follows. */
    readonly topic: string;
    /** Re-read through the module on every change, so the stream authorises per frame. */
    load(actor: SessionUser): Result<D, GameError>;
    regions(data: D): Regions;
  }

  /**
   * The stream adapter — the live twin of `pageAction` (ADR-0007's hand-rolled
   * SSE). It holds the connection open and, whenever the topic changes,
   * re-reads the page through the Game module and pushes its regions as one
   * frame.
   *
   * Re-reading rather than pushing what the command produced is what gates a
   * spectator per frame: the moment a share is switched off the module answers
   * `not-found`, and the stream says so and stops. It is also what keeps the
   * frames consistent — a stream woken by two moves at once reads the position
   * after both, never a board and a move list a move apart.
   */
  const streamPage = <D>(c: Context<{ Variables: Variables }>, spec: StreamSpec<D>): Response => {
    const actor = c.get('user');
    const sessionId = getCookie(c, SESSION_COOKIE) ?? '';

    // Authorise before the stream opens, so a viewer who may not see this page
    // gets the page's own answer — a status an EventSource treats as final,
    // rather than a stream it would reconnect to forever. This is exactly
    // `pageAction`'s branching, so it *is* `pageAction`: the load it does is
    // the authorising read, and the render it triggers opens the stream. The
    // loop below reads again for the first frame; one extra read buys the
    // honest status code.
    return pageAction(c, actor, {
      name: spec.name,
      load: spec.load,
      render: () => openStream(),
      // A page they cannot see must read as absent, as the game route has it;
      // anything else is a bad request, and a stream has no page to say so on.
      renderError: (error, status) =>
        error.code === 'not-found'
          ? c.html(renderShell('Not found', renderNotFoundPage(), { user: actor }), status)
          : c.text(error.message, status),
      statusOf: statusForGameError,
    });

    function openStream(): Response {
      return streamSSE(c, async (stream) => {
        const closing = new AbortController();
        stream.onAbort(() => closing.abort());

        let seen = 0;
        while (!stream.closed && !closing.signal.aborted) {
          const change = await updates.next(spec.topic, seen, { signal: closing.signal, waitMs: heartbeatMs });
          if (change.type === 'closed') return;
          if (change.type === 'idle') {
            await stream.writeSSE({ event: 'ping', data: '' });
            continue;
          }
          seen = change.revision;

          // A stream outlives the request that opened it, so the session is
          // re-checked before every frame: a password change, a sign-out or a
          // block ends all sessions (ticket 07), and an open stream must be no
          // exception. Nothing has been sent in the meantime — an idle stream
          // pushes only contentless heartbeats.
          const viewer = auth.getSessionUser(sessionId);
          if (viewer.isErr() || viewer.value.blocked) return;

          // Read after the change, never before: this is the frame's whole
          // claim to being current. A stream that slept through two moves
          // reads the position after both.
          const current = spec.load(viewer.value);
          if (current.isErr()) {
            const error = current.error;
            // The viewer has lost sight of the game — removed, deleted, or no
            // longer shared. Say so once and stop; the page route is the one
            // place that decides what they should see instead.
            if (error.code === 'not-found' || error.code === 'forbidden') {
              await stream.writeSSE({ event: 'gone', data: '' });
              return;
            }
            logger.log('error', spec.name, { error });
            return;
          }
          await stream.writeSSE({
            event: 'state',
            data: JSON.stringify({ regions: spec.regions(current.value) }),
          });
        }
      });
    }
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

  app.get('/games', requireUser, (c) => {
    const actor = c.get('user');
    const parsed = parseQuery(MY_GAMES_SCHEMA, (param) => query(c, param));
    if (parsed.isErr()) {
      // A bad status/sort/direction is the user's to fix: keep the form and say what is wrong.
      return c.html(renderMyGamesPage(actor, [], { error: parsed.error.message }), statusForGameError(parsed.error));
    }
    const asked = parsed.value;
    return pageAction(c, actor, {
      name: 'list games',
      load: () => games.listMyGames(actor, asked),
      render: (data) => c.html(renderMyGamesPage(actor, data, { filters: asked })),
    });
  });

  // The lists follow one topic: any change anywhere can add a row, remove one,
  // or move whose turn it is (see `GAMES_TOPIC`).
  app.get('/games/stream', requireUser, (c) => {
    const parsed = parseQuery(MY_GAMES_SCHEMA, (param) => query(c, param));
    if (parsed.isErr()) return c.text(parsed.error.message, statusForGameError(parsed.error));
    const asked = parsed.value;
    return streamPage(c, {
      name: 'stream games',
      topic: GAMES_TOPIC,
      // The same query the page ran, so the stream's answer is the page's.
      load: (actor) => games.listMyGames(actor, asked),
      regions: (data) => myGamesRegions(c.get('user'), data, asked),
    });
  });

  app.get('/games/find/stream', requireUser, (c) => {
    const parsed = parseQuery(FIND_GAMES_SCHEMA, (param) => query(c, param));
    if (parsed.isErr()) return c.text(parsed.error.message, statusForGameError(parsed.error));
    const asked = parsed.value;
    return streamPage(c, {
      name: 'stream search',
      topic: GAMES_TOPIC,
      // The same search the page ran, so the stream's answer is the page's.
      load: (actor) => games.searchProposed(actor, asked),
      regions: (data) => findGamesRegions(c.get('user'), data, asked),
    });
  });

  app.get('/games/find', requireUser, (c) => {
    const actor = c.get('user');
    const parsed = parseQuery(FIND_GAMES_SCHEMA, (param) => query(c, param));
    if (parsed.isErr()) {
      // A bad filter is the user's to fix: keep the form and say what is wrong.
      return c.html(renderFindGamesPage(actor, [], { error: parsed.error.message }), statusForGameError(parsed.error));
    }
    const asked = parsed.value;
    return pageAction(c, actor, {
      name: 'search games',
      load: () => games.searchProposed(actor, asked),
      render: (data) => c.html(renderFindGamesPage(actor, data, { filters: asked })),
    });
  });

  app.post('/games/find/follow', requireUser, formAction({
    fields: ['user_id', 'return_to'],
    run: (c, f) =>
      games.applyGame(c.get('user'), { type: 'follow', userId: Number(f.user_id) }).map(() => f.return_to),
    onOk: (c, returnTo) => {
      const asked = parseReturnTo(FIND_GAMES_SCHEMA, '/games/find', returnTo);
      return c.redirect(`/games/find${queryString(FIND_GAMES_SCHEMA, asked)}`, 303);
    },
    renderError: (c, e, f) => findGamesError(c, e, f.return_to),
  }));

  app.post('/games/find/unfollow', requireUser, formAction({
    fields: ['user_id', 'return_to'],
    run: (c, f) =>
      games.applyGame(c.get('user'), { type: 'unfollow', userId: Number(f.user_id) }).map(() => f.return_to),
    onOk: (c, returnTo) => {
      const asked = parseReturnTo(FIND_GAMES_SCHEMA, '/games/find', returnTo);
      return c.redirect(`/games/find${queryString(FIND_GAMES_SCHEMA, asked)}`, 303);
    },
    renderError: (c, e, f) => findGamesError(c, e, f.return_to),
  }));

  app.post('/games', requireUser, formAction({
    fields: ['board_size', 'join_type', 'invited_display_name', 'starter', 'ptn', 'return_to'],
    run: (c, f) =>
      games.applyGame(c.get('user'), {
        type: 'propose',
        boardSize: Number(f.board_size),
        joinType: f.join_type ?? '',
        invitedDisplayName: f.invited_display_name ?? undefined,
        starter: f.starter ?? undefined,
        ptn: f.ptn ?? undefined,
      }),
    // Proposing lands on the unfiltered list regardless of `return_to`: a
    // filtered view (e.g. status=finished) could hide the very game just
    // proposed, which would read as the proposal having silently failed.
    onOk: (c) => c.redirect('/games', 303),
    renderError: (c, e, f) =>
      myGamesError(c, e, f.return_to, {
        submitted: {
          boardSize: f.board_size,
          joinType: f.join_type,
          invitedDisplayName: f.invited_display_name,
          starter: f.starter,
          ptn: f.ptn,
        },
      }),
  }));

  app.post('/games/:id/join', requireUser, formAction({
    fields: ['return_to'],
    run: (c) =>
      paramId(c, 'id', 'That game no longer exists.').andThen((id) =>
        games.applyGame(c.get('user'), { type: 'join', gameId: id }),
      ),
    // A join means play now: land on the game screen, not back on a list.
    // Only a refused join is reported on the list that offered the button.
    onOk: (c) => c.redirect(`/games/${c.req.param('id')}`, 303),
    renderError: (c, e, f) => gameJoinError(c, e, f.return_to),
  }));

  app.post('/games/:id/delete', requireUser, formAction({
    fields: ['return_to'],
    run: (c, f) =>
      paramId(c, 'id', 'That game no longer exists.').andThen((id) =>
        games.applyGame(c.get('user'), { type: 'deleteProposal', gameId: id }).map(() => f.return_to),
      ),
    onOk: (c, returnTo) => {
      const asked = parseReturnTo(MY_GAMES_SCHEMA, '/games', returnTo);
      return c.redirect(`/games${queryString(MY_GAMES_SCHEMA, asked)}`, 303);
    },
    renderError: (c, e, f) => myGamesError(c, e, f.return_to),
  }));

  app.get('/games/:id', requireUser, (c) => {
    const actor = c.get('user');
    const id = paramId(c, 'id', 'That game no longer exists.');
    if (id.isErr()) {
      return c.html(renderShell('Not found', renderNotFoundPage(), { user: actor }), 404);
    }
    return pageAction(c, actor, {
      name: 'game view',
      load: () => games.getGame(actor, id.value),
      render: (view) => c.html(renderGamePage(actor, view)),
      renderError: (e, status) => c.html(renderShell('Not found', renderNotFoundPage(), { user: actor }), status),
      statusOf: statusForGameError,
    });
  });

  app.get('/games/:id/stream', requireUser, (c) => {
    const id = paramId(c, 'id', 'That game no longer exists.');
    if (id.isErr()) {
      return c.html(renderShell('Not found', renderNotFoundPage(), { user: c.get('user') }), 404);
    }
    return streamPage(c, {
      name: 'stream game view',
      topic: gameTopic(id.value),
      // `getGame` is the visibility rule (ADR-0003), so the spectator gate on
      // the stream is the very one on the page — the route decides nothing.
      load: (actor) => games.getGame(actor, id.value),
      regions: gameRegions,
    });
  });

  app.post('/games/:id/move', requireUser, formAction({
    fields: ['move'],
    run: (c, f) =>
      paramId(c, 'id', 'That game no longer exists.').andThen((id) =>
        games.applyGame(c.get('user'), { type: 'playMove', gameId: id, move: f.move ?? '' }),
      ),
    onOk: (c) => c.redirect(`/games/${c.req.param('id')}`, 303),
    renderError: (c, e) => gameViewError(c, e),
  }));

  app.post('/games/:id/resign', requireUser, formAction({
    fields: [],
    run: (c) =>
      paramId(c, 'id', 'That game no longer exists.').andThen((id) =>
        games.applyGame(c.get('user'), { type: 'resign', gameId: id }),
      ),
    onOk: (c) => c.redirect(`/games/${c.req.param('id')}`, 303),
    renderError: (c, e) => gameViewError(c, e),
  }));

  app.post('/games/:id/draw', requireUser, formAction({
    fields: [],
    run: (c) =>
      paramId(c, 'id', 'That game no longer exists.').andThen((id) =>
        games.applyGame(c.get('user'), { type: 'offerDraw', gameId: id }),
      ),
    onOk: (c) => c.redirect(`/games/${c.req.param('id')}`, 303),
    renderError: (c, e) => gameViewError(c, e),
  }));

  app.post('/games/:id/draw/accept', requireUser, formAction({
    fields: [],
    run: (c) =>
      paramId(c, 'id', 'That game no longer exists.').andThen((id) =>
        games.applyGame(c.get('user'), { type: 'acceptDraw', gameId: id }),
      ),
    onOk: (c) => c.redirect(`/games/${c.req.param('id')}`, 303),
    renderError: (c, e) => gameViewError(c, e),
  }));

  app.post('/games/:id/draw/reject', requireUser, formAction({
    fields: [],
    run: (c) =>
      paramId(c, 'id', 'That game no longer exists.').andThen((id) =>
        games.applyGame(c.get('user'), { type: 'rejectDraw', gameId: id }),
      ),
    onOk: (c) => c.redirect(`/games/${c.req.param('id')}`, 303),
    renderError: (c, e) => gameViewError(c, e),
  }));

  app.post('/games/:id/take-back', requireUser, formAction({
    fields: [],
    run: (c) =>
      paramId(c, 'id', 'That game no longer exists.').andThen((id) =>
        games.applyGame(c.get('user'), { type: 'requestTakeBack', gameId: id }),
      ),
    onOk: (c) => c.redirect(`/games/${c.req.param('id')}`, 303),
    renderError: (c, e) => gameViewError(c, e),
  }));

  app.post('/games/:id/take-back/accept', requireUser, formAction({
    fields: [],
    run: (c) =>
      paramId(c, 'id', 'That game no longer exists.').andThen((id) =>
        games.applyGame(c.get('user'), { type: 'acceptTakeBack', gameId: id }),
      ),
    onOk: (c) => c.redirect(`/games/${c.req.param('id')}`, 303),
    renderError: (c, e) => gameViewError(c, e),
  }));

  app.post('/games/:id/take-back/reject', requireUser, formAction({
    fields: [],
    run: (c) =>
      paramId(c, 'id', 'That game no longer exists.').andThen((id) =>
        games.applyGame(c.get('user'), { type: 'rejectTakeBack', gameId: id }),
      ),
    onOk: (c) => c.redirect(`/games/${c.req.param('id')}`, 303),
    renderError: (c, e) => gameViewError(c, e),
  }));

  /**
   * Copying a record out is a read, so it is a GET and stays linkable — but the
   * module audits it (CONTEXT.md lists exports in the activity trail), so it
   * goes through `applyGame` like any other command.
   */
  app.get('/games/:id/export', requireUser, (c) => {
    const actor = c.get('user');
    const id = paramId(c, 'id', 'That game no longer exists.');
    if (id.isErr()) {
      return c.html(renderShell('Not found', renderNotFoundPage(), { user: actor }), 404);
    }
    const through = query(c, 'through');
    return pageAction(c, actor, {
      name: 'export game',
      load: () =>
        games.applyGame(actor, {
          type: 'export',
          gameId: id.value,
          format: query(c, 'format') ?? '',
          // Anything non-numeric lands as NaN, which the module refuses.
          throughMove: through === undefined ? undefined : Number(through),
        }),
      render: (result) => {
        if (result.type !== 'export') {
          logger.log('error', 'unexpected export result', { result });
          return c.json({ error: 'Internal Server Error' }, 500);
        }
        return c.html(renderExportPage(actor, id.value, result));
      },
      // A game they cannot see must read as absent; a bad format or move number
      // is theirs to correct, so it is reported back on the game itself.
      renderError: (e, status) =>
        e.code === 'not-found'
          ? c.html(renderShell('Not found', renderNotFoundPage(), { user: actor }), status)
          : gameViewError(c, e),
      statusOf: statusForGameError,
    });
  });

  app.post('/games/:id/share', requireUser, formAction({
    fields: ['on'],
    run: (c, f) =>
      paramId(c, 'id', 'That game no longer exists.').andThen((id) =>
        games.applyGame(c.get('user'), { type: 'share', gameId: id, on: f.on === '1' }),
      ),
    onOk: (c) => c.redirect(`/games/${c.req.param('id')}`, 303),
    renderError: (c, e) => gameViewError(c, e),
  }));

  app.post('/games/:id/hide', requireUser, formAction({
    fields: ['return_to'],
    run: (c, f) =>
      paramId(c, 'id', 'That game no longer exists.').andThen((id) =>
        games.applyGame(c.get('user'), { type: 'hide', gameId: id }).map(() => f.return_to),
      ),
    // Hiding always leaves the game behind, so success always lands on the
    // list (ticket 05) — narrowed as `return_to` had it when it came from the
    // list; the game screen's own hide sends `return_to` too (`/games/:id`),
    // which doesn't match the list's base path, so `parseReturnTo` falls back
    // to the unfiltered list, same as before.
    onOk: (c, returnTo) => {
      const asked = parseReturnTo(MY_GAMES_SCHEMA, '/games', returnTo);
      return c.redirect(`/games${queryString(MY_GAMES_SCHEMA, asked)}`, 303);
    },
    renderError: (c, e, f) => gameHideError(c, e, f.return_to),
  }));

  app.post('/games/:id/admin-delete', requireUser, formAction({
    fields: [],
    run: (c) =>
      paramId(c, 'id', 'That game no longer exists.').andThen((id) =>
        games.applyGame(c.get('user'), { type: 'adminDelete', gameId: id }),
      ),
    onOk: (c) => c.redirect(`/games/${c.req.param('id')}`, 303),
    renderError: (c, e) => gameViewError(c, e),
  }));

  app.get('/admin', requireUser, (c) => c.redirect('/admin/users', 303));

  // Ticket 13's admin face: every game, so an admin can view or remove any of
  // them. `listAllGames` refuses non-admins, and `pageAction` turns that into
  // the forbidden page.
  app.get('/admin/games', requireUser, (c) => {
    const actor = c.get('user');
    return pageAction(c, actor, {
      name: 'list all games',
      load: () => games.listAllGames(actor),
      render: (data) => c.html(renderAdminGamesPage(actor, data)),
    });
  });

  app.get('/admin/users', requireUser, (c) => {
    const actor = c.get('user');
    return pageAction(c, actor, {
      name: 'list users',
      load: () => auth.listUsers(actor),
      render: (data) => c.html(renderAdminUsersPage(actor, data)),
    });
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
    renderError: usersError,
  }));

  app.post('/admin/users/:id/block', requireUser, formAction({
    fields: [],
    run: (c) => {
      const id = paramId(c, 'id', 'Unknown user.');
      if (id.isErr()) return Promise.resolve(err(id.error));
      return auth.applyAuth(c.get('user'), { type: 'blockUser', userId: id.value });
    },
    onOk: (c) => c.redirect('/admin/users', 303),
    renderError: usersError,
  }));

  app.post('/admin/users/:id/unblock', requireUser, formAction({
    fields: [],
    run: (c) => {
      const id = paramId(c, 'id', 'Unknown user.');
      if (id.isErr()) return Promise.resolve(err(id.error));
      return auth.applyAuth(c.get('user'), { type: 'unblockUser', userId: id.value });
    },
    onOk: (c) => c.redirect('/admin/users', 303),
    renderError: usersError,
  }));

  app.post('/admin/users/:id/force-password-change', requireUser, formAction({
    fields: [],
    run: (c) => {
      const id = paramId(c, 'id', 'Unknown user.');
      if (id.isErr()) return Promise.resolve(err(id.error));
      return auth.applyAuth(c.get('user'), { type: 'forcePasswordChange', userId: id.value });
    },
    onOk: (c) => c.redirect('/admin/users', 303),
    renderError: usersError,
  }));

  app.post('/admin/users/:id/reset-password', requireUser, formAction({
    fields: [],
    run: (c) => {
      const id = paramId(c, 'id', 'Unknown user.');
      if (id.isErr()) return Promise.resolve(err(id.error));
      return auth.applyAuth(c.get('user'), { type: 'resetPassword', userId: id.value });
    },
    onOk: (c, r) => {
      if (r.type !== 'resetPassword') {
        logger.log('error', 'unexpected reset result', { result: r });
        return c.json({ error: 'Internal Server Error' }, 500);
      }
      return c.html(renderResetPasswordResult(c.get('user'), r.username, r.password));
    },
    renderError: usersError,
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
