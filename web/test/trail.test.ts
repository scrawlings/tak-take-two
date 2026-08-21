import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ok, err } from 'neverthrow';
import { runMigrations } from '../src/db.js';
import { createPersistence, type Persistence } from '../src/persistence.js';
import { createTrail, type Trail, type TrailEvent } from '../src/trail.js';

/**
 * The activity trail at its interface. The rules under test are the three the
 * module exists to make structural: an entry commits with the writes it
 * describes, a failure arrives as one error shape, and a malformed entry does
 * not compile. Runs against a real database because atomicity is the point —
 * a stub would prove nothing about rollback.
 */

function setup(): { db: Database.Database; persistence: Persistence; trail: Trail; gameId: number } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    'INSERT INTO users (id, username, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?)',
  ).run(1, 'aoife', 'Aoife Nolan', 'hash', 'player');
  const persistence = createPersistence(db);
  // A real game, so entries carrying a gameId satisfy the foreign key.
  const game = persistence
    .createGame({
      boardSize: 5,
      joinType: 'open',
      proposerId: 1,
      proposerShared: true,
      opponentShared: true,
      proposerSeat: 1,
    })
    ._unsafeUnwrap();
  return { db, persistence, trail: createTrail(persistence), gameId: game.id };
}

const events = (db: Database.Database): string[] =>
  (db.prepare('SELECT event FROM activity_trail ORDER BY id').all() as Array<{ event: string }>).map((r) => r.event);

const usernames = (db: Database.Database): string[] =>
  (db.prepare('SELECT username FROM users ORDER BY id').all() as Array<{ username: string }>).map((r) => r.username);

/** A write worth auditing, and a way to see whether it survived. */
function addUser(persistence: Persistence, username: string) {
  return persistence.createUser({
    username,
    displayName: username,
    passwordHash: 'hash',
    role: 'player',
    forcePasswordChange: false,
  });
}

describe('activity trail: write', () => {
  it('commits the entry and the writes it describes together', () => {
    const { db, persistence, trail } = setup();

    const result = trail.write((append) => {
      const created = addUser(persistence, 'zed');
      if (created.isErr()) return err(created.error);
      return append({ userId: created.value.id, event: 'user-created', payload: { by: 'aoife' } });
    });

    expect(result.isOk()).toBe(true);
    expect(usernames(db)).toContain('zed');
    expect(events(db)).toEqual(['user-created']);
  });

  it('rolls the writes back when the entry fails', () => {
    const { db, persistence, trail } = setup();

    // user 999 does not exist, and activity_trail.user_id is a foreign key —
    // so the append fails after the user row has already been inserted.
    const result = trail.write((append) => {
      const created = addUser(persistence, 'zed');
      if (created.isErr()) return err(created.error);
      return append({ userId: 999, event: 'sign-out' });
    });

    expect(result.isErr()).toBe(true);
    // This is the invariant that was convention before the module: an audited
    // write that cannot be audited does not happen.
    expect(usernames(db)).not.toContain('zed');
    expect(events(db)).toEqual([]);
  });

  it('rolls the entry back when a later write fails', () => {
    const { db, trail } = setup();

    const result = trail.write((append) => {
      const appended = append({ userId: 1, event: 'sign-in', payload: { via: 'password' } });
      if (appended.isErr()) return appended;
      return err('the write after it failed');
    });

    expect(result.isErr()).toBe(true);
    expect(events(db)).toEqual([]);
  });

  it('reports every failure as one error shape', () => {
    const { trail } = setup();

    const result = trail.write(() => err('boom'));

    // `{ code: 'persistence', message }` is structurally a GameError and an
    // AuthError, so both modules pass it straight through (ADR-0008's trick).
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'persistence', message: 'boom' });
  });

  it('lets the caller choose the order, because the order genuinely varies', () => {
    const { db, trail, gameId } = setup();

    // `game-proposed` appends after its insert (the entry carries the new id);
    // `game-proposal-deleted` appends before its delete (the FK nulls out).
    const result = trail.write((append) => {
      const first = append({ userId: 1, gameId, event: 'game-hidden' });
      if (first.isErr()) return first;
      return append({ userId: 1, event: 'sign-out' });
    });

    expect(result.isOk()).toBe(true);
    expect(events(db)).toEqual(['game-hidden', 'sign-out']);
  });

  it('carries a value out of the transaction', () => {
    const { persistence, trail } = setup();

    const result = trail.write((append) => {
      const created = addUser(persistence, 'zed');
      if (created.isErr()) return err(created.error);
      const appended = append({ userId: created.value.id, event: 'user-created', payload: { by: 'aoife' } });
      if (appended.isErr()) return err(appended.error);
      return ok(created.value.username);
    });

    expect(result._unsafeUnwrap()).toBe('zed');
  });
});

describe('activity trail: append', () => {
  it('audits something that writes nothing else', () => {
    const { db, trail, gameId } = setup();

    // The one command that audits a read: exporting a game record.
    const result = trail.append({
      userId: 1,
      gameId,
      event: 'game-exported',
      payload: { format: 'ptn', throughMove: 4, complete: true },
    });

    expect(result.isOk()).toBe(true);
    expect(events(db)).toEqual(['game-exported']);
  });

  it('maps its failure to the same error shape', () => {
    const { trail } = setup();

    const result = trail.append({ userId: 999, event: 'sign-out' });

    expect(result._unsafeUnwrapErr().code).toBe('persistence');
  });
});

describe('activity trail: the vocabulary is typed', () => {
  it('refuses malformed entries at compile time', () => {
    const accept = (entry: TrailEvent): TrailEvent => entry;

    // A game event must say which game it is about.
    // @ts-expect-error missing gameId
    accept({ userId: 1, event: 'game-hidden' });

    // A hard delete must keep the id in the payload, because
    // activity_trail.game_id is ON DELETE SET NULL.
    // @ts-expect-error payload.gameId is required on game-proposal-deleted
    accept({ userId: 1, gameId: 2, event: 'game-proposal-deleted', payload: { boardSize: 5, joinType: 'open' } });

    // An account event has no game to name.
    // @ts-expect-error sign-out takes no gameId
    accept({ userId: 1, gameId: 2, event: 'sign-out' });

    // A typo is no longer just a string.
    // @ts-expect-error not a declared event
    accept({ userId: 1, event: 'sign-out-ish' });

    expect(accept({ userId: 1, event: 'sign-out' }).event).toBe('sign-out');
  });
});
