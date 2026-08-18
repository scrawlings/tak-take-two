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

function versions(db: Database.Database): number[] {
  return (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
    version: number;
  }>).map((r) => r.version);
}

/** A database as it stood when only migration 1 had been written. */
function databaseAtMigration1(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT);
    CREATE TABLE games (
      id INTEGER PRIMARY KEY,
      board_size INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'proposed',
      join_type TEXT NOT NULL,
      proposer_id INTEGER NOT NULL,
      opponent_id INTEGER,
      invited_player_id INTEGER,
      result TEXT,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z',
      finished_at TEXT
    );`);
  db.prepare('INSERT INTO schema_migrations (version) VALUES (1)').run();
  return db;
}

describe('runMigrations', () => {
  it('brings a fresh database fully up to date', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    expect(runMigrations(db).isOk()).toBe(true);

    expect(versions(db)).toEqual([1, 2, 3]);
    expect(columns(db, 'games')).toEqual(
      expect.arrayContaining(['imported_ptn', 'proposer_shared', 'opponent_shared']),
    );
  });

  it('is idempotent: re-running applies nothing', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    expect(runMigrations(db).isOk()).toBe(true);

    expect(versions(db)).toEqual([1, 2, 3]);
  });

  it('upgrades an existing database without disturbing its rows', () => {
    const db = databaseAtMigration1();
    db.prepare("INSERT INTO games (id, board_size, join_type, proposer_id) VALUES (7, 6, 'open', 3)").run();

    expect(runMigrations(db).isOk()).toBe(true);

    expect(versions(db)).toEqual([1, 2, 3]);
    // The existing game survives, gaining an empty record and both share
    // toggles off — the private default, never a silent opening-up.
    expect(
      db
        .prepare(
          'SELECT id, board_size, proposer_id, imported_ptn, proposer_shared, opponent_shared FROM games',
        )
        .get(),
    ).toEqual({
      id: 7,
      board_size: 6,
      proposer_id: 3,
      imported_ptn: null,
      proposer_shared: 0,
      opponent_shared: 0,
    });
  });
});
