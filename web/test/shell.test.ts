import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';
import { createPersistence } from '../src/persistence.js';
import { createApp } from '../src/app.js';
import { Metrics } from '../src/metrics.js';
import type { Logger } from '../src/logging.js';

const silent: Logger = { log() {} };

function makeApp() {
  const db = new Database(':memory:');
  runMigrations(db);
  return createApp({ persistence: createPersistence(db), metrics: new Metrics(), logger: silent });
}

describe('base page shell', () => {
  it('serves a shell that loads datastar and Alpine', async () => {
    const app = makeApp();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('datastar');
    expect(html).toContain('alpinejs');
  });

  it('serves the status page with the same shell', async () => {
    const app = makeApp();
    const res = await app.request('/status');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>Status</h1>');
    expect(html).toContain('datastar');
  });
});
