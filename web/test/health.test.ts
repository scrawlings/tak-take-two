import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ok, err } from 'neverthrow';
import { runMigrations } from '../src/db.js';
import { createPersistence, type Persistence } from '../src/persistence.js';
import { createApp } from '../src/app.js';
import { Metrics } from '../src/metrics.js';
import type { Logger } from '../src/logging.js';

const silent: Logger = { log() {} };

function makeApp() {
  const db = new Database(':memory:');
  runMigrations(db);
  return {
    app: createApp({ persistence: createPersistence(db), metrics: new Metrics(), logger: silent }),
    db,
  };
}

describe('health endpoints', () => {
  it('GET /healthz returns 200 with a request id header', async () => {
    const { app } = makeApp();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('GET /readyz returns 200 when the database responds', async () => {
    const { app } = makeApp();
    const res = await app.request('/readyz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'ok' });
  });

  it('GET /readyz returns 503 when the database check fails', async () => {
    const failingPersistence = {
      ping: () => err('db down'),
      metricsSnapshot: () => ({ activeSessions: 0, gamesByState: [], databaseSizeBytes: 0 }),
      appendActivityTrail: () => ok(undefined),
    } as unknown as Persistence;
    const app = createApp({ persistence: failingPersistence, metrics: new Metrics(), logger: silent });
    const res = await app.request('/readyz');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unavailable', db: 'error' });
  });
});
