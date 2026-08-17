import { ok, err, type Result } from 'neverthrow';
import type { Db } from './db.js';

/**
 * The persistence module — a narrow typed interface over the SQLite driver.
 * The driver (`Db`) is captured at construction and never exposed to callers:
 * schema, SQL, and serialization are implementation details.
 */

/** Games grouped by lifecycle state — the only game figure observability needs today. */
export interface GamesByState {
  readonly state: string;
  readonly count: number;
}

/** The database-derived figures behind the metrics and status pages. */
export interface PersistenceSnapshot {
  readonly activeSessions: number;
  readonly gamesByState: readonly GamesByState[];
  readonly databaseSizeBytes: number;
}

/** A single activity trail event, written for audit and game-integrity analysis. */
export interface TrailEntry {
  readonly userId?: number;
  readonly gameId?: number;
  readonly event: string;
  /** Structured detail; serialized by the implementation, never by the caller. */
  readonly payload?: unknown;
}

/** Account role. Admins administer; players play (CONTEXT.md: never the same account). */
export type UserRole = 'player' | 'admin';

/** A users-table row, mapped to domain shape. */
export interface UserRecord {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly role: UserRole;
  readonly forcePasswordChange: boolean;
  readonly blocked: boolean;
  readonly createdAt: string;
}

/** A sessions-table row, mapped to domain shape. */
export interface SessionRecord {
  readonly id: string;
  readonly userId: number;
  readonly createdAt: string;
}

/** Input for creating a user row. */
export interface CreateUserInput {
  readonly username: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly role: UserRole;
  readonly forcePasswordChange: boolean;
}

export interface Persistence {
  /** Whether the database answers a trivial query. The only error channel on the module. */
  ping(): Result<void, string>;
  /**
   * Current database-derived figures. Never fails: a field that cannot be read
   * is reported as empty/zero so observability stays up when the database is down.
   */
  metricsSnapshot(): PersistenceSnapshot;
  /** Append one event to the activity trail. */
  appendActivityTrail(entry: TrailEntry): Result<void, string>;

  /** Insert a user. Fails on a uniqueness violation or storage error. */
  createUser(input: CreateUserInput): Result<UserRecord, string>;
  findUserByUsername(username: string): Result<UserRecord | null, string>;
  findUserById(id: number): Result<UserRecord | null, string>;
  findUserByDisplayName(displayName: string): Result<UserRecord | null, string>;
  countAdmins(): Result<number, string>;
  /** All users, ordered by username. */
  listUsers(): Result<UserRecord[], string>;
  /** Replace a user's password hash and force-change flag. */
  updateUserPassword(id: number, passwordHash: string, forcePasswordChange: boolean): Result<void, string>;
  updateUserDisplayName(id: number, displayName: string): Result<void, string>;
  setUserBlocked(id: number, blocked: boolean): Result<void, string>;
  setUserForcePasswordChange(id: number, force: boolean): Result<void, string>;

  /** Insert a session with a caller-chosen id (the auth module owns id generation). */
  createSession(userId: number, id: string): Result<SessionRecord, string>;
  findSessionById(id: string): Result<SessionRecord | null, string>;
  deleteSession(id: string): Result<void, string>;
  deleteSessionsForUser(userId: number): Result<void, string>;
}

export function createPersistence(db: Db): Persistence {
  return {
    ping(): Result<void, string> {
      try {
        db.prepare('SELECT 1').get();
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    metricsSnapshot(): PersistenceSnapshot {
      return {
        activeSessions: countTable(db, 'sessions'),
        gamesByState: gamesByState(db),
        databaseSizeBytes: databaseSize(db),
      };
    },

    appendActivityTrail(entry: TrailEntry): Result<void, string> {
      try {
        const payload = entry.payload === undefined ? null : JSON.stringify(entry.payload);
        db.prepare(
          `INSERT INTO activity_trail (user_id, game_id, event, payload) VALUES (?, ?, ?, ?)`,
        ).run(entry.userId ?? null, entry.gameId ?? null, entry.event, payload);
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    createUser(input: CreateUserInput): Result<UserRecord, string> {
      try {
        const info = db
          .prepare(
            `INSERT INTO users (username, display_name, password_hash, role, force_password_change)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            input.username,
            input.displayName,
            input.passwordHash,
            input.role,
            input.forcePasswordChange ? 1 : 0,
          );
        const row = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid) as
          | UserRow
          | undefined;
        if (!row) return err('inserted user row not found');
        return ok(mapUser(row));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    findUserByUsername(username: string): Result<UserRecord | null, string> {
      try {
        const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
          | UserRow
          | undefined;
        return ok(row ? mapUser(row) : null);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    findUserById(id: number): Result<UserRecord | null, string> {
      try {
        const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
        return ok(row ? mapUser(row) : null);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    findUserByDisplayName(displayName: string): Result<UserRecord | null, string> {
      try {
        const row = db.prepare('SELECT * FROM users WHERE display_name = ?').get(displayName) as
          | UserRow
          | undefined;
        return ok(row ? mapUser(row) : null);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    listUsers(): Result<UserRecord[], string> {
      try {
        const rows = db.prepare('SELECT * FROM users ORDER BY username').all() as UserRow[];
        return ok(rows.map(mapUser));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    countAdmins(): Result<number, string> {
      try {
        const row = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as {
          n: number;
        };
        return ok(row.n);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    updateUserPassword(id: number, passwordHash: string, forcePasswordChange: boolean): Result<void, string> {
      try {
        db.prepare('UPDATE users SET password_hash = ?, force_password_change = ? WHERE id = ?').run(
          passwordHash,
          forcePasswordChange ? 1 : 0,
          id,
        );
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    updateUserDisplayName(id: number, displayName: string): Result<void, string> {
      try {
        db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, id);
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    setUserBlocked(id: number, blocked: boolean): Result<void, string> {
      try {
        db.prepare('UPDATE users SET blocked = ? WHERE id = ?').run(blocked ? 1 : 0, id);
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    setUserForcePasswordChange(id: number, force: boolean): Result<void, string> {
      try {
        db.prepare('UPDATE users SET force_password_change = ? WHERE id = ?').run(force ? 1 : 0, id);
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    createSession(userId: number, id: string): Result<SessionRecord, string> {
      try {
        db.prepare('INSERT INTO sessions (id, user_id) VALUES (?, ?)').run(id, userId);
        const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
        if (!row) return err('inserted session row not found');
        return ok(mapSession(row));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    findSessionById(id: string): Result<SessionRecord | null, string> {
      try {
        const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
        return ok(row ? mapSession(row) : null);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    deleteSession(id: string): Result<void, string> {
      try {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    deleteSessionsForUser(userId: number): Result<void, string> {
      try {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

function countTable(db: Db, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function gamesByState(db: Db): GamesByState[] {
  try {
    const rows = db
      .prepare('SELECT state, COUNT(*) AS n FROM games GROUP BY state ORDER BY state')
      .all() as Array<{ state: string; n: number }>;
    return rows.map((row) => ({ state: row.state, count: row.n }));
  } catch {
    return [];
  }
}

function databaseSize(db: Db): number {
  try {
    const pageCount = db.pragma('page_count', { simple: true }) as number;
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    return pageCount * pageSize;
  } catch {
    return 0;
  }
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: string;
  force_password_change: number;
  blocked: number;
  created_at: string;
}

interface SessionRow {
  id: string;
  user_id: number;
  created_at: string;
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    role: row.role as UserRole,
    forcePasswordChange: row.force_password_change !== 0,
    blocked: row.blocked !== 0,
    createdAt: row.created_at,
  };
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
  };
}
