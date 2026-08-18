import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';
import { createPersistence, type Persistence } from '../src/persistence.js';
import { createGames, type Games } from '../src/games.js';
import { fromPtnText } from '@tak/core';
import type { SessionUser } from '../src/auth.js';

/**
 * Behaviour of the Game module at its boundary: commands in, results and
 * persisted state out. Rules validation belongs to the core and is tested there.
 */

function insertUser(
  db: Database.Database,
  seed: { id: number; username: string; displayName?: string; role?: 'player' | 'admin'; blocked?: boolean },
): SessionUser {
  db.prepare(
    'INSERT INTO users (id, username, display_name, password_hash, role, blocked) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    seed.id,
    seed.username,
    seed.displayName ?? seed.username,
    'hash',
    seed.role ?? 'player',
    seed.blocked ? 1 : 0,
  );
  return {
    id: seed.id,
    username: seed.username,
    displayName: seed.displayName ?? seed.username,
    role: seed.role ?? 'player',
    forcePasswordChange: false,
    blocked: seed.blocked ?? false,
  };
}

interface Harness {
  db: Database.Database;
  persistence: Persistence;
  games: Games;
  aoife: SessionUser;
  takashi: SessionUser;
  root: SessionUser;
}

function harness(): Harness {
  const db = new Database(':memory:');
  runMigrations(db);
  const persistence = createPersistence(db);
  return {
    db,
    persistence,
    games: createGames(persistence),
    aoife: insertUser(db, { id: 1, username: 'aoife', displayName: 'Aoife Nolan' }),
    takashi: insertUser(db, { id: 2, username: 'takashi', displayName: 'Takashi Mori' }),
    root: insertUser(db, { id: 3, username: 'root', displayName: 'Root Keeper', role: 'admin' }),
  };
}

function trailEvents(db: Database.Database): string[] {
  return (db.prepare('SELECT event FROM activity_trail ORDER BY id').all() as Array<{ event: string }>).map(
    (r) => r.event,
  );
}

/** A legal, unfinished 5×5 opening: each player's first turn places an opponent stone. */
const OPENING_PTN = '[Size "5"]\n1. a1 e5\n2. c3 c4';

describe('games: propose', () => {
  it('proposes an open game on the chosen board size', () => {
    const h = harness();

    const result = h.games.applyGame(h.aoife, { type: 'propose', boardSize: 6, joinType: 'open' });

    expect(result.isOk()).toBe(true);
    const gameId = result._unsafeUnwrap();
    expect(gameId).toMatchObject({ type: 'propose' });
    const stored = h.persistence.findGameById((gameId as { gameId: number }).gameId)._unsafeUnwrap();
    expect(stored).toMatchObject({
      boardSize: 6,
      state: 'proposed',
      joinType: 'open',
      proposerId: 1,
      opponentId: null,
      invitedPlayerId: null,
      importedPtn: null,
    });
  });

  it('proposes an invited game naming the invited player by display name', () => {
    const h = harness();

    const result = h.games.applyGame(h.aoife, {
      type: 'propose',
      boardSize: 5,
      joinType: 'invited',
      invitedDisplayName: 'Takashi Mori',
    });

    const { gameId } = result._unsafeUnwrap() as { gameId: number };
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toMatchObject({
      joinType: 'invited',
      invitedPlayerId: 2,
    });
  });

  it('lets a player invite themselves, for study', () => {
    const h = harness();

    const result = h.games.applyGame(h.aoife, {
      type: 'propose',
      boardSize: 5,
      joinType: 'invited',
      invitedDisplayName: 'Aoife Nolan',
    });

    expect(result.isOk()).toBe(true);
  });

  it('rejects a board size other than 5 or 6', () => {
    const h = harness();

    const result = h.games.applyGame(h.aoife, { type: 'propose', boardSize: 7, joinType: 'open' });

    expect(result._unsafeUnwrapErr().code).toBe('invalid-board-size');
  });

  it('rejects an unknown join type', () => {
    const h = harness();

    const result = h.games.applyGame(h.aoife, { type: 'propose', boardSize: 5, joinType: 'secret' });

    expect(result._unsafeUnwrapErr().code).toBe('invalid-join-type');
  });

  it('rejects an invited proposal with nobody named', () => {
    const h = harness();

    const result = h.games.applyGame(h.aoife, { type: 'propose', boardSize: 5, joinType: 'invited' });

    expect(result._unsafeUnwrapErr().code).toBe('invalid-invite');
  });

  it('rejects an invitation to a name no player holds', () => {
    const h = harness();

    const result = h.games.applyGame(h.aoife, {
      type: 'propose',
      boardSize: 5,
      joinType: 'invited',
      invitedDisplayName: 'Nobody At All',
    });

    expect(result._unsafeUnwrapErr()).toMatchObject({ code: 'invalid-invite' });
  });

  it('rejects an invitation to an admin or a blocked account', () => {
    const h = harness();
    insertUser(h.db, { id: 4, username: 'wren', displayName: 'Wren Alvarez', blocked: true });

    expect(
      h.games
        .applyGame(h.aoife, {
          type: 'propose',
          boardSize: 5,
          joinType: 'invited',
          invitedDisplayName: 'Root Keeper',
        })
        ._unsafeUnwrapErr().code,
    ).toBe('invalid-invite');
    expect(
      h.games
        .applyGame(h.aoife, {
          type: 'propose',
          boardSize: 5,
          joinType: 'invited',
          invitedDisplayName: 'Wren Alvarez',
        })
        ._unsafeUnwrapErr().code,
    ).toBe('invalid-invite');
  });

  it('refuses an admin account: an admin is never a player', () => {
    const h = harness();

    const result = h.games.applyGame(h.root, { type: 'propose', boardSize: 5, joinType: 'open' });

    expect(result._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('writes a game-proposed trail event', () => {
    const h = harness();

    h.games.applyGame(h.aoife, { type: 'propose', boardSize: 5, joinType: 'open' });

    expect(trailEvents(h.db)).toEqual(['game-proposed']);
    const row = h.db.prepare('SELECT game_id, user_id FROM activity_trail').get() as {
      game_id: number;
      user_id: number;
    };
    expect(row).toMatchObject({ user_id: 1 });
    expect(row.game_id).toBeGreaterThan(0);
  });

  it('records nothing when the proposal is rejected', () => {
    const h = harness();

    h.games.applyGame(h.aoife, { type: 'propose', boardSize: 7, joinType: 'open' });

    expect(trailEvents(h.db)).toEqual([]);
    expect(h.persistence.listGamesForUser(1, ['proposed'])._unsafeUnwrap()).toEqual([]);
  });
});

describe('games: propose from PTN', () => {
  it('accepts a legal record and keeps it as the imported history', () => {
    const h = harness();

    const result = h.games.applyGame(h.aoife, {
      type: 'propose',
      boardSize: 5,
      joinType: 'open',
      ptn: OPENING_PTN,
    });

    const { gameId } = result._unsafeUnwrap() as { gameId: number };
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toMatchObject({
      importedPtn: OPENING_PTN,
      state: 'proposed',
    });
  });

  it('takes the board size from the record, not the form', () => {
    const h = harness();

    const result = h.games.applyGame(h.aoife, {
      type: 'propose',
      boardSize: 5,
      joinType: 'open',
      ptn: '[Size "6"]\n1. a1 f6',
    });

    const { gameId } = result._unsafeUnwrap() as { gameId: number };
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()?.boardSize).toBe(6);
  });

  it('rejects a record the core will not replay', () => {
    const h = harness();

    // a1 is occupied by the opening placement, so the second placement is illegal.
    const result = h.games.applyGame(h.aoife, {
      type: 'propose',
      boardSize: 5,
      joinType: 'open',
      ptn: '[Size "5"]\n1. a1 e5\n2. a1 c4',
    });

    expect(result._unsafeUnwrapErr().code).toBe('invalid-ptn');
    expect(h.persistence.listGamesForUser(1, ['proposed'])._unsafeUnwrap()).toEqual([]);
  });

  it('rejects unparseable text', () => {
    const h = harness();

    const result = h.games.applyGame(h.aoife, {
      type: 'propose',
      boardSize: 5,
      joinType: 'open',
      ptn: 'this is not a game record',
    });

    expect(result._unsafeUnwrapErr().code).toBe('invalid-ptn');
  });

  it('rejects a record whose position is already won', () => {
    const h = harness();
    // Player 1 completes a road across rank 2. Rank 1 would not do: the opening
    // rule makes a1 player 2's stone, so the road is built a square higher.
    const won = '[Size "5"]\n1. a1 e5\n2. a2 a5\n3. b2 b5\n4. c2 c5\n5. d2 d5\n6. e2\nR-0';

    const result = h.games.applyGame(h.aoife, {
      type: 'propose',
      boardSize: 5,
      joinType: 'open',
      ptn: won,
    });

    expect(result._unsafeUnwrapErr()).toMatchObject({ code: 'invalid-ptn' });
    expect(result._unsafeUnwrapErr().message).toContain('won position');
  });

  it('accepts a playable position even when the record carries a result tag', () => {
    const h = harness();
    // A resignation ends the *original* game; the position is still playable,
    // and the tag says nothing about the game being proposed here.
    const resigned = `${OPENING_PTN}\n1-0`;

    const result = h.games.applyGame(h.aoife, {
      type: 'propose',
      boardSize: 5,
      joinType: 'open',
      ptn: resigned,
    });

    expect(result.isOk()).toBe(true);
    const { gameId } = result._unsafeUnwrap() as { gameId: number };
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()?.importedPtn).toBe(resigned);
  });

  it('stores a record the core reloads as fixed history', () => {
    const h = harness();
    const result = h.games.applyGame(h.aoife, {
      type: 'propose',
      boardSize: 5,
      joinType: 'open',
      ptn: OPENING_PTN,
    });
    const { gameId } = result._unsafeUnwrap() as { gameId: number };

    // The stored text is the whole contract with ticket 11: reloading it must
    // give back the same four moves, all fixed and therefore never undoable.
    const stored = h.persistence.findGameById(gameId)._unsafeUnwrap()?.importedPtn;
    const reloaded = fromPtnText(stored ?? '')._unsafeUnwrap();
    expect(reloaded.history).toHaveLength(4);
    expect(reloaded.fixedMoves).toBe(4);
    expect(reloaded.state.size).toBe(5);
  });

  it('treats blank PTN as proposing from an empty board', () => {
    const h = harness();

    const result = h.games.applyGame(h.aoife, {
      type: 'propose',
      boardSize: 5,
      joinType: 'open',
      ptn: '   \n  ',
    });

    const { gameId } = result._unsafeUnwrap() as { gameId: number };
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()?.importedPtn).toBeNull();
  });
});

describe('games: deleteProposal', () => {
  function proposal(h: Harness, actor: SessionUser): number {
    const r = h.games.applyGame(actor, { type: 'propose', boardSize: 5, joinType: 'open' });
    return (r._unsafeUnwrap() as { gameId: number }).gameId;
  }

  it('lets the proposer delete a proposal nobody has joined', () => {
    const h = harness();
    const gameId = proposal(h, h.aoife);

    const result = h.games.applyGame(h.aoife, { type: 'deleteProposal', gameId });

    expect(result.isOk()).toBe(true);
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toBeNull();
    expect(trailEvents(h.db)).toEqual(['game-proposed', 'game-proposal-deleted']);
  });

  it('keeps the deleted game’s id in the trail payload, which no cascade can clear', () => {
    const h = harness();
    // Production opens the database with foreign_keys ON, so deleting the game
    // nulls activity_trail.game_id. The payload is the durable evidence.
    h.db.pragma('foreign_keys = ON');
    const gameId = proposal(h, h.aoife);

    h.games.applyGame(h.aoife, { type: 'deleteProposal', gameId });

    const row = h.db
      .prepare("SELECT game_id, payload FROM activity_trail WHERE event = 'game-proposal-deleted'")
      .get() as { game_id: number | null; payload: string };
    expect(row.game_id).toBeNull();
    expect(JSON.parse(row.payload)).toMatchObject({ gameId });
  });

  it('refuses anyone but the proposer', () => {
    const h = harness();
    const gameId = proposal(h, h.aoife);

    const result = h.games.applyGame(h.takashi, { type: 'deleteProposal', gameId });

    expect(result._unsafeUnwrapErr().code).toBe('forbidden');
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).not.toBeNull();
  });

  it('refuses a game someone has joined', () => {
    const h = harness();
    const gameId = proposal(h, h.aoife);
    h.db.prepare('UPDATE games SET opponent_id = 2 WHERE id = ?').run(gameId);

    const result = h.games.applyGame(h.aoife, { type: 'deleteProposal', gameId });

    expect(result._unsafeUnwrapErr().code).toBe('already-joined');
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).not.toBeNull();
  });

  it('refuses a game that has left the proposed state', () => {
    const h = harness();
    const gameId = proposal(h, h.aoife);
    h.db.prepare("UPDATE games SET state = 'in_play' WHERE id = ?").run(gameId);

    const result = h.games.applyGame(h.aoife, { type: 'deleteProposal', gameId });

    expect(result._unsafeUnwrapErr().code).toBe('not-proposed');
  });

  it('reports an unknown game as not found', () => {
    const h = harness();

    const result = h.games.applyGame(h.aoife, { type: 'deleteProposal', gameId: 404 });

    expect(result._unsafeUnwrapErr().code).toBe('not-found');
  });
});

describe('games: listMyGames', () => {
  it('lists the actor’s own proposals and games in play, and nobody else’s', () => {
    const h = harness();
    h.games.applyGame(h.aoife, { type: 'propose', boardSize: 5, joinType: 'open' });
    h.games.applyGame(h.takashi, { type: 'propose', boardSize: 6, joinType: 'open' });

    const mine = h.games.listMyGames(h.aoife)._unsafeUnwrap();

    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      boardSize: 5,
      state: 'proposed',
      joinType: 'open',
      proposer: { id: 1, displayName: 'Aoife Nolan' },
      opponent: null,
      imported: false,
      canDelete: true,
    });
  });

  it('includes a game the actor joined as opponent', () => {
    const h = harness();
    const r = h.games.applyGame(h.takashi, { type: 'propose', boardSize: 5, joinType: 'open' });
    const { gameId } = r._unsafeUnwrap() as { gameId: number };
    h.db.prepare("UPDATE games SET opponent_id = 1, state = 'in_play' WHERE id = ?").run(gameId);

    const mine = h.games.listMyGames(h.aoife)._unsafeUnwrap();

    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      state: 'in_play',
      proposer: { displayName: 'Takashi Mori' },
      opponent: { displayName: 'Aoife Nolan' },
      canDelete: false,
    });
  });

  it('refuses an admin account: an admin has no games', () => {
    const h = harness();

    expect(h.games.listMyGames(h.root)._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('omits finished games', () => {
    const h = harness();
    const r = h.games.applyGame(h.aoife, { type: 'propose', boardSize: 5, joinType: 'open' });
    const { gameId } = r._unsafeUnwrap() as { gameId: number };
    h.db.prepare("UPDATE games SET state = 'finished' WHERE id = ?").run(gameId);

    expect(h.games.listMyGames(h.aoife)._unsafeUnwrap()).toEqual([]);
  });

  it('names the invited player and marks an imported game', () => {
    const h = harness();
    h.games.applyGame(h.aoife, {
      type: 'propose',
      boardSize: 5,
      joinType: 'invited',
      invitedDisplayName: 'Takashi Mori',
      ptn: OPENING_PTN,
    });

    const mine = h.games.listMyGames(h.aoife)._unsafeUnwrap();

    expect(mine[0]).toMatchObject({
      joinType: 'invited',
      invitedPlayer: { id: 2, displayName: 'Takashi Mori' },
      imported: true,
    });
  });
});
