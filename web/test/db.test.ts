import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';

/**
 * Migrations are append-only and run against databases that already exist, so
 * what matters is that a partly-migrated database catches up without losing
 * rows, and that re-running changes nothing.
 */

function columns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

/** The `ON DELETE` rule each foreign key of `table` declares, keyed by its column. */
function deleteRules(db: Database.Database, table: string): Record<string, string> {
  const rows = db.pragma(`foreign_key_list(${table})`) as Array<{
    from: string;
    table: string;
    on_delete: string;
  }>;
  return Object.fromEntries(rows.map((r) => [r.from, `${r.table}:${r.on_delete}`]));
}

/** Whether `column` of `table` is declared NOT NULL. */
function notNull(db: Database.Database, table: string, column: string): boolean {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string; notnull: number }>;
  return rows.find((c) => c.name === column)?.notnull === 1;
}

function versions(db: Database.Database): number[] {
  return (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
    version: number;
  }>).map((r) => r.version);
}

/**
 * The schema at migration 1, written out in full. This and `databaseAtMigration7`
 * are deliberately frozen copies rather than slices of `MIGRATIONS`: a fixture
 * derived from the array would silently follow it forward and stop describing
 * the old database a migration has to cope with.
 *
 * One deliberate divergence: the `created_at`/`played_at`/`occurred_at` defaults
 * are a fixed timestamp rather than migration 1's `strftime(…, 'now')`, so a
 * row copied through a rebuild can be compared for equality.
 */
function databaseAtMigration1(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT);
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('player', 'admin')),
      force_password_change INTEGER NOT NULL DEFAULT 0,
      blocked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    );
    CREATE TABLE games (
      id INTEGER PRIMARY KEY,
      board_size INTEGER NOT NULL CHECK (board_size IN (5, 6)),
      state TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed', 'in_play', 'finished')),
      join_type TEXT NOT NULL CHECK (join_type IN ('open', 'invited')),
      proposer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      opponent_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      invited_player_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      result TEXT,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      finished_at TEXT
    );
    CREATE TABLE game_records (
      id INTEGER PRIMARY KEY,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      move_number INTEGER NOT NULL,
      player_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      notation TEXT NOT NULL,
      position TEXT,
      played_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      UNIQUE (game_id, move_number)
    );
    CREATE TABLE activity_trail (
      id INTEGER PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
      event TEXT NOT NULL,
      payload TEXT,
      occurred_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    );
    CREATE INDEX idx_activity_trail_occurred_at ON activity_trail (occurred_at);
    CREATE TABLE game_stats (
      id INTEGER PRIMARY KEY,
      game_id INTEGER NOT NULL UNIQUE REFERENCES games(id) ON DELETE CASCADE,
      board_size INTEGER NOT NULL,
      move_count INTEGER NOT NULL,
      duration_seconds INTEGER,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    );`);
  db.prepare('INSERT INTO schema_migrations (version) VALUES (1)').run();
  return db;
}

/**
 * The schema at migration 7 — migration 1's tables plus the columns migrations
 * 2-7 added — which is what migration 8 rebuilds.
 */
function databaseAtMigration7(): Database.Database {
  const db = databaseAtMigration1();
  db.exec(`ALTER TABLE games ADD COLUMN imported_ptn TEXT;
    ALTER TABLE games ADD COLUMN proposer_shared INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE games ADD COLUMN opponent_shared INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE games ADD COLUMN pending_kind TEXT;
    ALTER TABLE games ADD COLUMN pending_by INTEGER;
    ALTER TABLE games ADD COLUMN proposer_hidden INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE games ADD COLUMN opponent_hidden INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE games ADD COLUMN admin_removed INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE games ADD COLUMN proposer_seat INTEGER CHECK (proposer_seat IN (1, 2));
    CREATE TABLE user_prefs (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      prefs TEXT NOT NULL DEFAULT '{}'
    );`);
  const record = db.prepare('INSERT INTO schema_migrations (version) VALUES (?)');
  for (const version of [2, 3, 4, 5, 6, 7]) record.run(version);
  return db;
}

/** Two players, and a game between them with one move, its stats and a trail entry. */
function playedGame(db: Database.Database): void {
  db.exec(`
    INSERT INTO users (id, username, display_name, password_hash, role)
      VALUES (1, 'aoife', 'Aoife Nolan', 'hash', 'player'),
             (2, 'takashi', 'Takashi Mori', 'hash', 'player');
    INSERT INTO games (id, board_size, state, join_type, proposer_id, opponent_id, proposer_seat)
      VALUES (5, 5, 'in_play', 'open', 1, 2, 1);
    INSERT INTO game_records (game_id, move_number, player_id, notation)
      VALUES (5, 1, 1, 'a1');
    INSERT INTO game_stats (game_id, board_size, move_count, result)
      VALUES (5, 5, 1, 'R-0');
    INSERT INTO activity_trail (user_id, game_id, event) VALUES (1, 5, 'move-played');
  `);
}

describe('runMigrations', () => {
  it('brings a fresh database fully up to date', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    expect(runMigrations(db).isOk()).toBe(true);

    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(columns(db, 'games')).toEqual(
      expect.arrayContaining(['imported_ptn', 'proposer_shared', 'opponent_shared', 'admin_removed', 'proposer_seat']),
    );
    expect(columns(db, 'user_prefs')).toEqual(['user_id', 'prefs']);
  });

  it('is idempotent: re-running applies nothing', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    expect(runMigrations(db).isOk()).toBe(true);

    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('upgrades an existing database without disturbing its rows', () => {
    const db = databaseAtMigration1();
    db.prepare(
      "INSERT INTO users (id, username, display_name, password_hash, role) VALUES (3, 'aoife', 'Aoife Nolan', 'hash', 'player')",
    ).run();
    db.prepare("INSERT INTO games (id, board_size, join_type, proposer_id) VALUES (7, 6, 'open', 3)").run();

    expect(runMigrations(db).isOk()).toBe(true);

    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // The existing game survives, gaining an empty record, both share toggles
    // off — the private default, never a silent opening-up — and an unresolved
    // (NULL) starter seat, meaning a coin flip decides who starts on join.
    expect(
      db
        .prepare(
          'SELECT id, board_size, proposer_id, imported_ptn, proposer_shared, opponent_shared, proposer_seat FROM games',
        )
        .get(),
    ).toEqual({
      id: 7,
      board_size: 6,
      proposer_id: 3,
      imported_ptn: null,
      proposer_shared: 0,
      opponent_shared: 0,
      proposer_seat: null,
    });
  });
});

/**
 * Accounts are permanent (CONTEXT.md: Account permanence). Migration 8 makes
 * that executable: every reference to `users` that is evidence refuses a
 * delete rather than cascading it away. These tests are the guard — they run
 * the delete a future script might, and require it to fail.
 */
describe('delete rules and account permanence (migration 8)', () => {
  function migrated(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    return db;
  }

  it('refuses to delete a player who proposed a game, rather than deleting the game', () => {
    const db = migrated();
    playedGame(db);

    expect(() => db.prepare('DELETE FROM users WHERE id = 1').run()).toThrow(/FOREIGN KEY/i);
    expect(db.prepare('SELECT COUNT(*) AS n FROM games').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM game_records').get()).toEqual({ n: 1 });
  });

  it('refuses to delete the opponent too, rather than leaving the game unattributable', () => {
    const db = migrated();
    playedGame(db);

    expect(() => db.prepare('DELETE FROM users WHERE id = 2').run()).toThrow(/FOREIGN KEY/i);
    expect(db.prepare('SELECT opponent_id FROM games WHERE id = 5').get()).toEqual({ opponent_id: 2 });
  });

  it('refuses to delete the player an invitation names', () => {
    const db = migrated();
    db.exec(`
      INSERT INTO users (id, username, display_name, password_hash, role)
        VALUES (1, 'aoife', 'Aoife Nolan', 'hash', 'player'),
               (2, 'takashi', 'Takashi Mori', 'hash', 'player');
      INSERT INTO games (id, board_size, join_type, proposer_id, invited_player_id)
        VALUES (5, 5, 'invited', 1, 2);
    `);

    expect(() => db.prepare('DELETE FROM users WHERE id = 2').run()).toThrow(/FOREIGN KEY/i);
  });

  it('refuses to delete an actor named in the activity trail', () => {
    const db = migrated();
    db.exec(`
      INSERT INTO users (id, username, display_name, password_hash, role)
        VALUES (1, 'aoife', 'Aoife Nolan', 'hash', 'player');
      INSERT INTO activity_trail (user_id, event) VALUES (1, 'sign-in');
    `);

    expect(() => db.prepare('DELETE FROM users WHERE id = 1').run()).toThrow(/FOREIGN KEY/i);
  });

  it('still lets a game be deleted, taking its moves, stats and trail attribution with it', () => {
    const db = migrated();
    playedGame(db);

    db.prepare('DELETE FROM games WHERE id = 5').run();

    expect(db.prepare('SELECT COUNT(*) AS n FROM game_records').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM game_stats').get()).toEqual({ n: 0 });
    // ADR-0003 deletes games for real, so the trail entry keeps its actor and
    // loses only the game id — which `trail.ts` puts in the payload instead.
    expect(db.prepare('SELECT user_id, game_id FROM activity_trail').get()).toEqual({
      user_id: 1,
      game_id: null,
    });
  });

  it('leaves sessions and preferences cascading, since neither is evidence', () => {
    const db = migrated();
    expect(deleteRules(db, 'sessions').user_id).toBe('users:CASCADE');
    expect(deleteRules(db, 'user_prefs').user_id).toBe('users:CASCADE');
  });

  it('leaves foreign keys as it found them, having turned them off to rebuild', () => {
    const on = new Database(':memory:');
    on.pragma('foreign_keys = ON');
    const off = new Database(':memory:');
    off.pragma('foreign_keys = OFF');

    expect(runMigrations(on).isOk()).toBe(true);
    expect(runMigrations(off).isOk()).toBe(true);

    expect(on.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(off.pragma('foreign_keys', { simple: true })).toBe(0);
  });

  it('reports a dead handle as an error rather than throwing out of the restore', () => {
    const db = new Database(':memory:');
    db.close();

    expect(runMigrations(db).isErr()).toBe(true);
  });

  it('declares the rule in the schema, not only in behaviour', () => {
    const db = migrated();

    expect(deleteRules(db, 'games')).toEqual({
      proposer_id: 'users:RESTRICT',
      opponent_id: 'users:RESTRICT',
      invited_player_id: 'users:RESTRICT',
    });
    expect(deleteRules(db, 'game_records')).toEqual({
      game_id: 'games:CASCADE',
      player_id: 'users:RESTRICT',
    });
    expect(deleteRules(db, 'activity_trail')).toEqual({
      user_id: 'users:RESTRICT',
      game_id: 'games:SET NULL',
    });
    expect(deleteRules(db, 'game_stats')).toEqual({ game_id: 'games:CASCADE' });
  });

  it('requires an actor on every trail entry, matching what `trail.ts` already demands', () => {
    const db = migrated();

    expect(notNull(db, 'activity_trail', 'user_id')).toBe(true);
    expect(() => db.prepare("INSERT INTO activity_trail (event) VALUES ('sign-in')").run()).toThrow(
      /NOT NULL/i,
    );
  });

  it('keeps the trail’s index, which the rebuild would otherwise have dropped', () => {
    const db = migrated();
    const indexes = (db.pragma('index_list(activity_trail)') as Array<{ name: string }>).map((i) => i.name);

    expect(indexes).toContain('idx_activity_trail_occurred_at');
  });

  it('carries every existing row through the rebuild', () => {
    const db = databaseAtMigration7();
    playedGame(db);
    const before = {
      games: db.prepare('SELECT * FROM games ORDER BY id').all(),
      records: db.prepare('SELECT * FROM game_records ORDER BY id').all(),
      trail: db.prepare('SELECT * FROM activity_trail ORDER BY id').all(),
      stats: db.prepare('SELECT * FROM game_stats ORDER BY id').all(),
    };
    // The rows went in under the old rules, which cascaded.
    expect(deleteRules(db, 'games').proposer_id).toBe('users:CASCADE');

    expect(runMigrations(db).isOk()).toBe(true);

    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(db.prepare('SELECT * FROM games ORDER BY id').all()).toEqual(before.games);
    expect(db.prepare('SELECT * FROM game_records ORDER BY id').all()).toEqual(before.records);
    expect(db.prepare('SELECT * FROM activity_trail ORDER BY id').all()).toEqual(before.trail);
    expect(db.prepare('SELECT * FROM game_stats ORDER BY id').all()).toEqual(before.stats);
    // …and the rebuilt table now refuses what the old one would have cascaded.
    expect(deleteRules(db, 'games').proposer_id).toBe('users:RESTRICT');
    expect(() => db.prepare('DELETE FROM users WHERE id = 1').run()).toThrow(/FOREIGN KEY/i);
  });
});

