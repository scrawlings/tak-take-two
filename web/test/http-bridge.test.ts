import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import Database from 'better-sqlite3';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { runMigrations } from '../src/db.js';
import { createPersistence } from '../src/persistence.js';
import { createApp, type App } from '../src/app.js';
import { Metrics } from '../src/metrics.js';
import type { Logger } from '../src/logging.js';
import { createHandler, toFetchRequest, translateResponse } from '../src/http-bridge.js';

const silent: Logger = { log() {} };

const enc = new TextEncoder();

describe('toFetchRequest', () => {
  it('builds the URL from the host header and path', () => {
    const req = toFetchRequest({ method: 'GET', url: '/healthz', headers: { host: 'example.com' }, body: null });
    expect(req.method).toBe('GET');
    expect(req.url).toBe('http://example.com/healthz');
  });

  it('defaults the host to localhost', () => {
    const req = toFetchRequest({ method: 'GET', url: '/', headers: {}, body: null });
    expect(req.url).toBe('http://localhost/');
  });

  it('strips hop-by-hop headers', () => {
    const req = toFetchRequest({
      method: 'GET',
      url: '/',
      headers: {
        host: 'example.com',
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        upgrade: 'websocket',
        te: 'trailers',
        'x-custom': 'v',
      },
      body: null,
    });
    for (const name of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te']) {
      expect(req.headers.get(name)).toBeNull();
    }
    expect(req.headers.get('x-custom')).toBe('v');
  });

  it('appends multi-value headers individually', () => {
    const req = toFetchRequest({
      method: 'GET',
      url: '/',
      headers: { host: 'example.com', cookie: ['a=1', 'b=2'] },
      body: null,
    });
    // Both values appended; Headers combines cookie values with '; ' (node semantics).
    expect(req.headers.get('cookie')).toBe('a=1; b=2');
  });

  it('suppresses the body for GET and HEAD', () => {
    for (const method of ['GET', 'HEAD']) {
      const req = toFetchRequest({
        method,
        url: '/',
        headers: {},
        body: enc.encode('must not be sent'),
      });
      expect(req.body).toBeNull();
    }
  });

  it('passes the body through for methods that carry one', async () => {
    const req = toFetchRequest({
      method: 'POST',
      url: '/echo',
      headers: { host: 'example.com' },
      body: enc.encode('hello bridge'),
    });
    expect(await req.text()).toBe('hello bridge');
  });
});

describe('translateResponse', () => {
  it('maps status and headers', () => {
    const response = new Response('hi', { status: 201, headers: { 'x-a': '1' } });
    const plan = translateResponse(response);
    expect(plan.statusCode).toBe(201);
    expect(plan.headers).toContainEqual(['x-a', '1']);
    expect(plan.body).not.toBeNull();
  });

  it('flattens set-cookie from getSetCookie(), once per cookie', () => {
    const response = new Response('hi', { status: 200, headers: { 'set-cookie': 'a=1' } });
    response.headers.append('set-cookie', 'b=2');
    const plan = translateResponse(response);
    const cookies = plan.headers
      .filter(([name]) => name === 'set-cookie')
      .map(([, value]) => value);
    expect(cookies).toEqual(['a=1', 'b=2']);
  });

  it('reports a null body when there is none', () => {
    const plan = translateResponse(new Response(null, { status: 204 }));
    expect(plan.body).toBeNull();
    expect(plan.headers).toEqual([]);
  });
});

/** A minimal node request: async-iterable body, plain headers. */
function fakeNodeReq(opts: { method: string; url: string; headers: Record<string, unknown>; body?: Uint8Array }): IncomingMessage {
  const chunks = opts.body === undefined ? [] : [opts.body];
  const req = {
    method: opts.method,
    url: opts.url,
    headers: opts.headers,
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  };
  return req as unknown as IncomingMessage;
}

/** A real Writable standing in for ServerResponse: collects what the bridge writes. */
class FakeNodeRes extends Writable {
  statusCode = 0;
  headersSent = false;
  readonly writtenHeaders: Record<string, unknown> = {};
  readonly chunks: Buffer[] = [];

  setHeader(name: string, value: unknown): void {
    this.writtenHeaders[name.toLowerCase()] = value;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

function finished(res: FakeNodeRes): Promise<void> {
  return new Promise((resolve) => res.on('finish', () => resolve()));
}

function makeApp(): App {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return createApp({ persistence: createPersistence(db), metrics: new Metrics(), logger: silent });
}

describe('createHandler', () => {
  it('serves a request end to end through the bridge', async () => {
    const handler = createHandler({ app: makeApp(), logger: silent });
    const res = new FakeNodeRes();
    const done = finished(res);

    await handler(
      fakeNodeReq({ method: 'GET', url: '/healthz', headers: { host: 'localhost' } }),
      res as unknown as ServerResponse,
    );
    await done;

    expect(res.statusCode).toBe(200);
    expect(res.writtenHeaders['x-request-id']).toBeTruthy();
    expect(Buffer.concat(res.chunks).toString()).toBe('{"status":"ok"}');
  });

  it('buffers a request body and delivers it to the app', async () => {
    const app = makeApp();
    app.post('/echo', async (c) => c.text(await c.req.text()));
    const handler = createHandler({ app, logger: silent });
    const res = new FakeNodeRes();
    const done = finished(res);

    await handler(
      fakeNodeReq({
        method: 'POST',
        url: '/echo',
        headers: { host: 'localhost', 'content-type': 'text/plain' },
        body: enc.encode('hello bridge'),
      }),
      res as unknown as ServerResponse,
    );
    await done;

    expect(res.statusCode).toBe(200);
    expect(Buffer.concat(res.chunks).toString()).toBe('hello bridge');
  });

  it('writes a generic 500 when app.fetch itself throws before headers are sent', async () => {
    const throwingApp = { fetch: async () => { throw new Error('boom'); } } as unknown as App;
    const handler = createHandler({ app: throwingApp, logger: silent });
    const res = new FakeNodeRes();
    const done = finished(res);

    await handler(fakeNodeReq({ method: 'GET', url: '/boom', headers: { host: 'localhost' } }), res as unknown as ServerResponse);
    await done;

    expect(res.statusCode).toBe(500);
    expect(res.writtenHeaders['content-type']).toBe('application/json');
    expect(Buffer.concat(res.chunks).toString()).toBe('{"error":"Internal Server Error"}');
  });

  it('ends without writing when headers were already sent', async () => {
    const throwingApp = { fetch: async () => { throw new Error('boom'); } } as unknown as App;
    const handler = createHandler({ app: throwingApp, logger: silent });
    const res = new FakeNodeRes();
    res.headersSent = true;

    await handler(fakeNodeReq({ method: 'GET', url: '/boom', headers: { host: 'localhost' } }), res as unknown as ServerResponse);

    expect(res.statusCode).toBe(0);
    expect(res.chunks).toHaveLength(0);
  });
});
