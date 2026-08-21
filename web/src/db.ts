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
  // ADR-0017: accounts are permanent (CONTEXT.md: Account permanence), so
  // every reference to `users` that is evidence refuses a delete instead of
  // cascading it away — `games` and `game_records` would have deleted the very
  // record a rating depends on, and the trail would have lost its actor.
  // `sessions` and `user_prefs` keep CASCADE: neither is evidence. References
  // to `games` are untouched — games really are deleted (ADR-0003).
  //
  // `activity_trail.user_id` also becomes NOT NULL: every write site passes an
  // actor and `trail.ts`'s `TrailEvent` requires one, so the column was
  // nullable only for the deletion path that turned out not to exist. A
  // pre-existing NULL fails this migration rather than being papered over —
  // an entry with no actor is a bug worth surfacing, not a row to drop.
  //
  // SQLite cannot alter a foreign key in place, so each table is rebuilt.
  // `runMigrations` disables foreign keys around a migration and runs
  // `foreign_key_check` inside its transaction, which is what makes the
  // drop-and-rename safe: with them on, `DROP TABLE games` would cascade into
  // `game_records` and `game_stats` before the new table existed.
  `CREATE TABLE games_rebuilt (
    id INTEGER PRIMARY KEY,
    board_size INTEGER NOT NULL CHECK (board_size IN (5, 6)),
    state TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed', 'in_play', 'finished')),
    join_type TEXT NOT NULL CHECK (join_type IN ('open', 'invited')),
    proposer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    opponent_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
    invited_player_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
    result TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    finished_at TEXT,
    imported_ptn TEXT,
    proposer_shared INTEGER NOT NULL DEFAULT 0,
    opponent_shared INTEGER NOT NULL DEFAULT 0,
    pending_kind TEXT,
    pending_by INTEGER,
    proposer_hidden INTEGER NOT NULL DEFAULT 0,
    opponent_hidden INTEGER NOT NULL DEFAULT 0,
    admin_removed INTEGER NOT NULL DEFAULT 0,
    proposer_seat INTEGER CHECK (proposer_seat IN (1, 2))
  );
  INSERT INTO games_rebuilt (id, board_size, state, join_type, proposer_id, opponent_id,
      invited_player_id, result, created_at, finished_at, imported_ptn, proposer_shared,
      opponent_shared, pending_kind, pending_by, proposer_hidden, opponent_hidden,
      admin_removed, proposer_seat)
    SELECT id, board_size, state, join_type, proposer_id, opponent_id,
      invited_player_id, result, created_at, finished_at, imported_ptn, proposer_shared,
      opponent_shared, pending_kind, pending_by, proposer_hidden, opponent_hidden,
      admin_removed, proposer_seat
    FROM games;
  DROP TABLE games;
  ALTER TABLE games_rebuilt RENAME TO games;

  CREATE TABLE game_records_rebuilt (
    id INTEGER PRIMARY KEY,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    move_number INTEGER NOT NULL,
    player_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    notation TEXT NOT NULL,
    position TEXT,
    played_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (game_id, move_number)
  );
  INSERT INTO game_records_rebuilt (id, game_id, move_number, player_id, notation, position, played_at)
    SELECT id, game_id, move_number, player_id, notation, position, played_at FROM game_records;
  DROP TABLE game_records;
  ALTER TABLE game_records_rebuilt RENAME TO game_records;

  CREATE TABLE activity_trail_rebuilt (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
    event TEXT NOT NULL,
    payload TEXT,
    occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  INSERT INTO activity_trail_rebuilt (id, user_id, game_id, event, payload, occurred_at)
    SELECT id, user_id, game_id, event, payload, occurred_at FROM activity_trail;
  DROP TABLE activity_trail;
  ALTER TABLE activity_trail_rebuilt RENAME TO activity_trail;
  CREATE INDEX idx_activity_trail_occurred_at ON activity_trail (occurred_at);`,
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

/**
 * Apply every migration the database has not seen yet, in order.
 *
 * A migration runs with foreign keys off and is verified by `foreign_key_check`
 * inside its own transaction instead, so one that leaves a dangling reference
 * rolls back unapplied. That is what lets a migration rebuild a table (see
 * migration 8). The pragma is restored to whatever the caller had it set to.
 *
 * Call this outside a transaction. `PRAGMA foreign_keys` is silently a no-op
 * inside one, so a caller that wrapped this would get keys left enforced and a
 * rebuilding migration would cascade rows away instead of moving them.
 */
export function runMigrations(db: Db): Result<void, string> {
  let foreignKeysWereOn = true;
  try {
    foreignKeysWereOn = db.pragma('foreign_keys', { simple: true }) === 1;
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`);
    const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
      version: number;
    }>;
    const applied = new Set(appliedRows.map((row) => row.version));
    const record = db.prepare('INSERT INTO schema_migrations (version) VALUES (?)');
    db.pragma('foreign_keys = OFF');
    for (let i = 0; i < MIGRATIONS.length; i++) {
      const version = i + 1;
      if (applied.has(version)) continue;
      db.transaction(() => {
        db.exec(MIGRATIONS[i]!);
        const violations = db.pragma('foreign_key_check') as unknown[];
        if (violations.length > 0) {
          throw new Error(`migration ${version} left ${violations.length} dangling reference(s)`);
        }
        record.run(version);
      })();
    }
    return ok(undefined);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  } finally {
    try {
      db.pragma(`foreign_keys = ${foreignKeysWereOn ? 'ON' : 'OFF'}`);
    } catch {
      // The handle is already unusable — whatever failed above is the error
      // worth reporting, and this function returns a `Result`, never throws.
    }
  }
}
