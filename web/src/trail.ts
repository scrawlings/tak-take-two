import type { Result } from 'neverthrow';
import type { GameBoardSize, GameLifecycleState, JoinType, Persistence } from './persistence.js';

/**
 * The activity trail (CONTEXT.md) as a module. The concept is in the glossary —
 * an append-only record of user actions, which the system writes and never
 * reads, for admins and downstream processes to mine — but until now it had no
 * home: `games.ts` and `auth.ts` each re-assembled the same ritual at 25 sites,
 * `persistence.appendActivityTrail` took `event: string` and `payload: unknown`,
 * and three rules were held by convention alone.
 *
 * All three are now structural:
 *
 * 1. **An entry is written inside the transaction it describes.** `write` owns
 *    the transaction and hands the closure an `append`, so an entry and the
 *    writes it records commit or roll back together. Ordering stays with the
 *    caller because it genuinely varies: `game-proposed` must append *after*
 *    its insert (the entry carries the new id), `game-proposal-deleted` must
 *    append *before* its delete (see 3). `append` is exported separately for
 *    the one command that audits a read and has no writes to be atomic with.
 * 2. **A failure is reported one way.** `TrailError` is `{ code: 'persistence',
 *    message }` — structurally a `GameError` *and* an `AuthError` (both unions
 *    carry `'persistence'`) without importing either, the same one-way trick
 *    ADR-0008 used for `FilterError`. Both modules' private `persistenceError`
 *    helpers go away.
 * 3. **A hard delete keeps its game id.** `activity_trail.game_id` is
 *    `ON DELETE SET NULL`, so the two events that really delete a game —
 *    `game-proposal-deleted` and `game-deleted` — would lose the column they
 *    are about. They declare `payload.gameId`, so forgetting it is a type
 *    error. (`game-admin-deleted` is a soft delete; the row survives.)
 *
 * The dependency runs one way: this module imports persistence types and
 * nothing from `games.ts` or `auth.ts`. `ExportFormat`'s two literals are
 * restated below rather than imported, for that reason.
 */

/** A trail write failed. Structurally a `GameError`/`AuthError`; see 2 above. */
export interface TrailError {
  readonly code: 'persistence';
  readonly message: string;
}

/**
 * Events about one game. Every member carries `gameId`, so a game event cannot
 * be written without saying which game it is about.
 */
type GameEvent =
  | {
      readonly event: 'game-proposed';
      readonly payload: {
        readonly boardSize: GameBoardSize;
        readonly joinType: JoinType;
        readonly invited: string | null;
        readonly imported: boolean;
        readonly proposerSeat: 1 | 2 | null;
      };
    }
  | {
      // Hard delete: the id must survive in the payload (see 3 above).
      readonly event: 'game-proposal-deleted';
      readonly payload: {
        readonly gameId: number;
        readonly boardSize: GameBoardSize;
        readonly joinType: JoinType;
      };
    }
  | {
      readonly event: 'game-joined';
      readonly payload: {
        readonly proposer: number;
        readonly joinType: JoinType;
        readonly proposerSeat: 1 | 2;
      };
    }
  | { readonly event: 'game-finished'; readonly payload: { readonly result: string; readonly how: string } }
  | {
      readonly event: 'move-played';
      readonly payload: {
        readonly moveNumber: number;
        readonly notation: string;
        readonly result: string | null;
      };
    }
  | { readonly event: 'draw-offered' }
  | { readonly event: 'draw-accepted'; readonly payload: { readonly by: string } }
  | { readonly event: 'draw-rejected'; readonly payload: { readonly by: string } }
  | { readonly event: 'take-back-requested' }
  | { readonly event: 'take-back-accepted'; readonly payload: { readonly by: string } }
  | { readonly event: 'take-back-rejected'; readonly payload: { readonly by: string } }
  | { readonly event: 'game-shared' }
  | { readonly event: 'game-unshared' }
  | { readonly event: 'game-hidden' }
  | {
      // Hard delete: both players hid it (ADR-0003), so the row goes.
      readonly event: 'game-deleted';
      readonly payload: { readonly gameId: number; readonly reason: 'both-hidden' };
    }
  | {
      // Soft delete — `adminRemoved` is a flag, the row survives.
      readonly event: 'game-admin-deleted';
      readonly payload: { readonly by: string; readonly priorState: GameLifecycleState };
    }
  | {
      readonly event: 'game-exported';
      readonly payload: {
        /** `games.ts`'s `ExportFormat`, restated to keep the seam one-way. */
        readonly format: 'ptn' | 'tps';
        readonly throughMove: number;
        readonly complete: boolean;
      };
    };

/**
 * Events about an account. No `gameId` field exists on them at all. Follow and
 * unfollow live here despite being `games.ts` commands: following curates the
 * find view (CONTEXT.md: Follow) and is about a player, not a game.
 */
type AccountEvent =
  | { readonly event: 'admin-bootstrapped' }
  | { readonly event: 'user-created'; readonly payload: { readonly by: string } }
  | { readonly event: 'sign-in'; readonly payload: { readonly via: 'password' } }
  | { readonly event: 'sign-out' }
  | { readonly event: 'password-change' }
  | { readonly event: 'password-change-forced'; readonly payload: { readonly by: string } }
  | { readonly event: 'password-reset'; readonly payload: { readonly by: string } }
  | { readonly event: 'user-blocked'; readonly payload: { readonly by: string } }
  | { readonly event: 'user-unblocked'; readonly payload: { readonly by: string } }
  | {
      readonly event: 'display-name-change';
      readonly payload: { readonly from: string; readonly to: string };
    }
  | { readonly event: 'player-followed'; readonly payload: { readonly followedUserId: number } }
  | { readonly event: 'player-unfollowed'; readonly payload: { readonly followedUserId: number } };

/**
 * One entry. `userId` is required: every event this system records is caused by
 * an actor, and nothing deletes an account (the column is nullable for a
 * deletion path that does not exist — see the account-permanence note in
 * CONTEXT.md).
 */
export type TrailEvent =
  | ({ readonly userId: number; readonly gameId: number } & GameEvent)
  | ({ readonly userId: number } & AccountEvent);

/** Append inside an open `write`. Returns the closure's error type, so it composes. */
export type AppendEntry = (entry: TrailEvent) => Result<void, string>;

export interface Trail {
  /**
   * Run `fn` in one transaction, giving it an `append`. Whatever it writes and
   * whatever it appends commit together, or neither does.
   */
  write<T>(fn: (append: AppendEntry) => Result<T, string>): Result<T, TrailError>;
  /** Append on its own, for auditing something that writes nothing else. */
  append(entry: TrailEvent): Result<void, TrailError>;
}

export function createTrail(persistence: Persistence): Trail {
  const store: AppendEntry = (entry) => persistence.appendActivityTrail(entry);
  const failed = (message: string): TrailError => ({ code: 'persistence', message });

  return {
    write(fn) {
      return persistence.transaction(() => fn(store)).mapErr(failed);
    },
    append(entry) {
      return store(entry).mapErr(failed);
    },
  };
}
