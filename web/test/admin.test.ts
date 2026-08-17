import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';
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
  displayName?: string;
  role?: 'player' | 'admin';
  force?: boolean;
  blocked?: boolean;
}

async function insertUser(db: Database.Database, seed: SeedUser): Promise<void> {
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

function adminActor(id = 1): SessionUser {
  return { id, username: 'admin', displayName: 'admin', role: 'admin', forcePasswordChange: false, blocked: false };
}

function playerActor(id: number, username: string, displayName = username): SessionUser {
  return { id, username, displayName, role: 'player', forcePasswordChange: false, blocked: false };
}

describe('admin: listUsers read', () => {
  it('an admin sees all users without password hashes, ordered by username', async () => {
    const db = makeDb();
    await insertUser(db, { id: 1, username: 'admin', password: 'admin-pass-1', role: 'admin' });
    await insertUser(db, { id: 2, username: 'alice', password: 'alice-pass-1' });
    await insertUser(db, { id: 3, username: 'bob', password: 'bob-pass-123' });
    const auth = createAuth(createPersistence(db));

    const result = auth.listUsers(adminActor(1));
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.map((u) => u.username)).toEqual(['admin', 'alice', 'bob']);
    expect(result.value.every((u) => !('passwordHash' in u))).toBe(true);
  });

  it('a non-admin is forbidden', async () => {
    const db = makeDb();
    const auth = createAuth(createPersistence(db));

    const result = auth.listUsers(playerActor(9, 'mallory'));
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe('forbidden');
  });
});

describe('admin: blockUser / unblockUser commands', () => {
  it('blocking invalidates sessions and refuses login; unblocking restores access', async () => {
    const db = makeDb();
    await insertUser(db, { id: 2, username: 'alice', password: 'alice-pass-1' });
    const auth = createAuth(createPersistence(db));

    const login = await auth.applyAuth(null, { type: 'login', username: 'alice', password: 'alice-pass-1' });
    if (login.isErr() || login.value.type !== 'login') throw new Error('login failed');
    const sessionId = login.value.sessionId;

    expect((await auth.applyAuth(adminActor(1), { type: 'blockUser', userId: 2 })).isOk()).toBe(true);
    expect(auth.getSessionUser(sessionId).isErr()).toBe(true);

    const relogin = await auth.applyAuth(null, { type: 'login', username: 'alice', password: 'alice-pass-1' });
    expect(relogin.isErr()).toBe(true);
    if (relogin.isOk()) return;
    expect(relogin.error.code).toBe('user-blocked');

    expect((await auth.applyAuth(adminActor(1), { type: 'unblockUser', userId: 2 })).isOk()).toBe(true);
    const after = await auth.applyAuth(null, { type: 'login', username: 'alice', password: 'alice-pass-1' });
    expect(after.isOk()).toBe(true);
  });

  it('a non-admin cannot block', async () => {
    const db = makeDb();
    await insertUser(db, { id: 2, username: 'alice', password: 'alice-pass-1' });
    const auth = createAuth(createPersistence(db));

    const result = await auth.applyAuth(playerActor(9, 'mallory'), { type: 'blockUser', userId: 2 });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe('forbidden');
  });

  it('an admin cannot block their own account', async () => {
    const db = makeDb();
    await insertUser(db, { id: 1, username: 'admin', password: 'admin-pass-1', role: 'admin' });
    const auth = createAuth(createPersistence(db));

    const result = await auth.applyAuth(adminActor(1), { type: 'blockUser', userId: 1 });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe('cannot-block-self');
  });

  it('blocking an unknown user is not-found', async () => {
    const db = makeDb();
    const auth = createAuth(createPersistence(db));

    const result = await auth.applyAuth(adminActor(1), { type: 'blockUser', userId: 999 });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe('not-found');
  });
});

describe('admin: forcePasswordChange command', () => {
  it('sets the force flag on the target account', async () => {
    const db = makeDb();
    await insertUser(db, { id: 2, username: 'alice', password: 'alice-pass-1' });
    const auth = createAuth(createPersistence(db));

    const login = await auth.applyAuth(null, { type: 'login', username: 'alice', password: 'alice-pass-1' });
    if (login.isErr() || login.value.type !== 'login') throw new Error('login failed');

    expect((await auth.applyAuth(adminActor(1), { type: 'forcePasswordChange', userId: 2 })).isOk()).toBe(true);
    const user = auth.getSessionUser(login.value.sessionId);
    expect(user.isOk()).toBe(true);
    if (user.isErr()) return;
    expect(user.value.forcePasswordChange).toBe(true);
  });
});

describe('admin: resetPassword command', () => {
  it('generates a password that verifies, forces a change, and clears sessions', async () => {
    const db = makeDb();
    await insertUser(db, { id: 2, username: 'alice', password: 'alice-pass-1' });
    const auth = createAuth(createPersistence(db));

    const login = await auth.applyAuth(null, { type: 'login', username: 'alice', password: 'alice-pass-1' });
    if (login.isErr() || login.value.type !== 'login') throw new Error('login failed');
    const sessionId = login.value.sessionId;

    const result = await auth.applyAuth(adminActor(1), { type: 'resetPassword', userId: 2 });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.type).toBe('resetPassword');
    if (result.value.type !== 'resetPassword') return;
    expect(result.value.username).toBe('alice');
    expect(result.value.password.length).toBeGreaterThan(20);

    const row = db.prepare('SELECT password_hash, force_password_change FROM users WHERE id = 2').get() as {
      password_hash: string;
      force_password_change: number;
    };
    expect(await verifyPassword(row.password_hash, 'alice-pass-1')).toBe(false);
    expect(await verifyPassword(row.password_hash, result.value.password)).toBe(true);
    expect(row.force_password_change).toBe(1);
    expect(auth.getSessionUser(sessionId).isErr()).toBe(true);

    const trail = db.prepare('SELECT event FROM activity_trail WHERE user_id = 2').all() as Array<{ event: string }>;
    expect(trail.map((r) => r.event)).toContain('password-reset');
  });

  it('a non-admin cannot reset', async () => {
    const db = makeDb();
    await insertUser(db, { id: 2, username: 'alice', password: 'alice-pass-1' });
    const auth = createAuth(createPersistence(db));

    const result = await auth.applyAuth(playerActor(9, 'mallory'), { type: 'resetPassword', userId: 2 });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe('forbidden');
  });
});

describe('auth: changeDisplayName command', () => {
  it('changes the owner display name and writes a trail event', async () => {
    const db = makeDb();
    await insertUser(db, { id: 2, username: 'alice', password: 'alice-pass-1' });
    const auth = createAuth(createPersistence(db));

    const result = await auth.applyAuth(playerActor(2, 'alice'), { type: 'changeDisplayName', displayName: 'Alice Wonder' });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.type).toBe('changeDisplayName');
    if (result.value.type !== 'changeDisplayName') return;
    expect(result.value.user.displayName).toBe('Alice Wonder');

    const row = db.prepare('SELECT display_name FROM users WHERE id = 2').get() as { display_name: string };
    expect(row.display_name).toBe('Alice Wonder');

    const trail = db.prepare('SELECT event FROM activity_trail WHERE user_id = 2').all() as Array<{ event: string }>;
    expect(trail.map((r) => r.event)).toContain('display-name-change');
  });

  it('rejects a display name already used by another user', async () => {
    const db = makeDb();
    await insertUser(db, { id: 2, username: 'alice', password: 'alice-pass-1' });
    await insertUser(db, { id: 3, username: 'bob', password: 'bob-pass-123' });
    const auth = createAuth(createPersistence(db));

    const result = await auth.applyAuth(playerActor(2, 'alice'), { type: 'changeDisplayName', displayName: 'bob' });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe('display-name-taken');
  });

  it('allows keeping the same display name', async () => {
    const db = makeDb();
    await insertUser(db, { id: 2, username: 'alice', password: 'alice-pass-1' });
    const auth = createAuth(createPersistence(db));
    const result = await auth.applyAuth(playerActor(2, 'alice'), { type: 'changeDisplayName', displayName: 'alice' });
    expect(result.isOk()).toBe(true);
  });

  it('rejects an empty or over-long display name', async () => {
    const db = makeDb();
    const auth = createAuth(createPersistence(db));

    const empty = await auth.applyAuth(playerActor(2, 'alice'), { type: 'changeDisplayName', displayName: '   ' });
    const tooLong = await auth.applyAuth(playerActor(2, 'alice'), { type: 'changeDisplayName', displayName: 'x'.repeat(65) });
    expect(empty.isErr()).toBe(true);
    expect(tooLong.isErr()).toBe(true);
    if (empty.isOk() || tooLong.isOk()) return;
    expect(empty.error.code).toBe('invalid-display-name');
    expect(tooLong.error.code).toBe('invalid-display-name');
  });
});
