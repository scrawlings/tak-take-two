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

/**
 * A user's persisted preferences (ticket 04) — the `user_prefs` row's JSON
 * blob, decoded. `follows` is the find page's allowlist, kept as user ids
 * rather than display names: a display name can change (`/account/display-
 * name`), and an id can't go stale the way a name would.
 */
export interface UserPrefs {
  readonly follows: readonly number[];
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
  /** Ticket 13: per-player hide; hiding removes a game from that player's own
   * views and clears that side's share (CONTEXT.md: Hide). */
  readonly proposerHidden: boolean;
  readonly opponentHidden: boolean;
  /** One pending request/offer per game (ticket 12): `take-back` or `draw`, from `pendingBy`. */
  readonly pendingKind: 'take-back' | 'draw' | null;
  readonly pendingBy: number | null;
  readonly result: string | null;
  /**
   * The core seat (1 or 2) the proposer holds; NULL means random, decided by
   * a coin flip when the joiner claims the game. Seats are decoupled from the
   * proposer/opponent split so a player may start from the other side.
   */
  readonly proposerSeat: 1 | 2 | null;
  /** Ticket 13: forced end by an admin. The game stays (with its real result,
   * if it had one) so affected players see why it ended. */
  readonly adminRemoved: boolean;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

/** A game's two sides, as the actor who occupies each: the proposer, or the
 * opponent (which also names the not-yet-joined invited player's seat). */
export type GameSide = 'proposer' | 'opponent';

/** Input for creating a game row. Games are always born `proposed`. */
export interface CreateGameInput {
  readonly boardSize: GameBoardSize;
  readonly joinType: JoinType;
  readonly proposerId: number;
  readonly invitedPlayerId?: number | null;
  readonly importedPtn?: string | null;
  readonly proposerShared: boolean;
  readonly opponentShared: boolean;
  /** The proposer's seat (1 or 2), or null for a random start resolved at join. */
  readonly proposerSeat: 1 | 2 | null;
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

  /** A user's preferences, or the defaults (empty allowlist) when they have never written any. */
  getUserPrefs(userId: number): Result<UserPrefs, string>;
  /** Replace a user's preferences wholesale. */
  setUserPrefs(userId: number, prefs: UserPrefs): Result<void, string>;

  /** Insert a game in the `proposed` state. */
  createGame(input: CreateGameInput): Result<GameRecord, string>;
  findGameById(id: number): Result<GameRecord | null, string>;
  deleteGame(id: number): Result<void, string>;
  /**
   * Games the user takes part in — as proposer or opponent — in any of
   * `states`, newest first. `showRemoved` (ticket 06) includes admin-removed
   * tombstones regardless of `states`, matching the pre-ticket-06 behaviour;
   * defaults to false, which excludes them outright.
   */
  listGamesForUser(
    userId: number,
    states: readonly GameLifecycleState[],
    showRemoved?: boolean,
  ): Result<GameRecord[], string>;
  /** Every game still `proposed` and unjoined, newest first, narrowed by `filters`. */
  listProposedGames(filters: ProposedGameFilters): Result<GameRecord[], string>;
  /**
   * Every game, any state, newest first — the admin's view of the whole
   * board (ticket 13: admins may view any game, share state aside).
   */
  listAllGames(): Result<GameRecord[], string>;
  /**
   * Claim a proposal as its opponent and start play. Returns false — changing
   * nothing — when the game is no longer an unjoined proposal, so that two
   * racing joins cannot both succeed. `proposerSeat` resolves a random start.
   */
  joinGame(gameId: number, opponentId: number, proposerSeat: 1 | 2): Result<boolean, string>;

  /** Set one side's share toggle; turning it on also clears that side's hide flag. */
  setGameShare(gameId: number, side: GameSide, shared: boolean): Result<void, string>;
  /** Hide the game for the given side(s): sets hidden and clears shared for each. */
  hideGame(gameId: number, sides: readonly GameSide[]): Result<void, string>;
  /** Force a game to `finished` (keeping any real result already set) and flag it admin-removed. */
  adminRemoveGame(gameId: number): Result<void, string>;

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
  /**
   * The latest move's timestamp for each of `gameIds` that has one played move
   * or more — one grouped query rather than one per game, for `lastActivity`
   * (ticket 03), which the Game module derives without a stored column.
   */
  listLastMoveTimestamps(gameIds: readonly number[]): Result<ReadonlyMap<number, string>, string>;
  /**
   * The last move's stored position (TPS) for each of `gameIds` that has one —
   * one grouped query rather than one per game, for the list's "to move"
   * column, which the Game module reads off the snapshot instead of
   * materializing each record (ADR-0005's read path). A game with no moves,
   * or whose last snapshot is null, is absent from the map — the Game module
   * falls back to the per-record load for those.
   */
  listLastPositions(gameIds: readonly number[]): Result<ReadonlyMap<number, string>, string>;
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
      return attempt('ping', () => {
        db.prepare('SELECT 1').get();
      });
    },

    // Not `attempt`: the error this reports is usually the closure's own,
    // already-named failure travelling back out through the rollback, so
    // prefixing it with this method would bury the caller's message.
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
      return attempt('appendActivityTrail', () => {
        const payload = entry.payload === undefined ? null : JSON.stringify(entry.payload);
        db.prepare(
          `INSERT INTO activity_trail (user_id, game_id, event, payload) VALUES (?, ?, ?, ?)`,
        ).run(entry.userId ?? null, entry.gameId ?? null, entry.event, payload);
      });
    },

    createUser(input: CreateUserInput): Result<UserRecord, string> {
      return attempt('createUser', () => {
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
        if (!row) throw new Error('inserted user row not found');
        return mapUser(row);
      });
    },

    findUserByUsername(username: string): Result<UserRecord | null, string> {
      return attempt('findUserByUsername', () => {
        const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
          | UserRow
          | undefined;
        return row ? mapUser(row) : null;
      });
    },

    findUserById(id: number): Result<UserRecord | null, string> {
      return attempt('findUserById', () => {
        const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
        return row ? mapUser(row) : null;
      });
    },

    findUserByDisplayName(displayName: string): Result<UserRecord | null, string> {
      return attempt('findUserByDisplayName', () => {
        const row = db.prepare('SELECT * FROM users WHERE display_name = ?').get(displayName) as
          | UserRow
          | undefined;
        return row ? mapUser(row) : null;
      });
    },

    listUsers(): Result<UserRecord[], string> {
      return attempt('listUsers', () => {
        const rows = db.prepare('SELECT * FROM users ORDER BY username').all() as UserRow[];
        return rows.map(mapUser);
      });
    },

    countAdmins(): Result<number, string> {
      return attempt('countAdmins', () => {
        const row = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as {
          n: number;
        };
        return row.n;
      });
    },

    updateUserPassword(id: number, passwordHash: string, forcePasswordChange: boolean): Result<void, string> {
      return attempt('updateUserPassword', () => {
        db.prepare('UPDATE users SET password_hash = ?, force_password_change = ? WHERE id = ?').run(
          passwordHash,
          forcePasswordChange ? 1 : 0,
          id,
        );
      });
    },

    updateUserDisplayName(id: number, displayName: string): Result<void, string> {
      return attempt('updateUserDisplayName', () => {
        db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, id);
      });
    },

    setUserBlocked(id: number, blocked: boolean): Result<void, string> {
      return attempt('setUserBlocked', () => {
        db.prepare('UPDATE users SET blocked = ? WHERE id = ?').run(blocked ? 1 : 0, id);
      });
    },

    setUserForcePasswordChange(id: number, force: boolean): Result<void, string> {
      return attempt('setUserForcePasswordChange', () => {
        db.prepare('UPDATE users SET force_password_change = ? WHERE id = ?').run(force ? 1 : 0, id);
      });
    },

    getUserPrefs(userId: number): Result<UserPrefs, string> {
      return attempt('getUserPrefs', () => {
        const row = db.prepare('SELECT prefs FROM user_prefs WHERE user_id = ?').get(userId) as
          | { prefs: string }
          | undefined;
        if (!row) return { follows: [] };
        // Decoded defensively rather than trusted: this blob is meant to grow
        // other prefs later, and a row written before `follows` existed (or a
        // future field this version doesn't know) must not throw.
        const parsed = JSON.parse(row.prefs) as { follows?: unknown };
        const follows = Array.isArray(parsed.follows) ? parsed.follows.filter((id) => typeof id === 'number') : [];
        return { follows };
      });
    },

    setUserPrefs(userId: number, prefs: UserPrefs): Result<void, string> {
      return attempt('setUserPrefs', () => {
        db.prepare(
          `INSERT INTO user_prefs (user_id, prefs) VALUES (?, ?)
           ON CONFLICT(user_id) DO UPDATE SET prefs = excluded.prefs`,
        ).run(userId, JSON.stringify(prefs));
      });
    },

    createGame(input: CreateGameInput): Result<GameRecord, string> {
      return attempt('createGame', () => {
        const info = db
          .prepare(
            `INSERT INTO games (board_size, state, join_type, proposer_id, invited_player_id, imported_ptn,
                              proposer_shared, opponent_shared, proposer_seat)
             VALUES (?, 'proposed', ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.boardSize,
            input.joinType,
            input.proposerId,
            input.invitedPlayerId ?? null,
            input.importedPtn ?? null,
            input.proposerShared ? 1 : 0,
            input.opponentShared ? 1 : 0,
            input.proposerSeat,
          );
        const row = db.prepare('SELECT * FROM games WHERE id = ?').get(info.lastInsertRowid) as
          | GameRow
          | undefined;
        if (!row) throw new Error('inserted game row not found');
        return mapGame(row);
      });
    },

    findGameById(id: number): Result<GameRecord | null, string> {
      return attempt('findGameById', () => {
        const row = db.prepare('SELECT * FROM games WHERE id = ?').get(id) as GameRow | undefined;
        return row ? mapGame(row) : null;
      });
    },

    deleteGame(id: number): Result<void, string> {
      return attempt('deleteGame', () => {
        db.prepare('DELETE FROM games WHERE id = ?').run(id);
      });
    },

    listGamesForUser(
      userId: number,
      states: readonly GameLifecycleState[],
      showRemoved = false,
    ): Result<GameRecord[], string> {
      if (states.length === 0) return ok([]);
      return attempt('listGamesForUser', () => {
        const placeholders = states.map(() => '?').join(', ');
        const rows = db
          .prepare(
            `SELECT * FROM games
             WHERE (proposer_id = ? OR opponent_id = ?)
               AND (state IN (${placeholders}) OR admin_removed = 1)
               AND (admin_removed = 0 OR ?)
               AND NOT ((proposer_id = ? AND proposer_hidden = 1) OR (opponent_id = ? AND opponent_hidden = 1))
             ORDER BY created_at DESC, id DESC`,
          )
          .all(userId, userId, ...states, showRemoved ? 1 : 0, userId, userId) as GameRow[];
        return rows.map(mapGame);
      });
    },

    listProposedGames(filters: ProposedGameFilters): Result<GameRecord[], string> {
      return attempt('listProposedGames', () => {
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
        return rows.map(mapGame);
      });
    },

    listAllGames(): Result<GameRecord[], string> {
      return attempt('listAllGames', () => {
        // No share/hide filtering: an admin may view any game (ticket 13), and
        // the list is how an admin finds one to view or remove.
        const rows = db
          .prepare('SELECT * FROM games ORDER BY created_at DESC, id DESC')
          .all() as GameRow[];
        return rows.map(mapGame);
      });
    },

    joinGame(gameId: number, opponentId: number, proposerSeat: 1 | 2): Result<boolean, string> {
      return attempt('joinGame', () => {
        // A join starts a fresh, active game: either side may have hidden the
        // bare proposal beforehand (ticket 13), and that must not carry over
        // and hide the game they are now actively part of. COALESCE keeps a
        // seat the proposer already chose; a random (NULL) start resolves here.
        const info = db
          .prepare(
            `UPDATE games SET opponent_id = ?, state = 'in_play', proposer_hidden = 0, opponent_hidden = 0,
               proposer_seat = COALESCE(proposer_seat, ?)
             WHERE id = ? AND state = 'proposed' AND opponent_id IS NULL`,
          )
          .run(opponentId, proposerSeat, gameId);
        return info.changes === 1;
      });
    },

    setGameShare(gameId: number, side: GameSide, shared: boolean): Result<void, string> {
      return attempt('setGameShare', () => {
        // Sharing again also un-hides that side (CONTEXT.md: Hide is reversible).
        if (shared) {
          db.prepare(`UPDATE games SET ${side}_shared = 1, ${side}_hidden = 0 WHERE id = ?`).run(gameId);
        } else {
          db.prepare(`UPDATE games SET ${side}_shared = 0 WHERE id = ?`).run(gameId);
        }
      });
    },

    hideGame(gameId: number, sides: readonly GameSide[]): Result<void, string> {
      return attempt('hideGame', () => {
        for (const side of sides) {
          db.prepare(`UPDATE games SET ${side}_hidden = 1, ${side}_shared = 0 WHERE id = ?`).run(gameId);
        }
      });
    },

    adminRemoveGame(gameId: number): Result<void, string> {
      return attempt('adminRemoveGame', () => {
        db.prepare(
          `UPDATE games SET admin_removed = 1, state = 'finished',
             finished_at = COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
           WHERE id = ?`,
        ).run(gameId);
      });
    },

    setPendingRequest(gameId: number, kind: 'take-back' | 'draw', by: number): Result<void, string> {
      return attempt('setPendingRequest', () => {
        db.prepare('UPDATE games SET pending_kind = ?, pending_by = ? WHERE id = ?').run(kind, by, gameId);
      });
    },

    clearPendingRequest(gameId: number): Result<void, string> {
      return attempt('clearPendingRequest', () => {
        db.prepare('UPDATE games SET pending_kind = NULL, pending_by = NULL WHERE id = ?').run(gameId);
      });
    },

    deleteLastMove(gameId: number): Result<void, string> {
      return attempt('deleteLastMove', () => {
        db.prepare(
          `DELETE FROM game_records WHERE game_id = ? AND move_number =
             (SELECT MAX(move_number) FROM game_records WHERE game_id = ?)`,
        ).run(gameId, gameId);
      });
    },

    appendMove(input: AppendMoveInput): Result<MoveRecord, string> {
      return attempt('appendMove', () => {
        const info = db
          .prepare(
            `INSERT INTO game_records (game_id, move_number, player_id, notation, position)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(input.gameId, input.moveNumber, input.playerId, input.notation, input.position);
        const row = db
          .prepare('SELECT * FROM game_records WHERE id = ?')
          .get(info.lastInsertRowid) as MoveRow | undefined;
        if (!row) throw new Error('inserted move row not found');
        return mapMove(row);
      });
    },

    listMoves(gameId: number): Result<MoveRecord[], string> {
      return attempt('listMoves', () => {
        const rows = db
          .prepare('SELECT * FROM game_records WHERE game_id = ? ORDER BY move_number')
          .all(gameId) as MoveRow[];
        return rows.map(mapMove);
      });
    },

    listLastMoveTimestamps(gameIds: readonly number[]): Result<ReadonlyMap<number, string>, string> {
      if (gameIds.length === 0) return ok(new Map());
      return attempt('listLastMoveTimestamps', () => {
        const placeholders = gameIds.map(() => '?').join(', ');
        const rows = db
          .prepare(
            `SELECT game_id, MAX(played_at) AS last_played_at FROM game_records
             WHERE game_id IN (${placeholders}) GROUP BY game_id`,
          )
          .all(...gameIds) as { game_id: number; last_played_at: string }[];
        return new Map(rows.map((row) => [row.game_id, row.last_played_at]));
      });
    },

    listLastPositions(gameIds: readonly number[]): Result<ReadonlyMap<number, string>, string> {
      if (gameIds.length === 0) return ok(new Map());
      return attempt('listLastPositions', () => {
        const placeholders = gameIds.map(() => '?').join(', ');
        // The last row per game, by move number — then its position, when the
        // row carries one (a null snapshot is absent from the map, so the Game
        // module's per-record fallback replays it exactly as it always did).
        const rows = db
          .prepare(
            `SELECT gr.game_id AS game_id, gr.position AS position
             FROM game_records gr
             JOIN (SELECT game_id, MAX(move_number) AS last_move FROM game_records
                   WHERE game_id IN (${placeholders}) GROUP BY game_id) last
               ON last.game_id = gr.game_id AND last.last_move = gr.move_number
             WHERE gr.position IS NOT NULL`,
          )
          .all(...gameIds) as { game_id: number; position: string }[];
        return new Map(rows.map((row) => [row.game_id, row.position]));
      });
    },

    finishGame(gameId: number, result: string): Result<void, string> {
      return attempt('finishGame', () => {
        db.prepare(
          `UPDATE games SET state = 'finished', result = ?, finished_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
           WHERE id = ?`,
        ).run(result, gameId);
      });
    },

    writeGameStats(input: GameStatsInput): Result<void, string> {
      return attempt('writeGameStats', () => {
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
      });
    },

    createSession(userId: number, id: string): Result<SessionRecord, string> {
      return attempt('createSession', () => {
        db.prepare('INSERT INTO sessions (id, user_id) VALUES (?, ?)').run(id, userId);
        const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
        if (!row) throw new Error('inserted session row not found');
        return mapSession(row);
      });
    },

    findSessionById(id: string): Result<SessionRecord | null, string> {
      return attempt('findSessionById', () => {
        const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
        return row ? mapSession(row) : null;
      });
    },

    deleteSession(id: string): Result<void, string> {
      return attempt('deleteSession', () => {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      });
    },

    deleteSessionsForUser(userId: number): Result<void, string> {
      return attempt('deleteSessionsForUser', () => {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      });
    },
  };
}

/**
 * The one place a driver exception becomes a `Result` error. Every method of
 * `Persistence` is a statement (or a small run of them) that either produces a
 * value or throws; `attempt` names the statement so a failure arrives as
 * `createGame: UNIQUE constraint failed: …` rather than a bare driver message
 * with no clue which call raised it. A method that must fail on its own terms
 * — an insert whose row does not read back — throws inside `fn` and is
 * reported the same way.
 */
function attempt<T>(statement: string, fn: () => T): Result<T, string> {
  try {
    return ok(fn());
  } catch (e) {
    return err(`${statement}: ${e instanceof Error ? e.message : String(e)}`);
  }
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
  proposer_hidden: number;
  opponent_hidden: number;
  pending_kind: string | null;
  pending_by: number | null;
  result: string | null;
  admin_removed: number;
  proposer_seat: number | null;
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
    proposerHidden: row.proposer_hidden !== 0,
    opponentHidden: row.opponent_hidden !== 0,
    pendingKind: row.pending_kind as 'take-back' | 'draw' | null,
    pendingBy: row.pending_by,
    result: row.result,
    proposerSeat: row.proposer_seat as 1 | 2 | null,
    adminRemoved: row.admin_removed !== 0,
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
