import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ok, err } from 'neverthrow';
import { runMigrations } from '../src/db.js';
import { createPersistence } from '../src/persistence.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function insertUser(db: Database.Database, id: number, username: string): void {
  db.prepare(
    'INSERT INTO users (id, username, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?)',
  ).run(id, username, username, 'hash', 'player');
}

describe('persistence', () => {
  describe('ping', () => {
    it('succeeds on a healthy database', () => {
      const p = createPersistence(makeDb());
      expect(p.ping().isOk()).toBe(true);
    });

    it('fails when the database is closed', () => {
      const db = makeDb();
      const p = createPersistence(db);
      db.close();
      expect(p.ping().isErr()).toBe(true);
    });
  });

  describe('metricsSnapshot', () => {
    it('reports an empty snapshot for a fresh database', () => {
      const p = createPersistence(makeDb());
      const snap = p.metricsSnapshot();
      expect(snap.activeSessions).toBe(0);
      expect(snap.gamesByState).toEqual([]);
      expect(snap.databaseSizeBytes).toBeGreaterThan(0);
    });

    it('fails open to zeros when the database is down', () => {
      const db = makeDb();
      const p = createPersistence(db);
      db.close();
      const snap = p.metricsSnapshot();
      expect(snap.activeSessions).toBe(0);
      expect(snap.gamesByState).toEqual([]);
      expect(snap.databaseSizeBytes).toBe(0);
    });

    it('counts sessions and games grouped by state', () => {
      const db = makeDb();
      insertUser(db, 1, 'alice');
      insertUser(db, 2, 'bob');
      db.prepare("INSERT INTO sessions (id, user_id) VALUES ('s1', 1)").run();
      db.prepare("INSERT INTO sessions (id, user_id) VALUES ('s2', 2)").run();
      db.prepare('INSERT INTO games (board_size, join_type, proposer_id, opponent_id) VALUES (5, ?, 1, 2)').run(
        'open',
      );
      db.prepare('INSERT INTO games (board_size, join_type, proposer_id, opponent_id) VALUES (6, ?, 1, 2)').run(
        'invited',
      );
      db.prepare("UPDATE games SET state = 'in_play' WHERE id = 2").run();

      const snap = createPersistence(db).metricsSnapshot();
      expect(snap.activeSessions).toBe(2);
      expect(snap.gamesByState).toEqual([
        { state: 'in_play', count: 1 },
        { state: 'proposed', count: 1 },
      ]);
      expect(snap.databaseSizeBytes).toBeGreaterThan(0);
    });
  });

  describe('transaction', () => {
    it('commits every write when the closure succeeds', () => {
      const db = makeDb();
      insertUser(db, 1, 'alice');
      const p = createPersistence(db);

      const result = p.transaction(() => {
        const updated = p.setUserBlocked(1, true);
        if (updated.isErr()) return updated;
        const trail = p.appendActivityTrail({ userId: 1, event: 'test' });
        if (trail.isErr()) return trail;
        return ok(undefined);
      });
      expect(result.isOk()).toBe(true);

      const user = db.prepare('SELECT blocked FROM users WHERE id = 1').get() as { blocked: number };
      expect(user.blocked).toBe(1);
      const trail = db.prepare("SELECT COUNT(*) AS n FROM activity_trail WHERE event = 'test'").get() as { n: number };
      expect(trail.n).toBe(1);
    });

    it('rolls back every write when the closure returns an error', () => {
      const db = makeDb();
      insertUser(db, 1, 'alice');
      const p = createPersistence(db);

      const result = p.transaction(() => {
        const updated = p.setUserBlocked(1, true);
        if (updated.isErr()) return updated;
        return err('injected failure');
      });
      expect(result.isErr()).toBe(true);
      if (result.isOk()) return;
      expect(result.error).toBe('injected failure');

      const user = db.prepare('SELECT blocked FROM users WHERE id = 1').get() as { blocked: number };
      expect(user.blocked).toBe(0);
    });
  });

  describe('appendActivityTrail', () => {
    it('writes an event with a serialized payload', () => {
      const db = makeDb();
      insertUser(db, 1, 'alice');
      const p = createPersistence(db);
      const r = p.appendActivityTrail({ userId: 1, event: 'sign-in', payload: { via: 'password' } });
      expect(r.isOk()).toBe(true);

      const row = db
        .prepare('SELECT user_id, game_id, event, payload FROM activity_trail')
        .get() as Record<string, unknown>;
      expect(row).toEqual({
        user_id: 1,
        game_id: null,
        event: 'sign-in',
        payload: '{"via":"password"}',
      });
    });

    it('writes an event with no optional fields', () => {
      const db = makeDb();
      const p = createPersistence(db);
      const r = p.appendActivityTrail({ event: 'export' });
      expect(r.isOk()).toBe(true);

      const row = db
        .prepare('SELECT user_id, game_id, event, payload FROM activity_trail')
        .get() as Record<string, unknown>;
      expect(row).toEqual({ user_id: null, game_id: null, event: 'export', payload: null });
    });

    it('fails when the database is closed', () => {
      const db = makeDb();
      const p = createPersistence(db);
      db.close();
      expect(p.appendActivityTrail({ event: 'sign-in' }).isErr()).toBe(true);
    });
  });

  describe('games', () => {
    it('creates a proposed open game and reads it back', () => {
      const db = makeDb();
      insertUser(db, 1, 'aoife');
      const p = createPersistence(db);

      const created = p.createGame({ boardSize: 5, joinType: 'open', proposerId: 1 });
      expect(created.isOk()).toBe(true);
      const game = created._unsafeUnwrap();
      expect(game).toMatchObject({
        boardSize: 5,
        state: 'proposed',
        joinType: 'open',
        proposerId: 1,
        opponentId: null,
        invitedPlayerId: null,
        importedPtn: null,
      });

      expect(p.findGameById(game.id)._unsafeUnwrap()).toEqual(game);
    });

    it('stores the invited player and the imported record', () => {
      const db = makeDb();
      insertUser(db, 1, 'aoife');
      insertUser(db, 2, 'takashi');
      const p = createPersistence(db);

      const game = p
        .createGame({
          boardSize: 6,
          joinType: 'invited',
          proposerId: 1,
          invitedPlayerId: 2,
          importedPtn: '[Size "6"]\n1. a1 f6',
        })
        ._unsafeUnwrap();

      expect(game).toMatchObject({
        boardSize: 6,
        joinType: 'invited',
        invitedPlayerId: 2,
        importedPtn: '[Size "6"]\n1. a1 f6',
      });
    });

    it('returns null for an unknown game', () => {
      const p = createPersistence(makeDb());
      expect(p.findGameById(404)._unsafeUnwrap()).toBeNull();
    });

    it('deletes a game', () => {
      const db = makeDb();
      insertUser(db, 1, 'aoife');
      const p = createPersistence(db);
      const game = p.createGame({ boardSize: 5, joinType: 'open', proposerId: 1 })._unsafeUnwrap();

      expect(p.deleteGame(game.id).isOk()).toBe(true);
      expect(p.findGameById(game.id)._unsafeUnwrap()).toBeNull();
    });

    it('lists games the user proposed or joined, filtered by state', () => {
      const db = makeDb();
      insertUser(db, 1, 'aoife');
      insertUser(db, 2, 'takashi');
      insertUser(db, 3, 'wren');
      const p = createPersistence(db);

      const mine = p.createGame({ boardSize: 5, joinType: 'open', proposerId: 1 })._unsafeUnwrap();
      const joined = p.createGame({ boardSize: 5, joinType: 'open', proposerId: 2 })._unsafeUnwrap();
      const theirs = p.createGame({ boardSize: 5, joinType: 'open', proposerId: 3 })._unsafeUnwrap();
      db.prepare("UPDATE games SET opponent_id = 1, state = 'in_play' WHERE id = ?").run(joined.id);
      db.prepare("UPDATE games SET state = 'finished' WHERE id = ?").run(theirs.id);

      const ids = p
        .listGamesForUser(1, ['proposed', 'in_play'])
        ._unsafeUnwrap()
        .map((g) => g.id);
      expect(ids.sort()).toEqual([mine.id, joined.id].sort());
    });

    it('excludes states that were not asked for', () => {
      const db = makeDb();
      insertUser(db, 1, 'aoife');
      const p = createPersistence(db);
      const game = p.createGame({ boardSize: 5, joinType: 'open', proposerId: 1 })._unsafeUnwrap();
      db.prepare("UPDATE games SET state = 'finished' WHERE id = ?").run(game.id);

      expect(p.listGamesForUser(1, ['proposed', 'in_play'])._unsafeUnwrap()).toEqual([]);
      expect(p.listGamesForUser(1, ['finished'])._unsafeUnwrap()).toHaveLength(1);
      expect(p.listGamesForUser(1, [])._unsafeUnwrap()).toEqual([]);
    });

    it('fails when the database is closed', () => {
      const db = makeDb();
      insertUser(db, 1, 'aoife');
      const p = createPersistence(db);
      db.close();
      expect(p.createGame({ boardSize: 5, joinType: 'open', proposerId: 1 }).isErr()).toBe(true);
      expect(p.findGameById(1).isErr()).toBe(true);
      expect(p.deleteGame(1).isErr()).toBe(true);
      expect(p.listGamesForUser(1, ['proposed']).isErr()).toBe(true);
    });
  });
});
