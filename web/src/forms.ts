import type { Context, Env, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Result } from 'neverthrow';
import type { AuthError } from './auth.js';
import type { GameError } from './games.js';
import type { Logger } from './logging.js';

/**
 * The form-action adapter — the one place a form submission becomes a module
 * call. Routes declare fields, the run closure, the success response, and the
 * error rendering; the adapter owns body parsing, field coercion, and the
 * uniform persistence-error shortcut (log + generic 500). Error codes map to
 * HTTP statuses once, in `statusForAuthError`, so routes never re-derive them.
 */

export type FormFields = Record<string, string | null>;

function formField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * What the adapter needs of a module's error: a code to branch `persistence` on
 * and a message to log. Both `AuthError` and `GameError` satisfy it.
 */
export interface ActionError {
  readonly code: string;
  readonly message: string;
}

export interface FormActionSpec<E extends Env, R, X extends ActionError = AuthError> {
  /** Form field names to coerce from the body; absent/non-textual fields become null. */
  readonly fields: readonly string[];
  /** Sync or async: auth hashes passwords, the game module does not. */
  run(c: Context<E>, fields: FormFields): Promise<Result<R, X>> | Result<R, X>;
  onOk(c: Context<E>, result: R): Response;
  /**
   * Called with every error except `persistence` (the adapter short-circuits
   * that). The submitted fields come back too, so a re-rendered form can put
   * the user's own input back rather than blanking it.
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
      if (error.code === 'persistence') {
        logger.log('error', 'form action failed', { error });
        return c.json({ error: 'Internal Server Error' }, 500);
      }
      return spec.renderError(c, error, fields);
    };
}

/** One place maps a game error code to its HTTP status. */
export function statusForGameError(error: GameError): ContentfulStatusCode {
  switch (error.code) {
    case 'persistence':
      return 500;
    case 'forbidden':
      return 403;
    case 'not-found':
      return 404;
    case 'invalid-board-size':
    case 'invalid-join-type':
    case 'invalid-invite':
    case 'invalid-ptn':
      return 400;
    // The request was well formed; the game had moved on.
    case 'already-joined':
    case 'not-proposed':
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
