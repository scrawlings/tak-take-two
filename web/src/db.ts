import { ok, err, type Result } from 'neverthrow';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

// One entry per migration; versions are 1-based indexes into this array.
// Append-only: never edit a migration that has already been applied.
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('player', 'admin')),
    force_password_change INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    finished_at TEXT
  );
  CREATE TABLE game_records (
    id INTEGER PRIMARY KEY,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    move_number INTEGER NOT NULL,
    player_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    notation TEXT NOT NULL,
    position TEXT,
    played_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (game_id, move_number)
  );
  CREATE TABLE activity_trail (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
    event TEXT NOT NULL,
    payload TEXT,
    occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX idx_activity_trail_occurred_at ON activity_trail (occurred_at);
  CREATE TABLE game_stats (
    id INTEGER PRIMARY KEY,
    game_id INTEGER NOT NULL UNIQUE REFERENCES games(id) ON DELETE CASCADE,
    board_size INTEGER NOT NULL,
    move_count INTEGER NOT NULL,
    duration_seconds INTEGER,
    result TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );`,
  // A game proposed from a PTN import carries its record here. The moves are
  // fixed (never undoable) and belong to no site account — the opponent has not
  // joined yet — so they cannot live in game_records, whose rows attribute every
  // move to a user. The core aggregate makes the same split: `fromPtnText` loads
  // this text as `fixedMoves`, and moves played here replay on top.
  `ALTER TABLE games ADD COLUMN imported_ptn TEXT;`,
  // ADR-0003: visibility is one share toggle per player, and a game is viewable
  // by non-participants iff both are on. Both default off; proposing an open
  // game turns them on, because joining an open game implies sharing.
  `ALTER TABLE games ADD COLUMN proposer_shared INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE games ADD COLUMN opponent_shared INTEGER NOT NULL DEFAULT 0;`,
  // One kinded pending request/offer per game (ticket 12): a take-back request
  // or a draw offer from one player awaiting the other's accept/reject. Only
  // one may be pending; both are cleared on accept, reject, or any finish.
  `ALTER TABLE games ADD COLUMN pending_kind TEXT;
   ALTER TABLE games ADD COLUMN pending_by INTEGER;`,
  // Ticket 13: per-player hide (removes a game from that player's own views
  // and turns their share off; mutual hide deletes the game) and an admin's
  // forced removal, which stays in the table — unlike a mutual hide — so the
  // affected players still see why the game ended.
  `ALTER TABLE games ADD COLUMN proposer_hidden INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE games ADD COLUMN opponent_hidden INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE games ADD COLUMN admin_removed INTEGER NOT NULL DEFAULT 0;`,
  // The proposer chooses who starts (seat 1): 1 = the proposer, 2 = the
  // opponent, NULL = random — the coin is flipped when the joiner claims the
  // game. Decoupling seats from the proposer/opponent split is what lets a
  // player import a past record and replay it from the other side.
  `ALTER TABLE games ADD COLUMN proposer_seat INTEGER CHECK (proposer_seat IN (1, 2));`,
  // Ticket 04: one JSON blob of preferences per user, additive to the schema
  // (no column surgery on `users`) — the find page's follow list is the first
  // pref stored here; a row is created lazily on first write, so most users
  // have none.
  `CREATE TABLE user_prefs (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    prefs TEXT NOT NULL DEFAULT '{}'
  );`,
];

export function openDatabase(path: string): Result<Db, string> {
  try {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return ok(db);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export function runMigrations(db: Db): Result<void, string> {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`);
    const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
      version: number;
    }>;
    const applied = new Set(appliedRows.map((row) => row.version));
    const record = db.prepare('INSERT INTO schema_migrations (version) VALUES (?)');
    for (let i = 0; i < MIGRATIONS.length; i++) {
      const version = i + 1;
      if (applied.has(version)) continue;
      db.transaction(() => {
        db.exec(MIGRATIONS[i]!);
        record.run(version);
      })();
    }
    return ok(undefined);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
