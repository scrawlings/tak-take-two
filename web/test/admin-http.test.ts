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
  runMigrations(db);
  return {
    app: createApp({ persistence: createPersistence(db), metrics: new Metrics(), logger: silent }),
    db,
  };
}

async function insertUser(
  db: Database.Database,
  seed: {
    id: number;
    username: string;
    password: string;
    displayName?: string;
    role?: 'player' | 'admin';
    force?: boolean;
    blocked?: boolean;
  },
): Promise<void> {
  const hash = await hashPassword(seed.password);
  db.prepare(
    'INSERT INTO users (id, username, display_name, password_hash, role, force_password_change, blocked) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    seed.id,
    seed.username,
    seed.displayName ?? seed.username,
    hash,
    seed.role ?? 'player',
    seed.force ? 1 : 0,
    seed.blocked ? 1 : 0,
  );
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
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

async function loginAs(app: App, username: string, password: string): Promise<string> {
  const res = await app.request('/login', form({ username, password }));
  expect(res.status).toBe(303);
  const sid = sessionCookie(res);
  expect(sid).toBeTruthy();
  return sid as string;
}

async function setupAdmin(app: App, db: Database.Database): Promise<string> {
  await insertUser(db, { id: 1, username: 'admin', password: 'admin-pass-1', role: 'admin' });
  return loginAs(app, 'admin', 'admin-pass-1');
}

describe('admin HTTP', () => {
  it('forbids a non-admin from the admin section', async () => {
    const { app, db } = makeApp();
    await insertUser(db, { id: 2, username: 'alice', password: 'alice-pass-1' });
    const alice = await loginAs(app, 'alice', 'alice-pass-1');

    const res = await app.request('/admin/users', withCookie({ method: 'GET' }, alice));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Forbidden');
  });

  it('lists users for an admin', async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app, db);
    await insertUser(db, { id: 2, username: 'alice', password: 'alice-pass-1' });

    const res = await app.request('/admin/users', withCookie({ method: 'GET' }, admin));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('alice');
    expect(html).toContain('admin');
  });

  it('lets an admin create a user that must change password on first login', async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app, db);

    const res = await app.request(
      '/admin/users',
      withCookie(form({ username: 'bob', password: 'initial-password' }), admin),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/users');

    const list = await app.request('/admin/users', withCookie({ method: 'GET' }, admin));
    expect(await list.text()).toContain('bob');

    const row = db.prepare('SELECT force_password_change FROM users WHERE username = ?').get('bob') as {
      force_password_change: number;
    };
    expect(row.force_password_change).toBe(1);
  });

  it('blocking stops all access and unblocking restores it', async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app, db);
    await insertUser(db, { id: 2, username: 'alice', password: 'alice-pass-1' });
    const alice = await loginAs(app, 'alice', 'alice-pass-1');

    const block = await app.request('/admin/users/2/block', withCookie({ method: 'POST' }, admin));
    expect(block.status).toBe(303);

    const stale = await app.request('/account', withCookie({ method: 'GET' }, alice));
    expect(stale.status).toBe(303);
    expect(stale.headers.get('location')).toBe('/login');

    const relogin = await app.request('/login', form({ username: 'alice', password: 'alice-pass-1' }));
    expect(relogin.status).toBe(401);

    const unblock = await app.request('/admin/users/2/unblock', withCookie({ method: 'POST' }, admin));
    expect(unblock.status).toBe(303);

    const after = await loginAs(app, 'alice', 'alice-pass-1');
    const account = await app.request('/account', withCookie({ method: 'GET' }, after));
    expect(account.status).toBe(200);
  });

  it('forcing a password change gates the user', async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app, db);
    await insertUser(db, { id: 2, username: 'alice', password: 'alice-pass-1' });
    const alice = await loginAs(app, 'alice', 'alice-pass-1');

    const force = await app.request('/admin/users/2/force-password-change', withCookie({ method: 'POST' }, admin));
    expect(force.status).toBe(303);

    const account = await app.request('/account', withCookie({ method: 'GET' }, alice));
    expect(account.status).toBe(303);
    expect(account.headers.get('location')).toBe('/account/password');
  });

  it('resetting a password shows a new one that works and forces a change', async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app, db);
    await insertUser(db, { id: 2, username: 'alice', password: 'alice-pass-1' });

    const reset = await app.request('/admin/users/2/reset-password', withCookie({ method: 'POST' }, admin));
    expect(reset.status).toBe(200);
    const html = await reset.text();
    const m = /id="reset-password">([^<]+)</.exec(html);
    expect(m).toBeTruthy();
    const newPassword = m?.[1] ?? '';

    const oldLogin = await app.request('/login', form({ username: 'alice', password: 'alice-pass-1' }));
    expect(oldLogin.status).toBe(401);

    const relogin = await app.request('/login', form({ username: 'alice', password: newPassword }));
    expect(relogin.status).toBe(303);
    const sid = sessionCookie(relogin) as string;
    const account = await app.request('/account', withCookie({ method: 'GET' }, sid));
    expect(account.status).toBe(303);
    expect(account.headers.get('location')).toBe('/account/password');
  });

  it('lets a user change their own display name, enforcing uniqueness', async () => {
    const { app, db } = makeApp();
    await insertUser(db, { id: 2, username: 'alice', password: 'alice-pass-1' });
    await insertUser(db, { id: 3, username: 'bob', password: 'bob-pass-123' });
    const alice = await loginAs(app, 'alice', 'alice-pass-1');

    const change = await app.request(
      '/account/display-name',
      withCookie(form({ display_name: 'Alice Wonder' }), alice),
    );
    expect(change.status).toBe(303);
    expect(change.headers.get('location')).toBe('/account');

    const account = await app.request('/account', withCookie({ method: 'GET' }, alice));
    expect(await account.text()).toContain('Alice Wonder');

    const clash = await app.request(
      '/account/display-name',
      withCookie(form({ display_name: 'bob' }), alice),
    );
    expect(clash.status).toBe(400);
    expect(await clash.text()).toContain('already in use');
  });
});
