import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { routePath } from 'hono/route';
import { streamSSE } from 'hono/streaming';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { err, ok, type Result } from 'neverthrow';
import type { Persistence, PersistenceSnapshot } from './persistence.js';
import { Metrics } from './metrics.js';
import type { Logger } from './logging.js';
import { newRequestId } from './logging.js';
import { escapeHtml, renderShell, type Regions } from './html.js';
import { SITE_CSS_URL, CLIENT_SCRIPT_URL } from './static-urls.js';
import { adminUserRoutePattern, gamePath, gameRoutePattern } from './paths.js';

/** The committed static assets (ADR-0013): `web/static/`, one level up from this module's directory. */
const STATIC_DIR = join(fileURLToPath(new URL('..', import.meta.url)), 'static');
import { createAuth, type Auth, type AuthCommand, type AuthError, type SessionUser } from './auth.js';
import {
  createGames,
  type GameCommand,
  type GameError,
  type Games,
  type GameSummary,
  type GameView,
} from './games.js';
import { GAMES_TOPIC, announceGameChanges, createUpdates, gameTopic } from './updates.js';
import {
  createFormAction,
  createPageAction,
  createPageError,
  forbiddenPage,
  paramId,
  statusForAuthError,
  statusForGameError,
  type FormFields,
} from './actions.js';
import {
  FIND_GAMES_SCHEMA,
  MY_GAMES_SCHEMA,
  matchesBasePath,
  parseQuery,
  parseReturnTo,
  queryString,
  type FindGamesSearch,
  type MyGamesQuery,
} from './list-query.js';
import {
  renderAccountPage,
  renderAdminGamesPage,
  renderAdminUsersPage,
  renderChangeDisplayNamePage,
  renderChangePasswordPage,
  renderLoginPage,
  renderResetPasswordResult,
  renderRoot,
  renderStatusPageBody,
  type AdminUsersView,
} from './views.js';
import {
  findGamesRegions,
  myGamesRegions,
  renderFindGamesPage,
  renderMyGamesPage,
  type FindGamesView,
  type MyGamesView,
} from './game-lists.js';
import {
  gameRegions,
  renderExportPage,
  renderGamePage,
  renderNotFoundPage,
  type GameViewPageView,
} from './game-screen.js';

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

type Ctx = Context<{ Variables: Variables }>;

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
   * URL — rather than one hidden field per filter, or the three-valued `from`
   * field this replaced (ADR-0008). These two read what `return_to` names,
   * so a refusal or a redirect lands back on the right list, still narrowed
   * the way the player had it.
   */
  const isFindReturn = (returnTo: string | null | undefined): boolean => matchesBasePath('/games/find', returnTo);
  const gameViewReturn = (returnTo: string | null | undefined): boolean =>
    !!returnTo && /^\/games\/\d+$/.test(returnTo);

  /** A query parameter, or undefined when absent or blank ("any"). */
  const query = (c: Ctx, name: string): string | undefined => {
    const value = c.req.query(name);
    return value === undefined || value.trim() === '' ? undefined : value;
  };

  /**
   * A game they cannot see must read as absent, as the game route has it;
   * anything else falls back to plain text — in practice this only ever fires
   * on `not-found`, the one error code a page/stream route can reach that
   * `pageAction` doesn't already answer generically (forbidden, persistence).
   */
  const notFoundOrText = (c: Ctx, actor: SessionUser, error: GameError, status: ContentfulStatusCode): Response =>
    error.code === 'not-found'
      ? c.html(renderShell('Not found', renderNotFoundPage(), { user: actor }), status)
      : c.text(error.message, status);

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
  const streamPage = <D>(c: Ctx, spec: StreamSpec<D>): Response => {
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
      renderError: (error, status) => notFoundOrText(c, actor, error, status),
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

  /**
   * What a screen needs to draw itself, addressed three ways: a `GET` page, a
   * `GET` stream, and the error-adapter other commands report a refusal
   * through. Before this, "My games", "Find a game" and the game view each
   * restated their own `load`/`render` at three call sites that could
   * silently drift; a `Screen` states each once and `mountScreen` derives the
   * three.
   *
   * `Address` identifies which instance of the screen is being asked for —
   * resolved filters for the two lists, a game id for the game view.
   * `parseAddress` reads it live (a query string, a path param);
   * `resolveErrorAddress` recovers it when reporting a refusal from another
   * route — a `return_to` field for the lists (reachable from many filtered
   * views), the same path param for the game view (its own command routes are
   * nested under `/games/:id`, so the id is always already there).
   */
  interface ScreenSpec<Address, Data, View> {
    /** Named for log lines, as the page/stream/error-adapter alike. */
    readonly name: string;
    readonly path: string;
    readonly streamPath: string;
    parseAddress(c: Ctx): Result<Address, GameError>;
    /** The page's answer to a bad address — a list re-renders inline; the game view has no page without one. */
    onBadAddress(c: Ctx, actor: SessionUser, error: GameError): Response;
    /** The stream's answer to a bad address. Defaults to plain text; the game view overrides it to match its page. */
    onBadAddressStream?(c: Ctx, error: GameError): Response;
    resolveErrorAddress(c: Ctx, returnTo: string | null | undefined): Result<Address, GameError>;
    topic(address: Address): string;
    load(actor: SessionUser, address: Address): Result<Data, GameError>;
    /** The view shown on a bare, successful `GET` — a list's resolved filters, the game view's empty `{}`. */
    defaultView(address: Address): View;
    /** The view shown after a refused command. `extra` carries a caller's own augmentation (propose's submitted echo). */
    errorView(error: GameError, address: Address, extra?: Partial<View>): View;
    renderPage(actor: SessionUser, data: Data, view: View): string;
    renderRegions(actor: SessionUser, data: Data, address: Address): Regions;
  }

  /**
   * Registers a screen's page and stream `GET` routes, and returns its
   * error-adapter for other command routes to report a refusal through.
   */
  function mountScreen<Address, Data, View>(
    spec: ScreenSpec<Address, Data, View>,
  ): (c: Ctx, error: GameError, returnTo?: string | null, extra?: Partial<View>) => Response {
    app.get(spec.path, requireUser, (c) => {
      const actor = c.get('user');
      const address = spec.parseAddress(c);
      if (address.isErr()) return spec.onBadAddress(c, actor, address.error);
      return pageAction(c, actor, {
        name: spec.name,
        load: () => spec.load(actor, address.value),
        render: (data) => c.html(spec.renderPage(actor, data, spec.defaultView(address.value))),
        renderError: (error, status) => notFoundOrText(c, actor, error, status),
        statusOf: statusForGameError,
      });
    });

    app.get(spec.streamPath, requireUser, (c) => {
      const address = spec.parseAddress(c);
      if (address.isErr()) {
        return spec.onBadAddressStream
          ? spec.onBadAddressStream(c, address.error)
          : c.text(address.error.message, statusForGameError(address.error));
      }
      return streamPage(c, {
        name: `stream ${spec.name}`,
        topic: spec.topic(address.value),
        load: (actor) => spec.load(actor, address.value),
        regions: (data) => spec.renderRegions(c.get('user'), data, address.value),
      });
    });

    return (c, error, returnTo, extra) => {
      const actor = c.get('user');
      const address = spec.resolveErrorAddress(c, returnTo);
      if (address.isErr()) return spec.onBadAddress(c, actor, address.error);
      return pageError(
        c,
        actor,
        {
          name: spec.name,
          reload: () => spec.load(actor, address.value),
          render: (data, view: View, status) => c.html(spec.renderPage(actor, data, view), status),
          view: (e) => spec.errorView(e, address.value, extra),
          statusOf: statusForGameError,
        },
        error,
      );
    };
  }

  const myGamesError = mountScreen<MyGamesQuery, GameSummary[], MyGamesView>({
    name: 'list games',
    path: '/games',
    streamPath: '/games/stream',
    parseAddress: (c) => parseQuery(MY_GAMES_SCHEMA, (param) => query(c, param)),
    // A bad status/sort/direction is the user's to fix: keep the form and say what is wrong.
    onBadAddress: (c, actor, error) =>
      c.html(renderMyGamesPage(actor, [], { error: error.message }), statusForGameError(error)),
    resolveErrorAddress: (_c, returnTo) => ok(parseReturnTo(MY_GAMES_SCHEMA, '/games', returnTo)),
    topic: () => GAMES_TOPIC,
    load: (actor, address) => games.listMyGames(actor, address),
    defaultView: (address) => ({ filters: address }),
    errorView: (error, address, extra) => ({ ...extra, error: error.message, filters: address }),
    renderPage: (actor, data, view) => renderMyGamesPage(actor, data, view),
    renderRegions: (actor, data, address) => myGamesRegions(actor, data, address),
  });

  const findGamesError = mountScreen<FindGamesSearch, GameSummary[], FindGamesView>({
    name: 'search games',
    path: '/games/find',
    streamPath: '/games/find/stream',
    parseAddress: (c) => parseQuery(FIND_GAMES_SCHEMA, (param) => query(c, param)),
    // A bad filter is the user's to fix: keep the form and say what is wrong.
    onBadAddress: (c, actor, error) =>
      c.html(renderFindGamesPage(actor, [], { error: error.message }), statusForGameError(error)),
    resolveErrorAddress: (_c, returnTo) => ok(parseReturnTo(FIND_GAMES_SCHEMA, '/games/find', returnTo)),
    topic: () => GAMES_TOPIC,
    load: (actor, address) => games.searchProposed(actor, address),
    defaultView: (address) => ({ filters: address }),
    errorView: (error, address) => ({ error: error.message, filters: address }),
    renderPage: (actor, data, view) => renderFindGamesPage(actor, data, view),
    renderRegions: (actor, data, address) => findGamesRegions(actor, data, address),
  });

  /** The game view's one answer to "there is nothing here" — a bad id, or `getGame`'s own not-found. */
  const gameViewNotFound = (c: Ctx): Response =>
    c.html(renderShell('Not found', renderNotFoundPage(), { user: c.get('user') }), 404);

  const gameViewError = mountScreen<number, GameView, GameViewPageView>({
    name: 'game view',
    path: gameRoutePattern(),
    streamPath: gameRoutePattern('stream'),
    parseAddress: (c) => paramId(c, 'id', 'That game no longer exists.'),
    onBadAddress: (c) => gameViewNotFound(c),
    onBadAddressStream: (c) => gameViewNotFound(c),
    resolveErrorAddress: (c) => paramId(c, 'id', 'That game no longer exists.'),
    topic: (id) => gameTopic(id),
    load: (actor, id) => games.getGame(actor, id),
    defaultView: () => ({}),
    errorView: (error) => ({ error: error.message }),
    renderPage: (actor, data, view) => renderGamePage(actor, data, view),
    renderRegions: (_actor, data) => gameRegions(data),
  });

  /**
   * A refused join is reported on whichever list offered the button, so the
   * player stays where they were and can pick another game.
   */
  const gameJoinError = (
    c: Ctx,
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
    c: Ctx,
    error: GameError,
    returnTo: string | null | undefined,
  ): Response => (gameViewReturn(returnTo) ? gameViewError(c, error) : myGamesError(c, error, returnTo));

  /**
   * The command routes are one registration each — `paramId` guards the `:id`,
   * `applyGame` owns the rule, the error adapter says where a refusal is
   * reported. The three families below differ only in what they build, where
   * success lands, and which adapter reports a refusal; a row is the whole
   * route. `propose`, `join`, and the admin user create/reset stay explicit:
   * they carry a success render or an echo of the submitted form that a row
   * would have to smuggle into the table.
   */

  /** A game-screen command: back to the game, refusals reported there (ADR-0004's thin-route). */
  const gameScreenCommand = (
    path: string,
    fields: readonly string[],
    build: (fields: FormFields, id: number) => GameCommand,
  ): void => {
    app.post(path, requireUser, formAction({
      fields,
      run: (c, f) =>
        paramId(c, 'id', 'That game no longer exists.').andThen((id) =>
          games.applyGame(c.get('user'), build(f, id)),
        ),
      onOk: (c) => c.redirect(gamePath(Number(c.req.param('id'))), 303),
      renderError: (c, e) => gameViewError(c, e),
    }));
  };

  /** A command landing back on the list it was drawn from, still narrowed as `return_to` had it. */
  const listCommand = (
    path: string,
    fields: readonly string[],
    schema: typeof MY_GAMES_SCHEMA | typeof FIND_GAMES_SCHEMA,
    base: string,
    build: (fields: FormFields, id: number | undefined) => GameCommand,
    error: (
      c: Context<{ Variables: Variables }>,
      e: GameError,
      returnTo: string | null | undefined,
    ) => Response,
  ): void => {
    app.post(path, requireUser, formAction({
      fields,
      run: (c, f) => {
        // `follow`/`unfollow` carry no `:id` — the player is a field, not a
        // path segment — so the id only exists for the game-addressing rows
        // (delete, hide), which assert it with `id!` in their builders.
        const id: Result<number | undefined, { code: 'not-found'; message: string }> = path.includes(':id')
          ? paramId(c, 'id', 'That game no longer exists.')
          : ok(undefined);
        return id.andThen((value) =>
          games.applyGame(c.get('user'), build(f, value)).map(() => f.return_to),
        );
      },
      onOk: (c, returnTo) => {
        const asked = parseReturnTo(schema, base, returnTo);
        return c.redirect(`${base}${queryString(schema, asked)}`, 303);
      },
      renderError: (c, e, f) => error(c, e, f.return_to),
    }));
  };

  /** An admin's user mutation: back to the users list, refusals reported there. */
  const adminUserCommand = (path: string, build: (id: number) => AuthCommand): void => {
    app.post(path, requireUser, formAction({
      fields: [],
      run: (c) => {
        const id = paramId(c, 'id', 'Unknown user.');
        if (id.isErr()) return Promise.resolve(err(id.error));
        return auth.applyAuth(c.get('user'), build(id.value));
      },
      onOk: (c) => c.redirect('/admin/users', 303),
      renderError: usersError,
    }));
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

  // The served assets (ADR-0013): committed files in `web/static/`, read per
  // request so an edit needs no rebuild — the cache headers are the only thing
  // between the browser and the freshest bytes. `/site.css` and `/client.js`
  // were previously strings (the latter inlined into every page); serving them
  // as files is what lets the shell reference them by URL instead.
  app.get(SITE_CSS_URL, (c) =>
    c.text(readFileSync(join(STATIC_DIR, 'site.css'), 'utf8'), 200, {
      'content-type': 'text/css; charset=utf-8',
    }),
  );
  app.get(CLIENT_SCRIPT_URL, (c) =>
    c.text(readFileSync(join(STATIC_DIR, 'client.js'), 'utf8'), 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    }),
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

  // "Your games", "Find a game" (page + stream) are registered by
  // `mountScreen` above, alongside their error-adapters.

  listCommand(
    '/games/find/follow',
    ['user_id', 'return_to'],
    FIND_GAMES_SCHEMA,
    '/games/find',
    (f) => ({ type: 'follow', userId: Number(f.user_id) }),
    findGamesError,
  );

  listCommand(
    '/games/find/unfollow',
    ['user_id', 'return_to'],
    FIND_GAMES_SCHEMA,
    '/games/find',
    (f) => ({ type: 'unfollow', userId: Number(f.user_id) }),
    findGamesError,
  );

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

  app.post(gameRoutePattern('join'), requireUser, formAction({
    fields: ['return_to'],
    run: (c) =>
      paramId(c, 'id', 'That game no longer exists.').andThen((id) =>
        games.applyGame(c.get('user'), { type: 'join', gameId: id }),
      ),
    // A join means play now: land on the game screen, not back on a list.
    // Only a refused join is reported on the list that offered the button.
    onOk: (c) => c.redirect(gamePath(Number(c.req.param('id'))), 303),
    renderError: (c, e, f) => gameJoinError(c, e, f.return_to),
  }));

  listCommand(
    gameRoutePattern('delete'),
    ['return_to'],
    MY_GAMES_SCHEMA,
    '/games',
    (_f, id) => ({ type: 'deleteProposal', gameId: id! }),
    myGamesError,
  );

  // The game view (page + stream) is registered by `mountScreen` above,
  // alongside its error-adapter.

  gameScreenCommand(gameRoutePattern('move'), ['move'], (f, id) => ({ type: 'playMove', gameId: id, move: f.move ?? '' }));

  gameScreenCommand(gameRoutePattern('resign'), [], (_f, id) => ({ type: 'resign', gameId: id }));

  gameScreenCommand(gameRoutePattern('draw'), [], (_f, id) => ({ type: 'offerDraw', gameId: id }));

  gameScreenCommand(gameRoutePattern('draw/accept'), [], (_f, id) => ({ type: 'acceptDraw', gameId: id }));

  gameScreenCommand(gameRoutePattern('draw/reject'), [], (_f, id) => ({ type: 'rejectDraw', gameId: id }));

  gameScreenCommand(gameRoutePattern('take-back'), [], (_f, id) => ({ type: 'requestTakeBack', gameId: id }));

  gameScreenCommand(gameRoutePattern('take-back/accept'), [], (_f, id) => ({ type: 'acceptTakeBack', gameId: id }));

  gameScreenCommand(gameRoutePattern('take-back/reject'), [], (_f, id) => ({ type: 'rejectTakeBack', gameId: id }));

  /**
   * Copying a record out is a read, so it is a GET and stays linkable — but the
   * module audits it (CONTEXT.md lists exports in the activity trail), so it
   * goes through `applyGame` like any other command.
   */
  app.get(gameRoutePattern('export'), requireUser, (c) => {
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

  gameScreenCommand(gameRoutePattern('share'), ['on'], (f, id) => ({ type: 'share', gameId: id, on: f.on === '1' }));

  // Hiding always leaves the game behind, so success always lands on the
  // list (ticket 05) — narrowed as `return_to` had it when it came from the
  // list; the game screen's own hide sends `return_to` too (`/games/:id`),
  // which doesn't match the list's base path, so `parseReturnTo` falls back
  // to the unfiltered list, same as before.
  listCommand(
    gameRoutePattern('hide'),
    ['return_to'],
    MY_GAMES_SCHEMA,
    '/games',
    (_f, id) => ({ type: 'hide', gameId: id! }),
    gameHideError,
  );

  gameScreenCommand(gameRoutePattern('admin-delete'), [], (_f, id) => ({ type: 'adminDelete', gameId: id }));

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

  adminUserCommand(adminUserRoutePattern('block'), (id) => ({ type: 'blockUser', userId: id }));

  adminUserCommand(adminUserRoutePattern('unblock'), (id) => ({ type: 'unblockUser', userId: id }));

  adminUserCommand(adminUserRoutePattern('force-password-change'), (id) => ({
    type: 'forcePasswordChange',
    userId: id,
  }));

  app.post(adminUserRoutePattern('reset-password'), requireUser, formAction({
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
