import type { Context, Env, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Result } from 'neverthrow';
import type { AuthError } from './auth.js';
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

export interface FormActionSpec<E extends Env, R> {
  /** Form field names to coerce from the body; absent/non-textual fields become null. */
  readonly fields: readonly string[];
  run(c: Context<E>, fields: FormFields): Promise<Result<R, AuthError>>;
  onOk(c: Context<E>, result: R): Response;
  /** Called with every error except `persistence` (the adapter short-circuits that). */
  renderError(c: Context<E>, error: AuthError): Response;
}

export function createFormAction<E extends Env>(logger: Logger): <R>(spec: FormActionSpec<E, R>) => MiddlewareHandler<E> {
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
      return spec.renderError(c, error);
    };
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
