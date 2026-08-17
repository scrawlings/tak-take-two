import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, runMigrations } from '../src/db.js';
import { createPersistence } from '../src/persistence.js';
import { createAuth, type SessionUser } from '../src/auth.js';
import { hashPassword, verifyPassword } from '../src/passwords.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

interface SeedUser {
  id: number;
  username: string;
  password: string;
  role?: 'player' | 'admin';
  force?: boolean;
  blocked?: boolean;
}

async function insertUser(db: Database.Database, seed: SeedUser): Promise<number> {
  const hash = await hashPassword(seed.password);
  db.prepare(
    'INSERT INTO users (id, username, display_name, password_hash, role, force_password_change, blocked) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(seed.id, seed.username, seed.username, hash, seed.role ?? 'player', seed.force ? 1 : 0, seed.blocked ? 1 : 0);
  return seed.id;
}

function adminActor(id = 1): SessionUser {
  return { id, username: 'admin', displayName: 'admin', role: 'admin', forcePasswordChange: false, blocked: false };
}

describe('auth: bootstrapAdmin', () => {
  it('creates the first admin with a forced change and a verifiable password', async () => {
    const db = makeDb();
    const auth = createAuth(createPersistence(db));

    const result = await auth.bootstrapAdmin();
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.username).toBe('admin');
    expect(result.value.password.length).toBeGreaterThan(20);

    const row = db.prepare("SELECT role, force_password_change, password_hash FROM users WHERE username = 'admin'").get() as {
      role: string;
      force_password_change: number;
      password_hash: string;
    };
    expect(row.role).toBe('admin');
    expect(row.force_password_change).toBe(1);
    expect(await verifyPassword(row.password_hash, result.value.password)).toBe(true);
  });

  it('refuses when an admin already exists', async () => {
    const db = makeDb();
    const auth = createAuth(createPersistence(db));
    await auth.bootstrapAdmin();

    const again = await auth.bootstrapAdmin();
    expect(again.isErr()).toBe(true);
    if (again.isOk()) return;
    expect(again.error.code).toBe('admin-exists');
  });
});

describe('auth: login', () => {
  it('creates a session for valid credentials and writes a sign-in trail event', async () => {
    const db = makeDb();
    await insertUser(db, { id: 1, username: 'alice', password: 'hunter2-password' });
    const auth = createAuth(createPersistence(db));

    const result = await auth.login('alice', 'hunter2-password');
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.sessionId.length).toBeGreaterThan(0);
    expect(result.value.user.username).toBe('alice');
    expect(result.value.user.role).toBe('player');

    const session = db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(result.value.sessionId) as
      | { user_id: number }
      | undefined;
    expect(session?.user_id).toBe(1);

    const trail = db.prepare('SELECT event FROM activity_trail WHERE user_id = 1').all() as Array<{ event: string }>;
    expect(trail.map((r) => r.event)).toContain('sign-in');
  });

  it('rejects an unknown username and a wrong password with the same error', async () => {
    const db = makeDb();
    await insertUser(db, { id: 1, username: 'alice', password: 'hunter2-password' });
    const auth = createAuth(createPersistence(db));

    const unknown = await auth.login('nobody', 'whatever-pass');
    const wrong = await auth.login('alice', 'wrong-password-123');
    expect(unknown.isErr()).toBe(true);
    expect(wrong.isErr()).toBe(true);
    if (unknown.isOk() || wrong.isOk()) return;
    expect(unknown.error.code).toBe('invalid-credentials');
    expect(wrong.error.code).toBe('invalid-credentials');
  });

  it('refuses a blocked user', async () => {
    const db = makeDb();
    await insertUser(db, { id: 1, username: 'alice', password: 'hunter2-password', blocked: true });
    const auth = createAuth(createPersistence(db));

    const result = await auth.login('alice', 'hunter2-password');
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe('user-blocked');
  });
});

describe('auth: logout', () => {
  it('deletes the session and writes a sign-out trail event', async () => {
    const db = makeDb();
    await insertUser(db, { id: 1, username: 'alice', password: 'hunter2-password' });
    const auth = createAuth(createPersistence(db));

    const login = await auth.login('alice', 'hunter2-password');
    if (login.isErr()) throw new Error('login failed');

    const out = auth.logout(login.value.sessionId);
    expect(out.isOk()).toBe(true);
    expect(auth.getSessionUser(login.value.sessionId).isErr()).toBe(true);

    const trail = db.prepare('SELECT event FROM activity_trail WHERE user_id = 1').all() as Array<{ event: string }>;
    expect(trail.map((r) => r.event)).toContain('sign-out');
  });

  it('is idempotent for an unknown session id', () => {
    const db = makeDb();
    const auth = createAuth(createPersistence(db));
    expect(auth.logout('does-not-exist').isOk()).toBe(true);
  });
});

describe('auth: changePassword', () => {
  it('replaces the hash, invalidates all sessions, and clears the force flag', async () => {
    const db = makeDb();
    await insertUser(db, { id: 1, username: 'alice', password: 'old-password-1', force: true });
    const auth = createAuth(createPersistence(db));

    const login = await auth.login('alice', 'old-password-1');
    if (login.isErr()) throw new Error('login failed');
    const oldSessionId = login.value.sessionId;

    const result = await auth.changePassword(1, 'old-password-1', 'new-password-2');
    expect(result.isOk()).toBe(true);

    const row = db.prepare('SELECT password_hash, force_password_change FROM users WHERE id = 1').get() as {
      password_hash: string;
      force_password_change: number;
    };
    expect(await verifyPassword(row.password_hash, 'new-password-2')).toBe(true);
    expect(row.force_password_change).toBe(0);

    expect(auth.getSessionUser(oldSessionId).isErr()).toBe(true);

    const trail = db.prepare('SELECT event FROM activity_trail WHERE user_id = 1').all() as Array<{ event: string }>;
    expect(trail.map((r) => r.event)).toContain('password-change');
  });

  it('rejects a wrong current password', async () => {
    const db = makeDb();
    await insertUser(db, { id: 1, username: 'alice', password: 'old-password-1' });
    const auth = createAuth(createPersistence(db));

    const result = await auth.changePassword(1, 'wrong-old-password', 'new-password-2');
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe('wrong-password');
  });

  it('rejects a weak new password', async () => {
    const db = makeDb();
    await insertUser(db, { id: 1, username: 'alice', password: 'old-password-1' });
    const auth = createAuth(createPersistence(db));

    const result = await auth.changePassword(1, 'old-password-1', 'short');
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe('weak-password');
  });
});

describe('auth: createUser', () => {
  it('an admin creates a player who is forced to change password on first login', async () => {
    const db = makeDb();
    const auth = createAuth(createPersistence(db));

    const result = await auth.createUser(adminActor(), { username: 'bob', password: 'initial-password' });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.username).toBe('bob');
    expect(result.value.displayName).toBe('bob');
    expect(result.value.forcePasswordChange).toBe(true);
    expect(result.value.role).toBe('player');
  });

  it('rejects a non-admin actor', async () => {
    const db = makeDb();
    const auth = createAuth(createPersistence(db));

    const result = await auth.createUser(
      { id: 2, username: 'bob', displayName: 'bob', role: 'player', forcePasswordChange: false, blocked: false },
      { username: 'carol', password: 'initial-password' },
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe('forbidden');
  });

  it('rejects a duplicate username', async () => {
    const db = makeDb();
    await insertUser(db, { id: 1, username: 'bob', password: 'whatever-pass' });
    const auth = createAuth(createPersistence(db));

    const result = await auth.createUser(adminActor(), { username: 'bob', password: 'initial-password' });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe('username-taken');
  });

  it('rejects a weak initial password and an invalid username', async () => {
    const db = makeDb();
    const auth = createAuth(createPersistence(db));

    const weak = await auth.createUser(adminActor(), { username: 'bob', password: 'short' });
    const badName = await auth.createUser(adminActor(), { username: 'bad name!', password: 'initial-password' });
    expect(weak.isErr()).toBe(true);
    expect(badName.isErr()).toBe(true);
    if (weak.isOk() || badName.isOk()) return;
    expect(weak.error.code).toBe('weak-password');
    expect(badName.error.code).toBe('invalid-username');
  });
});

describe('auth: getSessionUser', () => {
  it('resolves a session to its user without exposing the password hash', async () => {
    const db = makeDb();
    await insertUser(db, { id: 1, username: 'alice', password: 'hunter2-password' });
    const auth = createAuth(createPersistence(db));

    const login = await auth.login('alice', 'hunter2-password');
    if (login.isErr()) throw new Error('login failed');

    const result = auth.getSessionUser(login.value.sessionId);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.username).toBe('alice');
    expect(result.value).not.toHaveProperty('passwordHash');
  });

  it('returns not-authenticated for a missing session', () => {
    const db = makeDb();
    const auth = createAuth(createPersistence(db));

    const result = auth.getSessionUser('missing');
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe('not-authenticated');
  });
});

describe('auth: session persistence across restarts', () => {
  it('resolves a session after the database is closed and reopened', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tak-auth-'));
    const path = join(dir, 'test.db');
    try {
      let opened = openDatabase(path);
      expect(opened.isOk()).toBe(true);
      if (opened.isErr()) return;
      const db = opened.value;
      runMigrations(db);
      await insertUser(db, { id: 1, username: 'alice', password: 'hunter2-password' });

      const login = await createAuth(createPersistence(db)).login('alice', 'hunter2-password');
      expect(login.isOk()).toBe(true);
      if (login.isErr()) return;
      const sessionId = login.value.sessionId;
      db.close();

      opened = openDatabase(path);
      expect(opened.isOk()).toBe(true);
      if (opened.isErr()) return;
      const reopened = opened.value;
      expect(createAuth(createPersistence(reopened)).getSessionUser(sessionId).isOk()).toBe(true);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
