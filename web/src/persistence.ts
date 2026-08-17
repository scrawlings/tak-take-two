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
