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
  db.pragma('foreign_keys = ON');
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

  it('imports a record whose result tag claims a road but the position is open', () => {
    const h = harness();
    // The tag is metadata about the game the record came from; only the
    // position bars import, and this one has no road.
    const tagged = `${OPENING_PTN}\nR-0`;

    const result = h.games.applyGame(h.aoife, {
      type: 'propose',
      boardSize: 5,
      joinType: 'open',
      ptn: tagged,
    });

    expect(result.isOk()).toBe(true);
    const { gameId } = result._unsafeUnwrap() as { gameId: number };
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()?.importedPtn).toBe(tagged);
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

describe('games: join', () => {
  function propose(
    h: Harness,
    actor: SessionUser,
    extra: { joinType?: string; invitedDisplayName?: string; ptn?: string; boardSize?: number } = {},
  ): number {
    const r = h.games.applyGame(actor, {
      type: 'propose',
      boardSize: extra.boardSize ?? 5,
      joinType: extra.joinType ?? 'open',
      invitedDisplayName: extra.invitedDisplayName,
      ptn: extra.ptn,
    });
    return (r._unsafeUnwrap() as { gameId: number }).gameId;
  }

  it('lets a player join an open game, starting play', () => {
    const h = harness();
    const gameId = propose(h, h.aoife);

    const result = h.games.applyGame(h.takashi, { type: 'join', gameId });

    expect(result._unsafeUnwrap()).toMatchObject({ type: 'join', gameId });
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toMatchObject({
      state: 'in_play',
      opponentId: 2,
    });
  });

  it('starts an open game already shared, because joining implies sharing', () => {
    const h = harness();
    const gameId = propose(h, h.aoife);

    h.games.applyGame(h.takashi, { type: 'join', gameId });

    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toMatchObject({
      proposerShared: true,
      opponentShared: true,
    });
  });

  it('keeps an invited game private to its two players', () => {
    const h = harness();
    const gameId = propose(h, h.aoife, { joinType: 'invited', invitedDisplayName: 'Takashi Mori' });

    h.games.applyGame(h.takashi, { type: 'join', gameId });

    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toMatchObject({
      state: 'in_play',
      proposerShared: false,
      opponentShared: false,
    });
  });

  it('lets the designated player join an invited game', () => {
    const h = harness();
    const gameId = propose(h, h.aoife, { joinType: 'invited', invitedDisplayName: 'Takashi Mori' });

    expect(h.games.applyGame(h.takashi, { type: 'join', gameId }).isOk()).toBe(true);
  });

  it('refuses a player the invited game does not name', () => {
    const h = harness();
    insertUser(h.db, { id: 4, username: 'wren', displayName: 'Wren Alvarez' });
    const wren: SessionUser = {
      id: 4, username: 'wren', displayName: 'Wren Alvarez', role: 'player',
      forcePasswordChange: false, blocked: false,
    };
    const gameId = propose(h, h.aoife, { joinType: 'invited', invitedDisplayName: 'Takashi Mori' });

    // Wren cannot even see it, so it must read as absent rather than refused.
    expect(h.games.applyGame(wren, { type: 'join', gameId })._unsafeUnwrapErr().code).toBe('not-found');
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()?.opponentId).toBeNull();
  });

  it('refuses the proposer of a game invited to someone else', () => {
    const h = harness();
    const gameId = propose(h, h.aoife, { joinType: 'invited', invitedDisplayName: 'Takashi Mori' });

    // Aoife can see her own proposal, so this is a refusal, not a disappearance.
    expect(h.games.applyGame(h.aoife, { type: 'join', gameId })._unsafeUnwrapErr().code).toBe('not-invited');
  });

  it('lets a player join their own open game, for study', () => {
    const h = harness();
    const gameId = propose(h, h.aoife);

    expect(h.games.applyGame(h.aoife, { type: 'join', gameId }).isOk()).toBe(true);
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toMatchObject({
      proposerId: 1,
      opponentId: 1,
      state: 'in_play',
    });
  });

  it('lets a player join a game they invited themselves to', () => {
    const h = harness();
    const gameId = propose(h, h.aoife, { joinType: 'invited', invitedDisplayName: 'Aoife Nolan' });

    expect(h.games.applyGame(h.aoife, { type: 'join', gameId }).isOk()).toBe(true);
  });

  it('cannot be joined twice', () => {
    const h = harness();
    const gameId = propose(h, h.aoife);
    h.games.applyGame(h.takashi, { type: 'join', gameId });

    insertUser(h.db, { id: 4, username: 'wren', displayName: 'Wren Alvarez' });
    const wren: SessionUser = {
      id: 4, username: 'wren', displayName: 'Wren Alvarez', role: 'player',
      forcePasswordChange: false, blocked: false,
    };
    const second = h.games.applyGame(wren, { type: 'join', gameId });

    expect(second._unsafeUnwrapErr().code).toBe('not-proposed');
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()?.opponentId).toBe(2);
  });

  it('refuses an admin account', () => {
    const h = harness();
    const gameId = propose(h, h.aoife);

    expect(h.games.applyGame(h.root, { type: 'join', gameId })._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('reports an unknown game as not found', () => {
    const h = harness();

    expect(h.games.applyGame(h.aoife, { type: 'join', gameId: 404 })._unsafeUnwrapErr().code).toBe('not-found');
  });

  it('decides what a stranger may see from the share toggles, not the join type', () => {
    const h = harness();
    insertUser(h.db, { id: 4, username: 'wren', displayName: 'Wren Alvarez' });
    const wren: SessionUser = {
      id: 4, username: 'wren', displayName: 'Wren Alvarez', role: 'player',
      forcePasswordChange: false, blocked: false,
    };
    const gameId = propose(h, h.aoife, { joinType: 'invited', invitedDisplayName: 'Takashi Mori' });

    // Private by default (ADR-0003): a stranger cannot tell it exists.
    expect(h.games.applyGame(wren, { type: 'join', gameId })._unsafeUnwrapErr().code).toBe('not-found');

    // Turning both toggles on makes it visible, so the refusal becomes honest.
    // This is what ticket 13 will do, and it must not need a change here.
    h.db.prepare('UPDATE games SET proposer_shared = 1, opponent_shared = 1 WHERE id = ?').run(gameId);
    expect(h.games.applyGame(wren, { type: 'join', gameId })._unsafeUnwrapErr().code).toBe('not-invited');
  });

  it('writes a game-joined trail event, and none when refused', () => {
    const h = harness();
    const gameId = propose(h, h.aoife);

    h.games.applyGame(h.takashi, { type: 'join', gameId });
    expect(trailEvents(h.db)).toEqual(['game-proposed', 'game-joined']);

    h.games.applyGame(h.takashi, { type: 'join', gameId });
    expect(trailEvents(h.db)).toEqual(['game-proposed', 'game-joined']);
  });

  describe('the first player to move', () => {
    it('is the proposer on an empty board', () => {
      const h = harness();
      const gameId = propose(h, h.aoife);
      h.games.applyGame(h.takashi, { type: 'join', gameId });

      const game = h.games.listMyGames(h.aoife)._unsafeUnwrap()[0];
      expect(game?.toMove).toEqual({ id: 1, displayName: 'Aoife Nolan' });
    });

    it('follows the imported record when the history is odd', () => {
      const h = harness();
      // Three half-moves played, so it is player 2's turn — the opponent.
      const gameId = propose(h, h.aoife, { ptn: '[Size "5"]\n1. a1 e5\n2. c3' });
      h.games.applyGame(h.takashi, { type: 'join', gameId });

      const game = h.games.listMyGames(h.aoife)._unsafeUnwrap()[0];
      expect(game?.toMove).toEqual({ id: 2, displayName: 'Takashi Mori' });
    });

    it('is nobody while the game is still a proposal', () => {
      const h = harness();
      propose(h, h.aoife);

      expect(h.games.listMyGames(h.aoife)._unsafeUnwrap()[0]?.toMove).toBeNull();
    });
  });
});

describe('games: searchProposed', () => {
  function propose(
    h: Harness,
    actor: SessionUser,
    extra: { joinType?: string; invitedDisplayName?: string; boardSize?: number } = {},
  ): number {
    const r = h.games.applyGame(actor, {
      type: 'propose',
      boardSize: extra.boardSize ?? 5,
      joinType: extra.joinType ?? 'open',
      invitedDisplayName: extra.invitedDisplayName,
    });
    return (r._unsafeUnwrap() as { gameId: number }).gameId;
  }

  it('lists open proposals, including the searcher’s own', () => {
    const h = harness();
    const mine = propose(h, h.aoife);
    const theirs = propose(h, h.takashi);

    const found = h.games.searchProposed(h.aoife)._unsafeUnwrap();

    expect(found.map((g) => g.id).sort()).toEqual([mine, theirs].sort());
    expect(found.every((g) => g.canJoin)).toBe(true);
  });

  it('shows an invited game only to the player it names', () => {
    const h = harness();
    insertUser(h.db, { id: 4, username: 'wren', displayName: 'Wren Alvarez' });
    const wren: SessionUser = {
      id: 4, username: 'wren', displayName: 'Wren Alvarez', role: 'player',
      forcePasswordChange: false, blocked: false,
    };
    const invited = propose(h, h.aoife, { joinType: 'invited', invitedDisplayName: 'Takashi Mori' });

    expect(h.games.searchProposed(h.takashi)._unsafeUnwrap().map((g) => g.id)).toContain(invited);
    // A stranger must not see it, and neither must the proposer: this page is
    // for games you can take up, and Aoife's own invitation is not one.
    expect(h.games.searchProposed(wren)._unsafeUnwrap().map((g) => g.id)).not.toContain(invited);
    expect(h.games.searchProposed(h.aoife)._unsafeUnwrap().map((g) => g.id)).not.toContain(invited);
  });

  it('offers everything it lists as joinable', () => {
    const h = harness();
    propose(h, h.aoife);
    propose(h, h.aoife, { joinType: 'invited', invitedDisplayName: 'Takashi Mori' });

    const found = h.games.searchProposed(h.takashi)._unsafeUnwrap();

    expect(found).toHaveLength(2);
    expect(found.every((g) => g.canJoin)).toBe(true);
  });

  it('omits games that have been joined', () => {
    const h = harness();
    const gameId = propose(h, h.aoife);
    h.games.applyGame(h.takashi, { type: 'join', gameId });

    expect(h.games.searchProposed(h.aoife)._unsafeUnwrap()).toEqual([]);
  });

  it('filters by board size', () => {
    const h = harness();
    propose(h, h.aoife, { boardSize: 5 });
    const six = propose(h, h.aoife, { boardSize: 6 });

    const found = h.games.searchProposed(h.takashi, { boardSize: 6 })._unsafeUnwrap();

    expect(found.map((g) => g.id)).toEqual([six]);
  });

  it('filters by join type', () => {
    const h = harness();
    const open = propose(h, h.aoife);
    propose(h, h.aoife, { joinType: 'invited', invitedDisplayName: 'Takashi Mori' });

    const found = h.games.searchProposed(h.takashi, { joinType: 'open' })._unsafeUnwrap();

    expect(found.map((g) => g.id)).toEqual([open]);
  });

  it('filters by part of the proposer’s display name, ignoring case', () => {
    const h = harness();
    const aoifes = propose(h, h.aoife);
    propose(h, h.takashi);

    const found = h.games.searchProposed(h.takashi, { proposerDisplayName: 'nolan' })._unsafeUnwrap();

    expect(found.map((g) => g.id)).toEqual([aoifes]);
  });

  it('treats a blank name filter as no filter', () => {
    const h = harness();
    propose(h, h.aoife);
    propose(h, h.takashi);

    expect(h.games.searchProposed(h.takashi, { proposerDisplayName: '  ' })._unsafeUnwrap()).toHaveLength(2);
  });

  it('matches a name containing LIKE wildcards literally', () => {
    const h = harness();
    insertUser(h.db, { id: 4, username: 'pct', displayName: '100% Tak' });
    const odd: SessionUser = {
      id: 4, username: 'pct', displayName: '100% Tak', role: 'player',
      forcePasswordChange: false, blocked: false,
    };
    const oddGame = propose(h, odd);
    propose(h, h.aoife);

    expect(h.games.searchProposed(h.aoife, { proposerDisplayName: '0% T' })._unsafeUnwrap().map((g) => g.id))
      .toEqual([oddGame]);
    // A bare '%' is a literal percent sign, not "match everything": it finds
    // the one name that contains one, and not Aoife's.
    expect(h.games.searchProposed(h.aoife, { proposerDisplayName: '%' })._unsafeUnwrap().map((g) => g.id))
      .toEqual([oddGame]);
  });

  it('rejects a nonsense filter rather than ignoring it', () => {
    const h = harness();

    expect(h.games.searchProposed(h.aoife, { boardSize: 7 })._unsafeUnwrapErr().code).toBe('invalid-board-size');
    expect(h.games.searchProposed(h.aoife, { joinType: 'secret' })._unsafeUnwrapErr().code).toBe('invalid-join-type');
  });

  it('refuses an admin account', () => {
    const h = harness();

    expect(h.games.searchProposed(h.root)._unsafeUnwrapErr().code).toBe('forbidden');
  });
});

/** A road win for the proposer, played one place at a time (11 half-moves). */
const ROAD_MOVES = ['a1', 'a5', 'a3', 'a2', 'b3', 'a4', 'c3', 'b4', 'd3', 'b2', 'e3'];

describe('games: play', () => {
  function propose(h: Harness, actor: SessionUser, extra: { ptn?: string } = {}): number {
    const r = h.games.applyGame(actor, {
      type: 'propose',
      boardSize: 5,
      joinType: 'open',
      ptn: extra.ptn,
    });
    return (r._unsafeUnwrap() as { gameId: number }).gameId;
  }

  function play(h: Harness, actor: SessionUser, gameId: number, move: string) {
    return h.games.applyGame(actor, { type: 'playMove', gameId, move });
  }

  function gameStats(db: Database.Database, gameId: number): Record<string, unknown> | undefined {
    return db.prepare('SELECT * FROM game_stats WHERE game_id = ?').get(gameId) as
      | Record<string, unknown>
      | undefined;
  }

  it('records a legal move with its notation, position, and turn tracking', () => {
    const h = harness();
    const gameId = propose(h, h.aoife);
    h.games.applyGame(h.takashi, { type: 'join', gameId });

    const result = play(h, h.aoife, gameId, 'a1');

    expect(result.isOk()).toBe(true);
    const moves = h.persistence.listMoves(gameId)._unsafeUnwrap();
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ gameId, moveNumber: 1, playerId: 1, notation: 'a1' });
    expect(moves[0]?.position).toMatch(/ 2 1$/); // TPS: player 2 to move, move counter 1

    // The turn has passed to the opponent.
    const view = h.games.getGame(h.aoife, gameId)._unsafeUnwrap();
    expect(view.toMove).toEqual({ id: 2, displayName: 'Takashi Mori' });
    expect(view.canMove).toBe(false);
  });

  it('rejects a move when it is not your turn', () => {
    const h = harness();
    const gameId = propose(h, h.aoife);
    h.games.applyGame(h.takashi, { type: 'join', gameId });

    const result = play(h, h.takashi, gameId, 'a1');
    expect(result._unsafeUnwrapErr().code).toBe('not-your-turn');
  });

  it('rejects a spectator of a shared game, and an admin', () => {
    const h = harness();
    const gameId = propose(h, h.aoife);
    h.games.applyGame(h.takashi, { type: 'join', gameId });
    const stranger = insertUser(h.db, { id: 9, username: 'stranger', displayName: 'Stranger' });

    // A shared open game is visible to a stranger, but they may not move.
    expect(h.games.getGame(stranger, gameId).isOk()).toBe(true);
    expect(play(h, stranger, gameId, 'a1')._unsafeUnwrapErr().code).toBe('forbidden');

    // An admin never plays.
    expect(play(h, h.root, gameId, 'a1')._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('rejects an illegal move with a clear message', () => {
    const h = harness();
    const gameId = propose(h, h.aoife);
    h.games.applyGame(h.takashi, { type: 'join', gameId });

    // The opening move must be a flat place, not a standing stone.
    const result = play(h, h.aoife, gameId, 'Sa1');
    expect(result._unsafeUnwrapErr().code).toBe('invalid-move');
    expect(result._unsafeUnwrapErr().message).toContain('opening move must place a flat stone');
  });

  it('detects a road win, finishes the game, and writes stats and trail', () => {
    const h = harness();
    const gameId = propose(h, h.aoife);
    h.games.applyGame(h.takashi, { type: 'join', gameId });

    for (const [i, move] of ROAD_MOVES.entries()) {
      const actor = i % 2 === 0 ? h.aoife : h.takashi;
      const result = play(h, actor, gameId, move);
      expect(result.isOk()).toBe(true);
    }

    const game = h.persistence.findGameById(gameId)._unsafeUnwrap();
    expect(game).toMatchObject({ state: 'finished', result: 'R-0' });
    expect(h.persistence.listMoves(gameId)._unsafeUnwrap()).toHaveLength(11);
    expect(gameStats(h.db, gameId)).toMatchObject({
      board_size: 5,
      move_count: 11,
      result: 'R-0',
    });
    expect(trailEvents(h.db)).toContain('game-finished');
    expect(trailEvents(h.db).filter((e) => e === 'move-played')).toHaveLength(11);
  });

  it('refuses a move on a finished game', () => {
    const h = harness();
    const gameId = propose(h, h.aoife);
    h.games.applyGame(h.takashi, { type: 'join', gameId });
    h.games.applyGame(h.aoife, { type: 'resign', gameId });

    expect(play(h, h.takashi, gameId, 'a1')._unsafeUnwrapErr().code).toBe('not-in-play');
  });
});

describe('games: resign and draw', () => {
  function inPlay(h: Harness): number {
    const r = h.games.applyGame(h.aoife, { type: 'propose', boardSize: 5, joinType: 'open' });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;
    h.games.applyGame(h.takashi, { type: 'join', gameId });
    return gameId;
  }

  function stats(db: Database.Database, gameId: number): Record<string, unknown> | undefined {
    return db.prepare('SELECT * FROM game_stats WHERE game_id = ?').get(gameId) as
      | Record<string, unknown>
      | undefined;
  }

  it('resign ends the game with the opponent winning', () => {
    const h = harness();
    const gameId = inPlay(h);

    const result = h.games.applyGame(h.aoife, { type: 'resign', gameId });

    expect(result.isOk()).toBe(true);
    const game = h.persistence.findGameById(gameId)._unsafeUnwrap();
    expect(game).toMatchObject({ state: 'finished', result: '0-1' });
    expect(stats(h.db, gameId)).toMatchObject({ move_count: 0, result: '0-1' });
    expect(trailEvents(h.db)).toContain('game-finished');
  });

  it('mutual draw ends the game as a draw', () => {
    const h = harness();
    const gameId = inPlay(h);

    const result = h.games.applyGame(h.takashi, { type: 'mutualDraw', gameId });

    expect(result.isOk()).toBe(true);
    const game = h.persistence.findGameById(gameId)._unsafeUnwrap();
    expect(game).toMatchObject({ state: 'finished', result: '1/2-1/2' });
    expect(stats(h.db, gameId)).toMatchObject({ result: '1/2-1/2' });
  });

  it('refuses a resign on a game not in play', () => {
    const h = harness();
    const gameId = inPlay(h);
    h.games.applyGame(h.aoife, { type: 'resign', gameId });

    expect(h.games.applyGame(h.takashi, { type: 'resign', gameId })._unsafeUnwrapErr().code).toBe('not-in-play');
  });
});

describe('games: game view', () => {
  it('renders imported history as fixed and played moves as live', () => {
    const h = harness();
    const r = h.games.applyGame(h.aoife, { type: 'propose', boardSize: 5, joinType: 'open', ptn: OPENING_PTN });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;
    h.games.applyGame(h.takashi, { type: 'join', gameId });

    const before = h.games.getGame(h.aoife, gameId)._unsafeUnwrap();
    expect(before.moves).toHaveLength(4);
    expect(before.moves.every((m) => m.imported)).toBe(true);
    expect(before.board).toHaveLength(5);
    expect(before.board[0]).toHaveLength(5);

    h.games.applyGame(h.aoife, { type: 'playMove', gameId, move: 'b2' });

    const after = h.games.getGame(h.aoife, gameId)._unsafeUnwrap();
    expect(after.moves).toHaveLength(5);
    expect(after.moves[4]).toMatchObject({
      number: 5,
      seat: 1,
      notation: 'b2',
      imported: false,
      player: { id: 1, displayName: 'Aoife Nolan' },
    });
  });

  it('marks the viewer seat and whether they may move', () => {
    const h = harness();
    const r = h.games.applyGame(h.aoife, { type: 'propose', boardSize: 5, joinType: 'open' });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;
    h.games.applyGame(h.takashi, { type: 'join', gameId });

    const aoifeView = h.games.getGame(h.aoife, gameId)._unsafeUnwrap();
    expect(aoifeView.viewerSeat).toBe(1);
    expect(aoifeView.canMove).toBe(true);
    expect(aoifeView.canEnd).toBe(true);

    const takashiView = h.games.getGame(h.takashi, gameId)._unsafeUnwrap();
    expect(takashiView.viewerSeat).toBe(2);
    expect(takashiView.canMove).toBe(false);
    expect(takashiView.canEnd).toBe(true);
  });

  it('reports not-found for a game the viewer cannot see, and for a stranger to a shared game gives no seat', () => {
    const h = harness();
    const r = h.games.applyGame(h.aoife, {
      type: 'propose',
      boardSize: 5,
      joinType: 'invited',
      invitedDisplayName: 'Takashi Mori',
    });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;
    h.games.applyGame(h.takashi, { type: 'join', gameId });
    const stranger = insertUser(h.db, { id: 9, username: 'stranger', displayName: 'Stranger' });

    // Invited games start unshared, so the stranger cannot see it at all.
    expect(h.games.getGame(stranger, gameId)._unsafeUnwrapErr().code).toBe('not-found');
  });
});

describe('games: self-play', () => {
  function selfPlayGame(h: Harness): number {
    const r = h.games.applyGame(h.aoife, { type: 'propose', boardSize: 5, joinType: 'open' });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;
    h.games.applyGame(h.aoife, { type: 'join', gameId });
    return gameId;
  }

  it('lets one account play both seats from the single game window', () => {
    const h = harness();
    const gameId = selfPlayGame(h);

    // Seat 1 (filled) opens…
    expect(h.games.applyGame(h.aoife, { type: 'playMove', gameId, move: 'a2' }).isOk()).toBe(true);
    // …then seat 2 (open) opens — still the same account, and not refused.
    expect(h.games.applyGame(h.aoife, { type: 'playMove', gameId, move: 'a5' }).isOk()).toBe(true);

    const view = h.games.getGame(h.aoife, gameId)._unsafeUnwrap();
    expect(view.selfPlay).toBe(true);
    expect(view.viewerSeat).toBe(1);
    expect(view.canMove).toBe(true); // whichever seat's turn it is
    expect(view.canEnd).toBe(false); // no resign/draw against yourself
  });

  it('refuses a resign in self-play', () => {
    const h = harness();
    const gameId = selfPlayGame(h);

    expect(h.games.applyGame(h.aoife, { type: 'resign', gameId })._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('refuses a mutual draw in self-play', () => {
    const h = harness();
    const gameId = selfPlayGame(h);

    expect(h.games.applyGame(h.aoife, { type: 'mutualDraw', gameId })._unsafeUnwrapErr().code).toBe('forbidden');
  });
});
