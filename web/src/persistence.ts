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

/** Board edge length. Mirrors the core's `BoardSize` without depending on it. */
export type GameBoardSize = 5 | 6;

/** Lifecycle state of a game (CONTEXT.md: proposed → in play → finished). */
export type GameLifecycleState = 'proposed' | 'in_play' | 'finished';

/** Who may join a proposal: anyone, or one designated player (ADR-0003). */
export type JoinType = 'open' | 'invited';

/** A games-table row, mapped to domain shape. */
export interface GameRecord {
  readonly id: number;
  readonly boardSize: GameBoardSize;
  readonly state: GameLifecycleState;
  readonly joinType: JoinType;
  readonly proposerId: number;
  readonly opponentId: number | null;
  readonly invitedPlayerId: number | null;
  /** The PTN record this game was imported from, or null when proposed from scratch. */
  readonly importedPtn: string | null;
  /** ADR-0003 share toggles; a game is viewable by non-participants iff both are on. */
  readonly proposerShared: boolean;
  readonly opponentShared: boolean;
  /** One pending request/offer per game (ticket 12): `take-back` or `draw`, from `pendingBy`. */
  readonly pendingKind: 'take-back' | 'draw' | null;
  readonly pendingBy: number | null;
  readonly result: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

/** Input for creating a game row. Games are always born `proposed`. */
export interface CreateGameInput {
  readonly boardSize: GameBoardSize;
  readonly joinType: JoinType;
  readonly proposerId: number;
  readonly invitedPlayerId?: number | null;
  readonly importedPtn?: string | null;
  readonly proposerShared: boolean;
  readonly opponentShared: boolean;
}

/** Column filters for browsing proposals. Visibility is the Game module's rule, not a filter. */
export interface ProposedGameFilters {
  readonly boardSize?: GameBoardSize;
  readonly joinType?: JoinType;
  /** Case-insensitive substring of the proposer's display name. */
  readonly proposerDisplayName?: string;
}

/** A game_records row — one played (live) move, attributed to a user. */
export interface MoveRecord {
  readonly id: number;
  readonly gameId: number;
  /** 1-based index in the full move history (imported moves come first). */
  readonly moveNumber: number;
  readonly playerId: number;
  /** The move as canonical PTN (`a1`, `Sa1`, `5b4>212`). */
  readonly notation: string;
  /** TPS of the position after this move, for export without replay. */
  readonly position: string | null;
  /** ISO timestamp. */
  readonly playedAt: string;
}

/** Input for recording one played move. */
export interface AppendMoveInput {
  readonly gameId: number;
  readonly moveNumber: number;
  readonly playerId: number;
  readonly notation: string;
  readonly position: string | null;
}

/** Input for the game_stats row written at finish. */
export interface GameStatsInput {
  readonly gameId: number;
  readonly boardSize: GameBoardSize;
  readonly moveCount: number;
  readonly durationSeconds: number | null;
  readonly result: string;
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
   * Run `fn`'s writes atomically: if the closure returns an error, every write
   * inside it is rolled back and that error is returned. The closure must be
   * synchronous (better-sqlite3 transactions are); argon2 hashing stays outside.
   */
  transaction<T>(fn: () => Result<T, string>): Result<T, string>;
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

  /** Insert a game in the `proposed` state. */
  createGame(input: CreateGameInput): Result<GameRecord, string>;
  findGameById(id: number): Result<GameRecord | null, string>;
  deleteGame(id: number): Result<void, string>;
  /**
   * Games the user takes part in — as proposer or opponent — in any of
   * `states`, newest first.
   */
  listGamesForUser(userId: number, states: readonly GameLifecycleState[]): Result<GameRecord[], string>;
  /** Every game still `proposed` and unjoined, newest first, narrowed by `filters`. */
  listProposedGames(filters: ProposedGameFilters): Result<GameRecord[], string>;
  /**
   * Claim a proposal as its opponent and start play. Returns false — changing
   * nothing — when the game is no longer an unjoined proposal, so that two
   * racing joins cannot both succeed.
   */
  joinGame(gameId: number, opponentId: number): Result<boolean, string>;

  /** Set the game's single pending request/offer (clearing any prior one). */
  setPendingRequest(gameId: number, kind: 'take-back' | 'draw', by: number): Result<void, string>;
  /** Clear the pending request/offer. */
  clearPendingRequest(gameId: number): Result<void, string>;
  /** Delete the most recently recorded move (take-back accept). */
  deleteLastMove(gameId: number): Result<void, string>;

  /** Record one played move. */
  appendMove(input: AppendMoveInput): Result<MoveRecord, string>;
  /** The played moves of a game, in play order (imported history is not here). */
  listMoves(gameId: number): Result<MoveRecord[], string>;
  /** Mark a game finished with its PTN result code and a timestamp. */
  finishGame(gameId: number, result: string): Result<void, string>;
  /** Write the derived game-stats row at finish. */
  writeGameStats(input: GameStatsInput): Result<void, string>;

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

    transaction<T>(fn: () => Result<T, string>): Result<T, string> {
      try {
        // better-sqlite3 rolls the transaction back when the wrapped function
        // throws, then rethrows; we translate that into the closure's error.
        const run = db.transaction(() => {
          const result = fn();
          if (result.isErr()) throw new Error(result.error);
          return result.value;
        });
        return ok(run());
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

    createGame(input: CreateGameInput): Result<GameRecord, string> {
      try {
        const info = db
          .prepare(
            `INSERT INTO games (board_size, state, join_type, proposer_id, invited_player_id, imported_ptn,
                              proposer_shared, opponent_shared)
             VALUES (?, 'proposed', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.boardSize,
            input.joinType,
            input.proposerId,
            input.invitedPlayerId ?? null,
            input.importedPtn ?? null,
            input.proposerShared ? 1 : 0,
            input.opponentShared ? 1 : 0,
          );
        const row = db.prepare('SELECT * FROM games WHERE id = ?').get(info.lastInsertRowid) as
          | GameRow
          | undefined;
        if (!row) return err('inserted game row not found');
        return ok(mapGame(row));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    findGameById(id: number): Result<GameRecord | null, string> {
      try {
        const row = db.prepare('SELECT * FROM games WHERE id = ?').get(id) as GameRow | undefined;
        return ok(row ? mapGame(row) : null);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    deleteGame(id: number): Result<void, string> {
      try {
        db.prepare('DELETE FROM games WHERE id = ?').run(id);
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    listGamesForUser(userId: number, states: readonly GameLifecycleState[]): Result<GameRecord[], string> {
      if (states.length === 0) return ok([]);
      try {
        const placeholders = states.map(() => '?').join(', ');
        const rows = db
          .prepare(
            `SELECT * FROM games
             WHERE (proposer_id = ? OR opponent_id = ?) AND state IN (${placeholders})
             ORDER BY created_at DESC, id DESC`,
          )
          .all(userId, userId, ...states) as GameRow[];
        return ok(rows.map(mapGame));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    listProposedGames(filters: ProposedGameFilters): Result<GameRecord[], string> {
      try {
        const where = ["g.state = 'proposed'", 'g.opponent_id IS NULL'];
        const params: Array<string | number> = [];
        if (filters.boardSize !== undefined) {
          where.push('g.board_size = ?');
          params.push(filters.boardSize);
        }
        if (filters.joinType !== undefined) {
          where.push('g.join_type = ?');
          params.push(filters.joinType);
        }
        if (filters.proposerDisplayName !== undefined) {
          // LIKE is case-insensitive for ASCII in SQLite by default. ESCAPE is
          // required for the backslashes escapeLike adds to mean anything.
          where.push("u.display_name LIKE ? ESCAPE '\\'");
          params.push(`%${escapeLike(filters.proposerDisplayName)}%`);
        }
        const rows = db
          .prepare(
            `SELECT g.* FROM games g
             JOIN users u ON u.id = g.proposer_id
             WHERE ${where.join(' AND ')}
             ORDER BY g.created_at DESC, g.id DESC`,
          )
          .all(...params) as GameRow[];
        return ok(rows.map(mapGame));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    joinGame(gameId: number, opponentId: number): Result<boolean, string> {
      try {
        const info = db
          .prepare(
            `UPDATE games SET opponent_id = ?, state = 'in_play'
             WHERE id = ? AND state = 'proposed' AND opponent_id IS NULL`,
          )
          .run(opponentId, gameId);
        return ok(info.changes === 1);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    setPendingRequest(gameId: number, kind: 'take-back' | 'draw', by: number): Result<void, string> {
      try {
        db.prepare('UPDATE games SET pending_kind = ?, pending_by = ? WHERE id = ?').run(kind, by, gameId);
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    clearPendingRequest(gameId: number): Result<void, string> {
      try {
        db.prepare('UPDATE games SET pending_kind = NULL, pending_by = NULL WHERE id = ?').run(gameId);
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    deleteLastMove(gameId: number): Result<void, string> {
      try {
        db.prepare(
          `DELETE FROM game_records WHERE game_id = ? AND move_number =
             (SELECT MAX(move_number) FROM game_records WHERE game_id = ?)`,
        ).run(gameId, gameId);
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    appendMove(input: AppendMoveInput): Result<MoveRecord, string> {
      try {
        const info = db
          .prepare(
            `INSERT INTO game_records (game_id, move_number, player_id, notation, position)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(input.gameId, input.moveNumber, input.playerId, input.notation, input.position);
        const row = db
          .prepare('SELECT * FROM game_records WHERE id = ?')
          .get(info.lastInsertRowid) as MoveRow | undefined;
        if (!row) return err('inserted move row not found');
        return ok(mapMove(row));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    listMoves(gameId: number): Result<MoveRecord[], string> {
      try {
        const rows = db
          .prepare('SELECT * FROM game_records WHERE game_id = ? ORDER BY move_number')
          .all(gameId) as MoveRow[];
        return ok(rows.map(mapMove));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    finishGame(gameId: number, result: string): Result<void, string> {
      try {
        db.prepare(
          `UPDATE games SET state = 'finished', result = ?, finished_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
           WHERE id = ?`,
        ).run(result, gameId);
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    writeGameStats(input: GameStatsInput): Result<void, string> {
      try {
        db.prepare(
          `INSERT INTO game_stats (game_id, board_size, move_count, duration_seconds, result)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          input.gameId,
          input.boardSize,
          input.moveCount,
          input.durationSeconds,
          input.result,
        );
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

/** Neutralise LIKE wildcards so a searched name is matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
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

interface GameRow {
  id: number;
  board_size: number;
  state: string;
  join_type: string;
  proposer_id: number;
  opponent_id: number | null;
  invited_player_id: number | null;
  imported_ptn: string | null;
  proposer_shared: number;
  opponent_shared: number;
  pending_kind: string | null;
  pending_by: number | null;
  result: string | null;
  created_at: string;
  finished_at: string | null;
}

interface MoveRow {
  id: number;
  game_id: number;
  move_number: number;
  player_id: number;
  notation: string;
  position: string | null;
  played_at: string;
}

function mapGame(row: GameRow): GameRecord {
  return {
    id: row.id,
    boardSize: row.board_size as GameBoardSize,
    state: row.state as GameLifecycleState,
    joinType: row.join_type as JoinType,
    proposerId: row.proposer_id,
    opponentId: row.opponent_id,
    invitedPlayerId: row.invited_player_id,
    importedPtn: row.imported_ptn,
    proposerShared: row.proposer_shared !== 0,
    opponentShared: row.opponent_shared !== 0,
    pendingKind: row.pending_kind as 'take-back' | 'draw' | null,
    pendingBy: row.pending_by,
    result: row.result,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function mapMove(row: MoveRow): MoveRecord {
  return {
    id: row.id,
    gameId: row.game_id,
    moveNumber: row.move_number,
    playerId: row.player_id,
    notation: row.notation,
    position: row.position,
    playedAt: row.played_at,
  };
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
