import type { Context, Env, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { err, ok, type Result } from 'neverthrow';
import type { AuthError } from './auth.js';
import type { SessionUser } from './auth.js';
import type { GameError } from './games.js';
import type { Logger } from './logging.js';
import { renderShell } from './html.js';
import { renderForbiddenPage } from './views.js';

/**
 * The route-action module — the one place a request becomes a module call and
 * a page renders. Form submissions go through `createFormAction`; pages load
 * through `createPageAction`; a refused form is re-rendered on its list through
 * `createPageError`. All three own the same branching — forbidden → 403 page,
 * persistence → 500 + log, else render at a mapped status — so routes never
 * re-derive it. Error codes map to HTTP statuses once, in `statusForAuthError`
 * and `statusForGameError`.
 */

export type FormFields = Record<string, string | null>;

function formField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * What the adapter needs of a module's error: a code to branch the internal
 * faults on and a message to log. Both `AuthError` and `GameError` satisfy it.
 */
export interface ActionError {
  readonly code: string;
  readonly message: string;
}

/**
 * Our fault, not the user's: nothing the request can be re-rendered to fix, so
 * it is logged and answered 500. A failed query (`persistence`) and stored data
 * gone bad (`corrupt-record`, ADR-0005) are distinct faults that land here alike.
 */
function isInternal(error: ActionError): boolean {
  return error.code === 'persistence' || error.code === 'corrupt-record';
}

export interface FormActionSpec<E extends Env, R, X extends ActionError = AuthError> {
  /** Form field names to coerce from the body; absent/non-textual fields become null. */
  readonly fields: readonly string[];
  /** Sync or async: auth hashes passwords, the game module does not. */
  run(c: Context<E>, fields: FormFields): Promise<Result<R, X>> | Result<R, X>;
  onOk(c: Context<E>, result: R): Response;
  /**
   * Called with every error except the internal ones (the adapter
   * short-circuits those). The submitted fields come back too, so a
   * re-rendered form can put the user's own input back rather than blanking it.
   */
  renderError(c: Context<E>, error: X, fields: FormFields): Response;
}

export function createFormAction<E extends Env>(
  logger: Logger,
): <R, X extends ActionError = AuthError>(spec: FormActionSpec<E, R, X>) => MiddlewareHandler<E> {
  return (spec) =>
    async (c) => {
      const body = await c.req.parseBody();
      const fields: FormFields = {};
      for (const name of spec.fields) {
        fields[name] = formField(body[name]);
      }

      const result = await spec.run(c, fields);
      if (result.isOk()) return spec.onOk(c, result.value);

      const error = result.error;
      if (isInternal(error)) {
        logger.log('error', 'form action failed', { error });
        return c.json({ error: 'Internal Server Error' }, 500);
      }
      return spec.renderError(c, error, fields);
    };
}

/** The 403 page, with the requester in the masthead. */
export function forbiddenPage<E extends Env>(c: Context<E>, user: SessionUser): Response {
  return c.html(renderShell('Forbidden', renderForbiddenPage(), { user }), 403);
}

/**
 * Parse `:name` from the path as a positive integer. Anything else — absent,
 * non-numeric, zero, negative — is `not-found`, so a malformed id and a
 * missing row read the same to the caller. Routes compose the result with the
 * module command: `paramId(c, 'id', msg).andThen((id) => ...)`.
 */
export function paramId<E extends Env>(
  c: Context<E>,
  name: string,
  message: string,
): Result<number, { code: 'not-found'; message: string }> {
  const id = Number(c.req.param(name));
  return Number.isInteger(id) && id >= 1 ? ok(id) : err({ code: 'not-found', message });
}

export interface PageActionSpec<D, X extends ActionError> {
  /** Named for log lines ("list games", "search proposals"). */
  readonly name: string;
  load(actor: SessionUser): Result<D, X>;
  /** The page's success render; always status 200. */
  render(data: D): Response;
  /**
   * The page's own error state, for errors beyond forbidden and the internal
   * faults — the find page keeps its filters and clears the list; the game
   * view will want its own. Absent, an unexpected code is logged and 500.
   */
  renderError?(error: X, status: ContentfulStatusCode): Response;
  /** Maps the module error to an HTTP status for `renderError`. */
  statusOf?(error: X): ContentfulStatusCode;
}

/**
 * The page adapter — a plain function, not a middleware: GET handlers already
 * return Responses, and a pure function is unit-testable without a Hono
 * `Context`, like `createFormAction`.
 */
export function createPageAction<E extends Env>(
  logger: Logger,
): <D, X extends ActionError>(c: Context<E>, actor: SessionUser, spec: PageActionSpec<D, X>) => Response {
  return (c, actor, spec) => {
    const result = spec.load(actor);
    if (result.isOk()) return spec.render(result.value);

    const error = result.error;
    if (error.code === 'forbidden') return forbiddenPage(c, actor);
    if (isInternal(error) || spec.renderError === undefined) {
      logger.log('error', spec.name, { error });
      return c.json({ error: 'Internal Server Error' }, 500);
    }
    const status = spec.statusOf ? spec.statusOf(error) : 400;
    return spec.renderError(error, status);
  };
}

export interface PageErrorSpec<D, V, X extends ActionError> {
  /** Named for log lines ("list games", "list users"). */
  readonly name: string;
  /** Re-reads the page's data so a rejected form renders a fresh list. */
  reload(): Result<D, X>;
  render(data: D, view: V, status: ContentfulStatusCode): Response;
  /** Builds the error view: the message, submitted values, kept filters. */
  view(error: X): V;
  statusOf(error: X): ContentfulStatusCode;
}

/**
 * The refused-form twin of `pageAction`: called from a `formAction`
 * `renderError` with the command's error, it answers the forbidden page or
 * re-renders the page with the error view at the mapped status.
 */
export function createPageError<E extends Env>(
  logger: Logger,
): <D, V, X extends ActionError>(
  c: Context<E>,
  actor: SessionUser,
  spec: PageErrorSpec<D, V, X>,
  error: X,
) => Response {
  return (c, actor, spec, error) => {
    if (error.code === 'forbidden') return forbiddenPage(c, actor);

    const reloaded = spec.reload();
    if (reloaded.isErr()) {
      if (reloaded.error.code === 'forbidden') return forbiddenPage(c, actor);
      logger.log('error', spec.name, { error: reloaded.error });
      return c.json({ error: 'Internal Server Error' }, 500);
    }
    return spec.render(reloaded.value, spec.view(error), spec.statusOf(error));
  };
}

/** One place maps a game error code to its HTTP status. */
export function statusForGameError(error: GameError): ContentfulStatusCode {
  switch (error.code) {
    case 'persistence':
    case 'corrupt-record':
      return 500;
    // `not-invited` is a visible game that simply designates someone else;
    // a game the actor may not see is reported as `not-found` instead.
    case 'forbidden':
    case 'not-invited':
      return 403;
    case 'not-found':
      return 404;
    case 'invalid-board-size':
    case 'invalid-join-type':
    case 'invalid-invite':
    case 'invalid-starter':
    case 'invalid-ptn':
    case 'invalid-move':
    case 'invalid-export-format':
    case 'invalid-move-number':
      return 400;
    // The request was well formed; the game had moved on.
    case 'already-joined':
    case 'not-proposed':
    case 'not-in-play':
    case 'not-your-turn':
    case 'request-pending':
    case 'no-pending-request':
    case 'no-move-to-take-back':
    case 'already-removed':
      return 409;
  }
}

/** One place maps an auth error code to its HTTP status. */
export function statusForAuthError(error: AuthError): ContentfulStatusCode {
  switch (error.code) {
    case 'persistence':
      return 500;
    case 'forbidden':
      return 403;
    case 'not-authenticated':
    case 'invalid-credentials':
    case 'user-blocked':
      return 401;
    case 'not-found':
      return 404;
    default:
      return 400;
  }
}
