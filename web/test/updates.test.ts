import { describe, expect, it } from 'vitest';
import { ok, err } from 'neverthrow';
import { GAMES_TOPIC, announceGameChanges, createUpdates, gameTopic } from '../src/updates.js';
import type { Updates } from '../src/updates.js';
import type { GameCommand, GameCommandResult, GameError, Games } from '../src/games.js';
import type { SessionUser } from '../src/auth.js';

/**
 * The change broker at its own seam: revisions and the waiting they drive.
 * Nothing here knows about HTTP — a stream route is just another caller that
 * asks for the next change and renders when it arrives.
 */

const ACTOR: SessionUser = {
  id: 1,
  username: 'aoife',
  displayName: 'Aoife Nolan',
  role: 'player',
  blocked: false,
  forcePasswordChange: false,
};

describe('waiting for the next change', () => {
  it('reports a change at once to a caller that has seen nothing', async () => {
    const updates = createUpdates();

    const change = await updates.next(gameTopic(7), 0);

    expect(change).toEqual({ type: 'changed', revision: 1 });
  });

  it('waits when the caller is already up to date, then wakes on a publish', async () => {
    const updates = createUpdates();
    const seen = await updates.next(gameTopic(7), 0);
    const pending = updates.next(gameTopic(7), seen.type === 'changed' ? seen.revision : 0);

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    updates.publish(gameTopic(7));

    expect(await pending).toEqual({ type: 'changed', revision: 2 });
  });

  it('leaves a caller waiting when a different topic changes', async () => {
    const updates = createUpdates();
    const pending = updates.next(gameTopic(7), 1, { waitMs: 5 });

    updates.publish(gameTopic(8));
    updates.publish(GAMES_TOPIC);

    expect(await pending).toEqual({ type: 'idle' });
  });

  it('reports changes that happened while the caller was rendering', async () => {
    const updates = createUpdates();
    updates.publish(gameTopic(7));
    updates.publish(gameTopic(7));

    // The caller saw revision 1 and comes back after two moves landed: it is
    // told the latest revision, not replayed one wake per publish.
    expect(await updates.next(gameTopic(7), 1)).toEqual({ type: 'changed', revision: 3 });
  });

  it('gives up after the wait elapses so the caller can send a heartbeat', async () => {
    const updates = createUpdates();

    expect(await updates.next(gameTopic(7), 1, { waitMs: 1 })).toEqual({ type: 'idle' });
  });

  it('reports closure when the caller aborts while waiting', async () => {
    const updates = createUpdates();
    const controller = new AbortController();
    const pending = updates.next(gameTopic(7), 1, { signal: controller.signal });

    controller.abort();

    expect(await pending).toEqual({ type: 'closed' });
  });

  it('reports closure to a caller whose signal has already aborted', async () => {
    const updates = createUpdates();
    const controller = new AbortController();
    controller.abort();

    expect(await updates.next(gameTopic(7), 0, { signal: controller.signal })).toEqual({ type: 'closed' });
  });

  it('wakes every stream open on the topic', async () => {
    const updates = createUpdates();
    const waiters = [updates.next(gameTopic(7), 1), updates.next(gameTopic(7), 1)];

    updates.publish(gameTopic(7));

    expect(await Promise.all(waiters)).toEqual([
      { type: 'changed', revision: 2 },
      { type: 'changed', revision: 2 },
    ]);
  });
});

/** A `Games` stub: only `applyGame` matters, and only its result. */
function stubGames(result: ReturnType<Games['applyGame']>): { games: Games; calls: GameCommand[] } {
  const calls: GameCommand[] = [];
  const refuse = () => err<never, GameError>({ code: 'forbidden', message: 'no' });
  return {
    calls,
    games: {
      applyGame(_actor, command) {
        calls.push(command);
        return result;
      },
      getGame: refuse,
      listMyGames: refuse,
      searchProposed: refuse,
      listAllGames: refuse,
    },
  };
}

function apply(command: GameCommand, result: ReturnType<Games['applyGame']>): string[] {
  const updates = createUpdates();
  const published: string[] = [];
  const recording: Updates = {
    ...updates,
    publish(topic: string): void {
      published.push(topic);
    },
  };
  const { games } = stubGames(result);

  announceGameChanges(games, recording).applyGame(ACTOR, command);
  return published;
}

const OK: ReturnType<Games['applyGame']> = ok<GameCommandResult, GameError>({ type: 'ok' });

describe('announcing a game command', () => {
  it('announces the game and the lists after a command that names a game', () => {
    expect(apply({ type: 'playMove', gameId: 7, move: 'a1' }, OK)).toEqual([gameTopic(7), GAMES_TOPIC]);
  });

  it('announces the new game after a proposal, which names none until it exists', () => {
    const result = ok<GameCommandResult, GameError>({ type: 'propose', gameId: 9 });

    expect(apply({ type: 'propose', boardSize: 5, joinType: 'open' }, result)).toEqual([
      gameTopic(9),
      GAMES_TOPIC,
    ]);
  });

  it('announces nothing when the command was refused', () => {
    const refused = err<GameCommandResult, GameError>({ code: 'not-your-turn', message: 'nope' });

    expect(apply({ type: 'playMove', gameId: 7, move: 'a1' }, refused)).toEqual([]);
  });

  it('announces nothing for an export, which changes nothing', () => {
    const exported = ok<GameCommandResult, GameError>({
      type: 'export',
      format: 'ptn',
      text: '',
      throughMove: 0,
      totalMoves: 0,
    });

    expect(apply({ type: 'export', gameId: 7, format: 'ptn' }, exported)).toEqual([]);
  });

  it('passes the command through untouched and returns the module’s own result', () => {
    const updates = createUpdates();
    const { games, calls } = stubGames(OK);
    const command: GameCommand = { type: 'resign', gameId: 3 };

    const result = announceGameChanges(games, updates).applyGame(ACTOR, command);

    expect(calls).toEqual([command]);
    expect(result._unsafeUnwrap()).toEqual({ type: 'ok' });
  });

  it('leaves the queries alone', () => {
    const updates = createUpdates();
    const { games } = stubGames(OK);
    const announcing = announceGameChanges(games, updates);

    expect(announcing.listMyGames(ACTOR)._unsafeUnwrapErr().code).toBe('forbidden');
    expect(updates.revision(GAMES_TOPIC)).toBe(1);
  });
});
