import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';
import { createApp } from '../src/app.js';
import { Metrics } from '../src/metrics.js';
import type { Logger } from '../src/logging.js';

const silent: Logger = { log() {} };

describe('/metrics', () => {
  it('returns Prometheus text format', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const app = createApp({ db, metrics: new Metrics(), logger: silent });

    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');

    const body = await res.text();
    expect(body).toContain('# HELP http_requests_total');
    expect(body).toContain('# TYPE http_requests_total counter');
    expect(body).toContain('http_requests_total');
    expect(body).toContain('# TYPE tak_active_sessions gauge');
    expect(body).toContain('tak_active_sessions 0');
    expect(body).toContain('tak_database_size_bytes');
  });

  it('counts requests it has already handled', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const metrics = new Metrics();
    const app = createApp({ db, metrics, logger: silent });

    await app.request('/healthz');

    const body = await (await app.request('/metrics')).text();
    expect(body).toContain('route="/healthz"');
    expect(body).toContain('status="200"');
  });
});
