import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';
import { createPersistence } from '../src/persistence.js';
import { createApp, type App } from '../src/app.js';
import { Metrics } from '../src/metrics.js';
import type { Logger } from '../src/logging.js';
import { hashPassword } from '../src/passwords.js';

const silent: Logger = { log() {} };

function makeApp(): { app: App; db: Database.Database } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return {
    app: createApp({ persistence: createPersistence(db), metrics: new Metrics(), logger: silent }),
    db,
  };
}

async function insertUser(
  db: Database.Database,
  seed: { id: number; username: string; password: string; force?: boolean; blocked?: boolean },
): Promise<void> {
  const hash = await hashPassword(seed.password);
  db.prepare(
    'INSERT INTO users (id, username, display_name, password_hash, role, force_password_change, blocked) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(seed.id, seed.username, seed.username, hash, 'player', seed.force ? 1 : 0, seed.blocked ? 1 : 0);
}

function form(init: { url: string; fields: Record<string, string> }): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(init.fields).toString(),
  };
}

function sessionCookie(res: Response): string | null {
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('tak_session='));
  if (!cookie) return null;
  const m = /tak_session=([^;]+)/.exec(cookie);
  return m ? (m[1] ?? null) : null;
}

function withCookie(init: RequestInit, sessionId: string): RequestInit {
  return {
    ...init,
    headers: { ...((init.headers as Record<string, string> | undefined) ?? {}), cookie: `tak_session=${sessionId}` },
  };
}

describe('auth HTTP', () => {
  it('renders the login form', async () => {
    const { app } = makeApp();
    const res = await app.request('/login');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>Sign in</h1>');
    expect(html).toContain('action="/login"');
  });

  it('signs in with a session cookie and serves the account page', async () => {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'alice', password: 'hunter2-password' });

    const res = await app.request('/login', form({ url: '/login', fields: { username: 'alice', password: 'hunter2-password' } }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/account');

    const cookie = res.headers.getSetCookie()[0];
    expect(cookie).toContain('tak_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');

    const sessionId = sessionCookie(res);
    expect(sessionId).toBeTruthy();

    const account = await app.request('/account', withCookie({ method: 'GET' }, sessionId as string));
    expect(account.status).toBe(200);
    expect(await account.text()).toContain('alice');

    const trail = db.prepare('SELECT event FROM activity_trail WHERE user_id = 1').all() as Array<{ event: string }>;
    expect(trail.map((r) => r.event)).toContain('sign-in');
  });

  it('rejects bad credentials without setting a cookie', async () => {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'alice', password: 'hunter2-password' });

    const res = await app.request('/login', form({ url: '/login', fields: { username: 'alice', password: 'wrong' } }));
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Unknown username or password.');
    expect(sessionCookie(res)).toBeNull();
  });

  it('rejects an empty login submission', async () => {
    const { app } = makeApp();
    const res = await app.request('/login', form({ url: '/login', fields: { username: '', password: '' } }));
    expect(res.status).toBe(401);
    expect(sessionCookie(res)).toBeNull();
  });

  it('refuses a blocked user at login', async () => {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'alice', password: 'hunter2-password', blocked: true });

    const res = await app.request('/login', form({ url: '/login', fields: { username: 'alice', password: 'hunter2-password' } }));
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('blocked');
  });

  it('logs out and clears the session cookie', async () => {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'alice', password: 'hunter2-password' });

    const login = await app.request('/login', form({ url: '/login', fields: { username: 'alice', password: 'hunter2-password' } }));
    const sessionId = sessionCookie(login);
    expect(sessionId).toBeTruthy();

    const out = await app.request('/logout', withCookie({ method: 'POST' }, sessionId as string));
    expect(out.status).toBe(303);
    expect(out.headers.get('location')).toBe('/login');
    expect(out.headers.getSetCookie().some((c) => c.includes('Max-Age=0'))).toBe(true);

    const account = await app.request('/account', withCookie({ method: 'GET' }, sessionId as string));
    expect(account.status).toBe(303);
    expect(account.headers.get('location')).toBe('/login');
  });

  it('gates every action behind a forced password change', async () => {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'alice', password: 'initial-password', force: true });

    const login = await app.request('/login', form({ url: '/login', fields: { username: 'alice', password: 'initial-password' } }));
    const sessionId = sessionCookie(login);
    expect(sessionId).toBeTruthy();

    // The account page is refused…
    const account = await app.request('/account', withCookie({ method: 'GET' }, sessionId as string));
    expect(account.status).toBe(303);
    expect(account.headers.get('location')).toBe('/account/password');

    // …but the change form itself is reachable.
    const change = await app.request('/account/password', withCookie({ method: 'GET' }, sessionId as string));
    expect(change.status).toBe(200);
  });

  it('completes a forced change, invalidates the old session, and allows sign-in with the new password', async () => {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'alice', password: 'initial-password', force: true });

    const login = await app.request('/login', form({ url: '/login', fields: { username: 'alice', password: 'initial-password' } }));
    const sessionId = sessionCookie(login) as string;

    const change = await app.request(
      '/account/password',
      withCookie(form({ url: '/account/password', fields: { old_password: 'initial-password', new_password: 'brand-new-password' } }), sessionId),
    );
    expect(change.status).toBe(303);
    expect(change.headers.get('location')).toBe('/login?changed=1');

    // The old session no longer works.
    const stale = await app.request('/account', withCookie({ method: 'GET' }, sessionId));
    expect(stale.status).toBe(303);
    expect(stale.headers.get('location')).toBe('/login');

    // Signing in again with the new password reaches the account page.
    const relogin = await app.request('/login', form({ url: '/login', fields: { username: 'alice', password: 'brand-new-password' } }));
    const newSession = sessionCookie(relogin) as string;
    const account = await app.request('/account', withCookie({ method: 'GET' }, newSession));
    expect(account.status).toBe(200);
    expect(await account.text()).toContain('alice');
  });

  it('rejects a password change with the wrong current password', async () => {
    const { app, db } = makeApp();
    await insertUser(db, { id: 1, username: 'alice', password: 'hunter2-password' });

    const login = await app.request('/login', form({ url: '/login', fields: { username: 'alice', password: 'hunter2-password' } }));
    const sessionId = sessionCookie(login) as string;

    const change = await app.request(
      '/account/password',
      withCookie(form({ url: '/account/password', fields: { old_password: 'nope', new_password: 'brand-new-password' } }), sessionId),
    );
    expect(change.status).toBe(400);
    expect(await change.text()).toContain('Current password is incorrect.');
  });
});
