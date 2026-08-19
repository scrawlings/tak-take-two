import type { GameCommand, GameCommandResult, Games } from './games.js';

/**
 * The change broker — how a move recorded on one request reaches the SSE
 * streams open on others (ticket 14).
 *
 * ADR-0004 is explicit that the Game module has no event system: commands
 * return a domain-shaped result, and real-time delivery adapts at the routes.
 * So this module sits beside the routes, not under them. It carries no game
 * state and no rendered HTML — only a revision per topic. A stream that is
 * woken re-reads the game through the module's own queries, which is what
 * keeps the pushed regions and the page a reload would serve identical.
 *
 * Revisions, rather than a queue of events, are what makes near-simultaneous
 * moves safe: a stream that was busy rendering when two moves landed is woken
 * once and reads the position after both, so it can never render a stale board
 * over a fresh one, and can never fall behind by a growing backlog.
 *
 * Single process by design (ADR-0002: one SQLite database, no multi-instance
 * deployment), so in-memory is the whole of it.
 */

/** The topic a game's own streams listen on. */
export function gameTopic(gameId: number): string {
  return `game:${gameId}`;
}

/**
 * The topic every games list listens on. Any change anywhere can reorder or
 * re-populate a list — a proposal appears, a game is joined, a move changes
 * whose turn it is — so lists share one topic rather than subscribing per game.
 */
export const GAMES_TOPIC = 'games';

/** The answer to "has this topic changed?", once one is available. */
export type Change =
  | { readonly type: 'changed'; readonly revision: number }
  /** Nothing changed before the wait elapsed; the caller may send a heartbeat. */
  | { readonly type: 'idle' }
  /** The caller's signal aborted — the client went away. */
  | { readonly type: 'closed' };

export interface WaitOptions {
  /** Aborting resolves the wait as `closed`. */
  readonly signal?: AbortSignal;
  /** Give up and answer `idle` after this long. Absent waits indefinitely. */
  readonly waitMs?: number;
}

export interface Updates {
  /** Note that a topic changed; every caller waiting on it wakes. */
  publish(topic: string): void;
  /**
   * The topic's revision once it passes `since`. A caller that has seen
   * nothing (`since` 0) is answered at once, which is how a new stream renders
   * its first frame through the same path as every later one.
   */
  next(topic: string, since: number, options?: WaitOptions): Promise<Change>;
  /** The topic's current revision. Topics start at 1, so 0 means "seen nothing". */
  revision(topic: string): number;
}

export function createUpdates(): Updates {
  const revisions = new Map<string, number>();
  const waiting = new Map<string, Set<() => void>>();

  const revision = (topic: string): number => revisions.get(topic) ?? 1;

  return {
    revision,

    publish(topic: string): void {
      revisions.set(topic, revision(topic) + 1);
      const waiters = waiting.get(topic);
      if (waiters === undefined) return;
      // Taken before waking: a waiter that re-registers immediately belongs to
      // the next round, not this one.
      waiting.delete(topic);
      for (const wake of waiters) wake();
    },

    next(topic: string, since: number, options: WaitOptions = {}): Promise<Change> {
      const { signal, waitMs } = options;
      if (signal?.aborted === true) return Promise.resolve({ type: 'closed' });

      const current = revision(topic);
      if (current > since) return Promise.resolve({ type: 'changed', revision: current });

      return new Promise<Change>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;

        const cleanup = (): void => {
          const waiters = waiting.get(topic);
          if (waiters !== undefined) {
            waiters.delete(wake);
            if (waiters.size === 0) waiting.delete(topic);
          }
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        };
        const finish = (change: Change): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(change);
        };
        // Re-read rather than trusting the publish that woke us: two publishes
        // in the same tick should answer with the revision after both.
        function wake(): void {
          finish({ type: 'changed', revision: revision(topic) });
        }
        function onAbort(): void {
          finish({ type: 'closed' });
        }

        let waiters = waiting.get(topic);
        if (waiters === undefined) {
          waiters = new Set();
          waiting.set(topic, waiters);
        }
        waiters.add(wake);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (waitMs !== undefined) timer = setTimeout(() => finish({ type: 'idle' }), waitMs);
      });
    },
  };
}

/**
 * The game a command acts on, once the module has answered. Exhaustive by
 * command type (ADR-0001), so a command added later has to say which game it
 * changes rather than silently waking nobody.
 */
function changedGame(command: GameCommand, result: GameCommandResult): number | null {
  switch (command.type) {
    // The one command with no game to name until one exists; the result carries it.
    case 'propose':
      return result.type === 'propose' ? result.gameId : null;
    case 'deleteProposal':
    case 'join':
    case 'playMove':
    case 'resign':
    case 'requestTakeBack':
    case 'acceptTakeBack':
    case 'rejectTakeBack':
    case 'offerDraw':
    case 'acceptDraw':
    case 'rejectDraw':
    case 'share':
    case 'hide':
    case 'adminDelete':
    case 'export':
      return command.gameId;
  }
}

/**
 * The Game module with its successful commands announced (ADR-0004: "real-time
 * delivery adapts at the routes"). Wrapping the module once is what keeps the
 * fourteen mutating routes from each remembering to publish — and keeps the
 * module itself free of the event system the ADR rejected.
 */
export function announceGameChanges(games: Games, updates: Updates): Games {
  return {
    ...games,

    applyGame(actor, command) {
      const result = games.applyGame(actor, command);
      if (result.isErr()) return result;
      // Copying a record out changes nothing, so nobody needs waking for it.
      if (result.value.type === 'export') return result;

      const gameId = changedGame(command, result.value);
      if (gameId !== null) updates.publish(gameTopic(gameId));
      updates.publish(GAMES_TOPIC);
      return result;
    },
  };
}
