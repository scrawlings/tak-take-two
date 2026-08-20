import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';
import { createPersistence } from '../src/persistence.js';
import { createApp } from '../src/app.js';
import { Metrics } from '../src/metrics.js';
import type { Logger } from '../src/logging.js';
import { renderShell } from '../src/html.js';
import { hashPassword } from '../src/passwords.js';

const silent: Logger = { log() {} };

function makeApp() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return createApp({ persistence: createPersistence(db), metrics: new Metrics(), logger: silent });
}

/** An app with a player and an admin signed in, for the per-page script checks. */
async function signedInApp(): Promise<{ app: ReturnType<typeof makeApp>; player: string; admin: string }> {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const app = createApp({ persistence: createPersistence(db), metrics: new Metrics(), logger: silent });
  for (const [id, username, role] of [
    [1, 'aoife', 'player'],
    [2, 'root', 'admin'],
  ] as const) {
    db.prepare('INSERT INTO users (id, username, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?)').run(
      id,
      username,
      username,
      await hashPassword('a good password'),
      role,
    );
  }
  const signIn = async (username: string): Promise<string> => {
    const res = await app.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password: 'a good password' }).toString(),
    });
    return /tak_session=([^;]+)/.exec(res.headers.getSetCookie()[0] ?? '')?.[1] ?? '';
  };
  return { app, player: await signIn('aoife'), admin: await signIn('root') };
}

/**
 * ADR-0007: one client runtime, loaded per page. Datastar is gone, and a page
 * that needs no client code ships none.
 */
describe('base page shell', () => {
  it('ships no client runtime to a page that asked for none', () => {
    const html = renderShell('Plain', '<h1>Plain</h1>');

    expect(html).not.toContain('<script');
    expect(html).toContain('<h1>Plain</h1>');
  });

  it('loads Alpine for a page that asks for it', () => {
    const html = renderShell('Interactive', '', { scripts: 'alpine' });

    expect(html).toContain('alpinejs');
  });

  it('loads Alpine and the served bundle for a page that asks for the client', () => {
    const html = renderShell('Client', '', { scripts: 'client' });

    expect(html).toContain('alpinejs');
    // The bundle is a served file (ADR-0013), referenced by URL — not inlined.
    expect(html).toContain('src="/client.js"');
    expect(html).not.toContain('takBoard'); // it lives in the file, not the page
  });

  it('runs the bundle before Alpine, which it registers its components on', () => {
    const html = renderShell('Client', '', { scripts: 'client' });

    expect(html.indexOf('src="/client.js"')).toBeLessThan(html.indexOf('alpinejs'));
  });

  it('loads no datastar anywhere — ADR-0007 dropped it', () => {
    for (const scripts of ['none', 'alpine', 'client'] as const) {
      expect(renderShell('t', '', { scripts })).not.toContain('datastar');
    }
  });

  it('serves the landing page with no client runtime', async () => {
    const app = makeApp();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script');
  });

  it('serves the stylesheet and the client bundle as files (ADR-0013)', async () => {
    const app = makeApp();

    const css = await app.request('/site.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(await css.text()).toContain('--stone');

    const js = await app.request('/client.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(await js.text()).toContain('takBoard');
  });

  it('serves the status page with the same shell and no client runtime', async () => {
    const app = makeApp();
    const res = await app.request('/status');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>Status</h1>');
    expect(html).not.toContain('<script');
  });

  it('serves the sign-in page with no client runtime', async () => {
    const app = makeApp();
    const html = await (await app.request('/login')).text();
    expect(html).not.toContain('<script');
  });

  it('ships no client runtime to any of the pages that have no client code', async () => {
    // The checklist names these by page, so they are pinned by page rather
    // than by trusting the `scripts` default.
    const { app, player, admin } = await signedInApp();
    const pages: Array<[string, string]> = [
      ['/account', player],
      ['/account/password', player],
      ['/account/display-name', player],
      ['/admin/users', admin],
      ['/admin/games', admin],
    ];
    for (const [path, session] of pages) {
      const res = await app.request(path, { headers: { cookie: `tak_session=${session}` } });
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).not.toContain('<script');
    }
  });

  it('gives the streamed pages the client bundle, since they carry components', async () => {
    const { app, player } = await signedInApp();
    for (const path of ['/games', '/games/find']) {
      const html = await (await app.request(path, { headers: { cookie: `tak_session=${player}` } })).text();
      expect(html, path).toContain('takStream');
      expect(html, path).toContain('alpinejs');
    }
  });
});
