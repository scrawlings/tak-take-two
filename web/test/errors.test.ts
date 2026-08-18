import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';
import { createPersistence } from '../src/persistence.js';
import { createApp } from '../src/app.js';
import { Metrics } from '../src/metrics.js';
import type { Logger } from '../src/logging.js';

const silent: Logger = { log() {} };

describe('error handling', () => {
  it('returns a generic 500 with a request id when a handler throws', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const app = createApp({ persistence: createPersistence(db), metrics: new Metrics(), logger: silent });

    // A route registered after createApp still goes through the shared error handler.
    app.get('/boom', () => {
      throw new Error('secret internal detail');
    });

    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal Server Error' });
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('does not leak the underlying error message', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const app = createApp({ persistence: createPersistence(db), metrics: new Metrics(), logger: silent });

    app.get('/boom', () => {
      throw new Error('secret internal detail');
    });

    const body = await (await app.request('/boom')).text();
    expect(body).not.toContain('secret internal detail');
  });
});
