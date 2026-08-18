import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { err, ok, type Result } from 'neverthrow';
import {
  createFormAction,
  createPageAction,
  createPageError,
  forbiddenPage,
  paramId,
  statusForAuthError,
  statusForGameError,
} from '../src/actions.js';
import type { AuthError } from '../src/auth.js';
import type { SessionUser } from '../src/auth.js';
import type { GameError } from '../src/games.js';
import type { Logger } from '../src/logging.js';

const silent: Logger = { log() {} };

type Env = { Variables: { requestId: string } };

const actor: SessionUser = {
  id: 1,
  username: 'aoife',
  displayName: 'Aoife Nolan',
  role: 'player',
  forcePasswordChange: false,
  blocked: false,
};

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

  it('treats a corrupt record as internal too: no form to re-render fixes it', async () => {
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
        run: async () => err({ code: 'corrupt-record', message: 'game 7: stored move 2 no longer parses' }),
        onOk: (c) => c.text('ok'),
        renderError: (c) => {
          renderErrorCalled = true;
          return c.text('never', 400);
        },
      }),
    );

    const res = await app.request('/test', { method: 'POST' });
    expect(res.status).toBe(500);
    expect(renderErrorCalled).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe('pageAction', () => {
  it('renders the page on a successful load', async () => {
    const app = new Hono<Env>();
    const pageAction = createPageAction<Env>(silent);
    app.get('/test', (c) =>
      pageAction(c, actor, {
        name: 'test list',
        load: () => ok(['a', 'b']),
        render: (data) => c.text(data.join(',')),
      }),
    );

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('a,b');
  });

  it('renders the forbidden page on a forbidden error', async () => {
    const app = new Hono<Env>();
    const pageAction = createPageAction<Env>(silent);
    app.get('/test', (c) =>
      pageAction(c, actor, {
        name: 'test list',
        load: () => err({ code: 'forbidden', message: 'admins only' }),
        render: () => c.text('never'),
      }),
    );

    const res = await app.request('/test');
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain('Forbidden');
    expect(text).toContain(actor.displayName);
  });

  it('logs and returns a generic 500 on a persistence error, skipping render', async () => {
    const calls: Array<{ level: string; message: string }> = [];
    const logger: Logger = {
      log(level, message) {
        calls.push({ level, message });
      },
    };
    const app = new Hono<Env>();
    const pageAction = createPageAction<Env>(logger);
    let renderCalled = false;
    app.get('/test', (c) =>
      pageAction(c, actor, {
        name: 'test list',
        load: () => err({ code: 'persistence', message: 'db down' }),
        render: () => {
          renderCalled = true;
          return c.text('never');
        },
      }),
    );

    const res = await app.request('/test');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal Server Error' });
    expect(renderCalled).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toBe('test list');
  });

  it('renders the page error state at the mapped status for other errors', async () => {
    const app = new Hono<Env>();
    const pageAction = createPageAction<Env>(silent);
    app.get('/test', (c) =>
      pageAction(c, actor, {
        name: 'test list',
        load: () => err({ code: 'not-found', message: 'gone' }),
        render: () => c.text('never'),
        renderError: (e, status) => c.text(`err:${e.message}:${status}`, status),
        statusOf: () => 404,
      }),
    );

    const res = await app.request('/test');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('err:gone:404');
  });

  it('logs and returns 500 when an unexpected error has no renderError', async () => {
    const calls: Array<{ level: string; message: string }> = [];
    const logger: Logger = {
      log(level, message) {
        calls.push({ level, message });
      },
    };
    const app = new Hono<Env>();
    const pageAction = createPageAction<Env>(logger);
    app.get('/test', (c) =>
      pageAction(c, actor, {
        name: 'test list',
        load: () => err({ code: 'not-found', message: 'gone' }),
        render: () => c.text('never'),
      }),
    );

    const res = await app.request('/test');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal Server Error' });
    expect(calls).toHaveLength(1);
  });
});

describe('pageError', () => {
  it('renders the forbidden page on a forbidden command error, skipping the reload', async () => {
    const app = new Hono<Env>();
    const pageError = createPageError<Env>(silent);
    let reloadCalled = false;
    app.post('/test', (c) =>
      pageError(
        c,
        actor,
        {
          name: 'test list',
          reload: () => {
            reloadCalled = true;
            return ok(['a']);
          },
          render: (data: string[], view: { error: string }, status: ContentfulStatusCode) => {
            void data;
            return c.text('never', status);
          },
          view: (e) => ({ error: e.message }),
          statusOf: () => 400,
        },
        { code: 'forbidden', message: 'admins only' },
      ),
    );

    const res = await app.request('/test', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Forbidden');
    expect(reloadCalled).toBe(false);
  });

  it('reloads and renders the page with the view at the mapped status', async () => {
    const app = new Hono<Env>();
    const pageError = createPageError<Env>(silent);
    let reloaded = false;
    app.post('/test', (c) =>
      pageError(
        c,
        actor,
        {
          name: 'test list',
          reload: () => {
            reloaded = true;
            return ok(['x']);
          },
          render: (data: string[], view: { error: string }, status: ContentfulStatusCode) =>
            c.text(`data:${data.join(',')};view:${view.error};status:${status}`, status),
          view: (e) => ({ error: e.message }),
          statusOf: () => 409,
        },
        { code: 'already-joined', message: 'someone else joined first' },
      ),
    );

    const res = await app.request('/test', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('data:x;view:someone else joined first;status:409');
    expect(reloaded).toBe(true);
  });

  it('renders the forbidden page when the reload itself is refused', async () => {
    const app = new Hono<Env>();
    const pageError = createPageError<Env>(silent);
    app.post('/test', (c) =>
      pageError(
        c,
        actor,
        {
          name: 'test list',
          reload: () => err({ code: 'forbidden', message: 'admins only' }),
          render: (data: string[], view: { error: string }, status: ContentfulStatusCode) => {
            void data;
            return c.text('never', status);
          },
          view: (e) => ({ error: e.message }),
          statusOf: () => 400,
        },
        { code: 'already-joined', message: 'someone else joined first' },
      ),
    );

    const res = await app.request('/test', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('logs and returns a generic 500 when the reload fails', async () => {
    const calls: Array<{ level: string; message: string }> = [];
    const logger: Logger = {
      log(level, message) {
        calls.push({ level, message });
      },
    };
    const app = new Hono<Env>();
    const pageError = createPageError<Env>(logger);
    app.post('/test', (c) =>
      pageError(
        c,
        actor,
        {
          name: 'test list',
          reload: () => err({ code: 'persistence', message: 'db down' }),
          render: (data: string[], view: { error: string }, status: ContentfulStatusCode) => {
            void data;
            return c.text('never', status);
          },
          view: (e) => ({ error: e.message }),
          statusOf: () => 400,
        },
        { code: 'already-joined', message: 'someone else joined first' },
      ),
    );

    const res = await app.request('/test', { method: 'POST' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal Server Error' });
    expect(calls).toHaveLength(1);
  });
});

describe('forbiddenPage', () => {
  it('renders the 403 shell with the actor in the masthead', async () => {
    const app = new Hono<Env>();
    app.get('/test', (c) => forbiddenPage(c, actor));

    const res = await app.request('/test');
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain('Forbidden');
    expect(text).toContain(actor.displayName);
  });
});

describe('paramId', () => {
  it('parses a positive integer id', async () => {
    const app = new Hono<Env>();
    app.get('/test/:id', (c) => {
      const parsed = paramId(c, 'id', 'gone');
      return parsed.isOk() ? c.text(String(parsed.value)) : c.text(parsed.error.message, 404);
    });

    const res = await app.request('/test/42');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('42');
  });

  it('rejects non-numeric ids as not-found', async () => {
    const app = new Hono<Env>();
    app.get('/test/:id', (c) => {
      const parsed = paramId(c, 'id', 'gone');
      return parsed.isOk() ? c.text(String(parsed.value)) : c.text(parsed.error.message, 404);
    });

    const res = await app.request('/test/abc');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('gone');
  });

  it('rejects zero and negative ids as not-found', async () => {
    const app = new Hono<Env>();
    app.get('/test/:id', (c) => {
      const parsed = paramId(c, 'id', 'gone');
      return parsed.isOk() ? c.text(String(parsed.value)) : c.text(parsed.error.message, 404);
    });

    expect((await app.request('/test/0')).status).toBe(404);
    expect((await app.request('/test/-3')).status).toBe(404);
  });

  it('rejects a missing id as not-found', async () => {
    const app = new Hono<Env>();
    app.get('/test/:id?', (c) => {
      const parsed = paramId(c, 'id', 'gone');
      return parsed.isOk() ? c.text(String(parsed.value)) : c.text(parsed.error.message, 404);
    });

    const res = await app.request('/test');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('gone');
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
    // Stored data gone bad is our fault too, and answered the same way.
    expect(statusForGameError(e('corrupt-record'))).toBe(500);
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
