import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { err, ok, type Result } from 'neverthrow';
import { createFormAction, statusForAuthError, statusForGameError } from '../src/forms.js';
import type { AuthError } from '../src/auth.js';
import type { GameError } from '../src/games.js';
import type { Logger } from '../src/logging.js';

const silent: Logger = { log() {} };

type Env = { Variables: { requestId: string } };

function formBody(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  };
}

describe('createFormAction', () => {
  it('coerces the named fields and passes them to run', async () => {
    const app = new Hono<Env>();
    const formAction = createFormAction<Env>(silent);
    let received: Record<string, string | null> | undefined;
    app.post(
      '/test',
      formAction({
        fields: ['a', 'b'],
        run: async (c, f): Promise<Result<string, AuthError>> => {
          received = f;
          return ok('done');
        },
        onOk: (c, r) => c.text(`ok:${r}`),
        renderError: (c, e) => c.text(`err:${e.code}`, 400),
      }),
    );

    const res = await app.request('/test', formBody({ a: '1' }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok:done');
    expect(received).toEqual({ a: '1', b: null });
  });

  it('calls onOk with the module result on success', async () => {
    const app = new Hono<Env>();
    const formAction = createFormAction<Env>(silent);
    app.post(
      '/test',
      formAction({
        fields: [],
        run: async (): Promise<Result<number, AuthError>> => ok(42),
        onOk: (c, r) => c.text(`ok:${r}`),
        renderError: (c, e) => c.text(`err:${e.code}`, 400),
      }),
    );

    const res = await app.request('/test', { method: 'POST' });
    expect(await res.text()).toBe('ok:42');
  });

  it('calls renderError with the module error', async () => {
    const app = new Hono<Env>();
    const formAction = createFormAction<Env>(silent);
    app.post(
      '/test',
      formAction({
        fields: [],
        run: async () => err({ code: 'username-taken', message: 'taken' }),
        onOk: (c) => c.text('ok'),
        renderError: (c, e) => c.text(`err:${e.code}:${e.message}`, 400),
      }),
    );

    const res = await app.request('/test', { method: 'POST' });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('err:username-taken:taken');
  });

  it('logs and returns a generic 500 on a persistence error, skipping renderError', async () => {
    const calls: Array<{ level: string; message: string }> = [];
    const logger: Logger = {
      log(level, message) {
        calls.push({ level, message });
      },
    };
    const app = new Hono<Env>();
    const formAction = createFormAction<Env>(logger);
    let renderErrorCalled = false;
    app.post(
      '/test',
      formAction({
        fields: [],
        run: async () => err({ code: 'persistence', message: 'db down' }),
        onOk: (c) => c.text('ok'),
        renderError: (c) => {
          renderErrorCalled = true;
          return c.text('never', 400);
        },
      }),
    );

    const res = await app.request('/test', { method: 'POST' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal Server Error' });
    expect(renderErrorCalled).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe('statusForAuthError', () => {
  it('maps every code to the right HTTP status', () => {
    const e = (code: AuthError['code']): AuthError => ({ code, message: 'x' });
    expect(statusForAuthError(e('persistence'))).toBe(500);
    expect(statusForAuthError(e('forbidden'))).toBe(403);
    expect(statusForAuthError(e('invalid-credentials'))).toBe(401);
    expect(statusForAuthError(e('user-blocked'))).toBe(401);
    expect(statusForAuthError(e('not-authenticated'))).toBe(401);
    expect(statusForAuthError(e('not-found'))).toBe(404);
    expect(statusForAuthError(e('weak-password'))).toBe(400);
    expect(statusForAuthError(e('wrong-password'))).toBe(400);
    expect(statusForAuthError(e('display-name-taken'))).toBe(400);
    expect(statusForAuthError(e('cannot-block-self'))).toBe(400);
    expect(statusForAuthError(e('username-taken'))).toBe(400);
  });
});

describe('statusForGameError', () => {
  it('maps every code to the right HTTP status', () => {
    const e = (code: GameError['code']): GameError => ({ code, message: 'x' });
    expect(statusForGameError(e('persistence'))).toBe(500);
    expect(statusForGameError(e('forbidden'))).toBe(403);
    expect(statusForGameError(e('not-found'))).toBe(404);
    expect(statusForGameError(e('invalid-board-size'))).toBe(400);
    expect(statusForGameError(e('invalid-join-type'))).toBe(400);
    expect(statusForGameError(e('invalid-invite'))).toBe(400);
    expect(statusForGameError(e('invalid-ptn'))).toBe(400);
    // The request was fine; the game had moved on.
    expect(statusForGameError(e('already-joined'))).toBe(409);
    expect(statusForGameError(e('not-proposed'))).toBe(409);
  });
});
