import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';
import { createPersistence, type Persistence } from '../src/persistence.js';
import { createGames, type Games } from '../src/games.js';
import { fromPtnText, generateTps, parseTps, parsePtn } from '@tak/core';
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

describe('games: who starts (seat choice)', () => {
  function propose(h: Harness, actor: SessionUser, extra: { starter?: string; ptn?: string } = {}): number {
    const r = h.games.applyGame(actor, {
      type: 'propose',
      boardSize: 5,
      joinType: 'open',
      starter: extra.starter,
      ptn: extra.ptn,
    });
    return (r._unsafeUnwrap() as { gameId: number }).gameId;
  }

  it('defaults to the proposer starting (seat 1)', () => {
    const h = harness();
    const gameId = propose(h, h.aoife);
    h.games.applyGame(h.takashi, { type: 'join', gameId });

    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()?.proposerSeat).toBe(1);
    expect(h.games.getGame(h.aoife, gameId)._unsafeUnwrap().viewerSeat).toBe(1);
    expect(h.games.getGame(h.aoife, gameId)._unsafeUnwrap().toMove).toEqual({
      id: 1,
      displayName: 'Aoife Nolan',
    });
  });

  it('lets the proposer give the start to the opponent', () => {
    const h = harness();
    const gameId = propose(h, h.aoife, { starter: 'opponent' });
    h.games.applyGame(h.takashi, { type: 'join', gameId });

    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()?.proposerSeat).toBe(2);
    // The joiner holds seat 1 and moves first; the proposer holds seat 2.
    expect(h.games.getGame(h.takashi, gameId)._unsafeUnwrap().viewerSeat).toBe(1);
    expect(h.games.getGame(h.aoife, gameId)._unsafeUnwrap().viewerSeat).toBe(2);
    expect(h.games.getGame(h.takashi, gameId)._unsafeUnwrap().toMove).toEqual({
      id: 2,
      displayName: 'Takashi Mori',
    });
  });

  it('resolves a random start once, when the joiner claims the game', () => {
    const h = harness();
    const gameId = propose(h, h.aoife, { starter: 'random' });
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()?.proposerSeat).toBeNull();

    h.games.applyGame(h.takashi, { type: 'join', gameId });

    const seat = h.persistence.findGameById(gameId)._unsafeUnwrap()?.proposerSeat;
    expect(seat === 1 || seat === 2).toBe(true);
    // Whoever holds seat 1 moves first.
    expect(h.games.getGame(h.aoife, gameId)._unsafeUnwrap().toMove?.id).toBe(seat === 1 ? 1 : 2);
  });

  it('enforces turn order on the chosen seat', () => {
    const h = harness();
    const gameId = propose(h, h.aoife, { starter: 'opponent' });
    h.games.applyGame(h.takashi, { type: 'join', gameId });

    // The proposer is seat 2 now, so it is not her turn.
    expect(
      h.games.applyGame(h.aoife, { type: 'playMove', gameId, move: 'a1' })._unsafeUnwrapErr().code,
    ).toBe('not-your-turn');
    // The joiner is seat 1 and may move first.
    expect(h.games.applyGame(h.takashi, { type: 'playMove', gameId, move: 'a1' }).isOk()).toBe(true);
  });

  it('replays an imported record from the other seat when the opponent starts', () => {
    const h = harness();
    // OPENING_PTN has four half-moves, so it is player 1's turn to move again.
    const gameId = propose(h, h.aoife, { starter: 'opponent', ptn: OPENING_PTN });
    h.games.applyGame(h.takashi, { type: 'join', gameId });

    // Seat 1 is the joiner now: the imported moves belong to him, and so does
    // the next turn — the proposer cannot move from the other seat.
    expect(
      h.games.applyGame(h.aoife, { type: 'playMove', gameId, move: 'a3' })._unsafeUnwrapErr().code,
    ).toBe('not-your-turn');
    expect(h.games.applyGame(h.takashi, { type: 'playMove', gameId, move: 'a3' }).isOk()).toBe(true);
  });

  it('attributes a resignation to the seat, not the proposer', () => {
    const h = harness();
    const gameId = propose(h, h.aoife, { starter: 'opponent' });
    h.games.applyGame(h.takashi, { type: 'join', gameId });

    // Aoife (seat 2) resigns, so seat 1 (Takashi) wins.
    h.games.applyGame(h.aoife, { type: 'resign', gameId });

    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()?.result).toBe('1-0');
    expect(h.games.getGame(h.takashi, gameId)._unsafeUnwrap().resultText).toBe(
      'Takashi Mori wins by resignation',
    );
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

  it('marks only your own proposal as solo, never someone else’s', () => {
    const h = harness();
    propose(h, h.aoife);

    // On the proposer's own list the proposal is claimable as a solo game.
    const mine = h.games.listMyGames(h.aoife)._unsafeUnwrap();
    expect(mine[0]).toMatchObject({ canJoin: true, canSolo: true });

    // For anyone else the same proposal is a plain join, not a solo.
    const found = h.games.searchProposed(h.takashi)._unsafeUnwrap();
    expect(found[0]).toMatchObject({ canJoin: true, canSolo: false });
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

  it('carries the TPS of the position after each move, for the review scrubber', () => {
    const h = harness();
    const gameId = propose(h, h.aoife);
    h.games.applyGame(h.takashi, { type: 'join', gameId });
    play(h, h.aoife, gameId, 'a1');
    play(h, h.takashi, gameId, 'e5');

    const view = h.games.getGame(h.aoife, gameId)._unsafeUnwrap();
    expect(view.moves).toHaveLength(2);
    // Matches what `export`'s TPS gives for the same move number.
    const exported = h.games.applyGame(h.aoife, {
      type: 'export',
      gameId,
      format: 'tps',
      throughMove: 1,
    })._unsafeUnwrap();
    expect(exported.type).toBe('export');
    expect(view.moves[0]?.tps).toBe((exported as { text: string }).text);
    expect(view.moves[1]?.tps).toMatch(/ 1 2$/); // player 1 to move, move counter 2
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

  it('a draw offer ends the game only when the opponent accepts', () => {
    const h = harness();
    const gameId = inPlay(h);

    const offered = h.games.applyGame(h.takashi, { type: 'offerDraw', gameId });
    expect(offered.isOk()).toBe(true);
    // The offer is pending, not a finish.
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toMatchObject({
      state: 'in_play',
      result: null,
      pendingKind: 'draw',
      pendingBy: 2,
    });

    const accepted = h.games.applyGame(h.aoife, { type: 'acceptDraw', gameId });
    expect(accepted.isOk()).toBe(true);
    const game = h.persistence.findGameById(gameId)._unsafeUnwrap();
    expect(game).toMatchObject({ state: 'finished', result: '1/2-1/2', pendingKind: null });
    expect(stats(h.db, gameId)).toMatchObject({ result: '1/2-1/2' });
    expect(trailEvents(h.db)).toContain('game-finished');
  });

  it('does not finish the game when only one player asks for a draw', () => {
    const h = harness();
    const gameId = inPlay(h);

    const result = h.games.applyGame(h.aoife, { type: 'offerDraw', gameId });

    // The opponent has not agreed: the game must remain in play.
    expect(result.isOk()).toBe(true);
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toMatchObject({
      state: 'in_play',
      result: null,
    });
  });

  it('lets the respondent reject the offer and play continues', () => {
    const h = harness();
    const gameId = inPlay(h);
    h.games.applyGame(h.takashi, { type: 'offerDraw', gameId });

    expect(h.games.applyGame(h.aoife, { type: 'rejectDraw', gameId }).isOk()).toBe(true);
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toMatchObject({
      state: 'in_play',
      pendingKind: null,
    });
    expect(trailEvents(h.db)).toContain('draw-rejected');
  });

  it('blocks moves and further offers while a draw is pending', () => {
    const h = harness();
    const gameId = inPlay(h);
    h.games.applyGame(h.aoife, { type: 'playMove', gameId, move: 'a1' });
    h.games.applyGame(h.takashi, { type: 'offerDraw', gameId });

    // Neither player may move while the offer is out…
    expect(h.games.applyGame(h.takashi, { type: 'playMove', gameId, move: 'e5' })._unsafeUnwrapErr().code).toBe(
      'request-pending',
    );
    // …and no second request may be made.
    expect(h.games.applyGame(h.aoife, { type: 'offerDraw', gameId })._unsafeUnwrapErr().code).toBe('request-pending');
    expect(h.games.applyGame(h.takashi, { type: 'requestTakeBack', gameId })._unsafeUnwrapErr().code).toBe(
      'request-pending',
    );
  });

  it('refuses to respond when there is no pending request, or to your own', () => {
    const h = harness();
    const gameId = inPlay(h);

    expect(h.games.applyGame(h.aoife, { type: 'acceptDraw', gameId })._unsafeUnwrapErr().code).toBe(
      'no-pending-request',
    );
    h.games.applyGame(h.aoife, { type: 'offerDraw', gameId });
    expect(h.games.applyGame(h.aoife, { type: 'acceptDraw', gameId })._unsafeUnwrapErr().code).toBe('forbidden');
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
    expect(aoifeView.canResign).toBe(true);
    expect(aoifeView.canOfferDraw).toBe(true);
    expect(aoifeView.canOfferTakeBack).toBe(false); // no move of hers yet

    const takashiView = h.games.getGame(h.takashi, gameId)._unsafeUnwrap();
    expect(takashiView.viewerSeat).toBe(2);
    expect(takashiView.canMove).toBe(false);
    expect(takashiView.canResign).toBe(true);
    expect(takashiView.canOfferDraw).toBe(true);
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
    expect(view.canResign).toBe(false); // no resign against yourself
    expect(view.canOfferDraw).toBe(false);
    expect(view.canOfferTakeBack).toBe(false);
  });

  it('refuses a resign in self-play', () => {
    const h = harness();
    const gameId = selfPlayGame(h);

    expect(h.games.applyGame(h.aoife, { type: 'resign', gameId })._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('refuses a draw offer in self-play', () => {
    const h = harness();
    const gameId = selfPlayGame(h);

    expect(h.games.applyGame(h.aoife, { type: 'offerDraw', gameId })._unsafeUnwrapErr().code).toBe('forbidden');
  });
});

describe('games: take-back', () => {
  function inPlay(h: Harness): number {
    const r = h.games.applyGame(h.aoife, { type: 'propose', boardSize: 5, joinType: 'open' });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;
    h.games.applyGame(h.takashi, { type: 'join', gameId });
    return gameId;
  }

  /** An in-play game where seat 1 (Aoife) has just opened with a2. */
  function inPlayWithMove(h: Harness): number {
    const gameId = inPlay(h);
    h.games.applyGame(h.aoife, { type: 'playMove', gameId, move: 'a2' });
    return gameId;
  }

  it('requesting a take-back after your move makes it pending for the opponent', () => {
    const h = harness();
    const gameId = inPlayWithMove(h);

    expect(h.games.applyGame(h.aoife, { type: 'requestTakeBack', gameId }).isOk()).toBe(true);
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toMatchObject({
      pendingKind: 'take-back',
      pendingBy: 1,
    });

    const requesterView = h.games.getGame(h.aoife, gameId)._unsafeUnwrap();
    expect(requesterView.pending).toMatchObject({ kind: 'take-back' });
    expect(requesterView.canRespond).toBe(false);
    expect(h.games.getGame(h.takashi, gameId)._unsafeUnwrap().canRespond).toBe(true);
  });

  it('accept undoes the requester last move and hands the turn back', () => {
    const h = harness();
    const gameId = inPlayWithMove(h);
    h.games.applyGame(h.aoife, { type: 'requestTakeBack', gameId });

    expect(h.games.applyGame(h.takashi, { type: 'acceptTakeBack', gameId }).isOk()).toBe(true);

    expect(h.persistence.listMoves(gameId)._unsafeUnwrap()).toHaveLength(0);
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toMatchObject({ pendingKind: null });
    const view = h.games.getGame(h.aoife, gameId)._unsafeUnwrap();
    expect(view.toMoveSeat).toBe(1);
    expect(view.canMove).toBe(true);
    expect(trailEvents(h.db)).toContain('take-back-accepted');
  });

  it('reject lets play continue with the move intact', () => {
    const h = harness();
    const gameId = inPlayWithMove(h);
    h.games.applyGame(h.aoife, { type: 'requestTakeBack', gameId });

    expect(h.games.applyGame(h.takashi, { type: 'rejectTakeBack', gameId }).isOk()).toBe(true);
    expect(h.persistence.listMoves(gameId)._unsafeUnwrap()).toHaveLength(1);
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toMatchObject({ pendingKind: null });
    expect(trailEvents(h.db)).toContain('take-back-rejected');
  });

  it('refuses a take-back when there is no live move of yours to take back', () => {
    const h = harness();
    const gameId = inPlay(h); // nobody has moved yet

    expect(h.games.applyGame(h.aoife, { type: 'requestTakeBack', gameId })._unsafeUnwrapErr().code).toBe(
      'no-move-to-take-back',
    );
  });

  it('refuses a take-back once the opponent has moved', () => {
    const h = harness();
    const gameId = inPlayWithMove(h);
    h.games.applyGame(h.takashi, { type: 'playMove', gameId, move: 'a5' });

    expect(h.games.applyGame(h.aoife, { type: 'requestTakeBack', gameId })._unsafeUnwrapErr().code).toBe(
      'no-move-to-take-back',
    );
  });

  it('refuses a take-back in self-play', () => {
    const h = harness();
    const r = h.games.applyGame(h.aoife, { type: 'propose', boardSize: 5, joinType: 'open' });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;
    h.games.applyGame(h.aoife, { type: 'join', gameId });
    h.games.applyGame(h.aoife, { type: 'playMove', gameId, move: 'a2' });

    expect(h.games.applyGame(h.aoife, { type: 'requestTakeBack', gameId })._unsafeUnwrapErr().code).toBe('forbidden');
  });
});

function wren(h: Harness): SessionUser {
  insertUser(h.db, { id: 4, username: 'wren', displayName: 'Wren Alvarez' });
  return {
    id: 4,
    username: 'wren',
    displayName: 'Wren Alvarez',
    role: 'player',
    forcePasswordChange: false,
    blocked: false,
  };
}

describe('games: share', () => {
  function inPlay(h: Harness): number {
    const r = h.games.applyGame(h.aoife, { type: 'propose', boardSize: 5, joinType: 'open' });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;
    h.games.applyGame(h.takashi, { type: 'join', gameId });
    return gameId;
  }

  it('lets a participant turn their own share off and on', () => {
    const h = harness();
    const gameId = inPlay(h);

    expect(h.games.applyGame(h.aoife, { type: 'share', gameId, on: false }).isOk()).toBe(true);
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toMatchObject({
      proposerShared: false,
      opponentShared: true, // only the actor's own side changes
    });
    expect(h.games.getGame(h.aoife, gameId)._unsafeUnwrap().viewerShared).toBe(false);
    expect(trailEvents(h.db)).toContain('game-unshared');

    expect(h.games.applyGame(h.aoife, { type: 'share', gameId, on: true }).isOk()).toBe(true);
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toMatchObject({ proposerShared: true });
    expect(trailEvents(h.db)).toContain('game-shared');
  });

  it('re-sharing clears a prior hide, bringing the game back into the list', () => {
    const h = harness();
    const gameId = inPlay(h);
    h.games.applyGame(h.aoife, { type: 'hide', gameId });
    expect(h.games.listMyGames(h.aoife)._unsafeUnwrap()).toEqual([]);

    expect(h.games.applyGame(h.aoife, { type: 'share', gameId, on: true }).isOk()).toBe(true);

    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toMatchObject({
      proposerHidden: false,
      proposerShared: true,
    });
    expect(h.games.listMyGames(h.aoife)._unsafeUnwrap().map((g) => g.id)).toContain(gameId);
  });

  it('lets an invited, not-yet-joined player set their side before joining', () => {
    const h = harness();
    const r = h.games.applyGame(h.aoife, {
      type: 'propose',
      boardSize: 5,
      joinType: 'invited',
      invitedDisplayName: 'Takashi Mori',
    });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;

    expect(h.games.applyGame(h.takashi, { type: 'share', gameId, on: true }).isOk()).toBe(true);
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toMatchObject({ opponentShared: true });
  });

  it('sets both sides at once in self-play', () => {
    const h = harness();
    const r = h.games.applyGame(h.aoife, { type: 'propose', boardSize: 5, joinType: 'open' });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;
    h.games.applyGame(h.aoife, { type: 'join', gameId });

    expect(h.games.applyGame(h.aoife, { type: 'share', gameId, on: false }).isOk()).toBe(true);
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toMatchObject({
      proposerShared: false,
      opponentShared: false,
    });
  });

  it('refuses a non-participant', () => {
    const h = harness();
    const gameId = inPlay(h);

    expect(h.games.applyGame(wren(h), { type: 'share', gameId, on: true })._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('refuses an admin account', () => {
    const h = harness();
    const gameId = inPlay(h);

    expect(h.games.applyGame(h.root, { type: 'share', gameId, on: true })._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('reports an unknown game as not found', () => {
    const h = harness();

    expect(h.games.applyGame(h.aoife, { type: 'share', gameId: 404, on: true })._unsafeUnwrapErr().code).toBe(
      'not-found',
    );
  });
});

describe('games: hide', () => {
  function inPlay(h: Harness): number {
    const r = h.games.applyGame(h.aoife, { type: 'propose', boardSize: 5, joinType: 'open' });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;
    h.games.applyGame(h.takashi, { type: 'join', gameId });
    return gameId;
  }

  it('removes the game from the hider’s own list, leaving the other player’s untouched', () => {
    const h = harness();
    const gameId = inPlay(h);

    expect(h.games.applyGame(h.aoife, { type: 'hide', gameId }).isOk()).toBe(true);

    expect(h.games.listMyGames(h.aoife)._unsafeUnwrap()).toEqual([]);
    expect(h.games.listMyGames(h.takashi)._unsafeUnwrap().map((g) => g.id)).toContain(gameId);
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toMatchObject({
      proposerHidden: true,
      proposerShared: false,
    });
    expect(trailEvents(h.db)).toContain('game-hidden');
  });

  it('deletes the game once both players have hidden it', () => {
    const h = harness();
    const gameId = inPlay(h);

    h.games.applyGame(h.aoife, { type: 'hide', gameId });
    expect(h.games.applyGame(h.takashi, { type: 'hide', gameId }).isOk()).toBe(true);

    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toBeNull();
    expect(trailEvents(h.db)).toContain('game-deleted');
  });

  it('deletes immediately in self-play, which always holds both sides', () => {
    const h = harness();
    const r = h.games.applyGame(h.aoife, { type: 'propose', boardSize: 5, joinType: 'open' });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;
    h.games.applyGame(h.aoife, { type: 'join', gameId });

    expect(h.games.applyGame(h.aoife, { type: 'hide', gameId }).isOk()).toBe(true);

    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toBeNull();
  });

  it('lets the invited, not-yet-joined player hide their invitation, and mutual hide still deletes it', () => {
    const h = harness();
    const r = h.games.applyGame(h.aoife, {
      type: 'propose',
      boardSize: 5,
      joinType: 'invited',
      invitedDisplayName: 'Takashi Mori',
    });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;

    expect(h.games.applyGame(h.takashi, { type: 'hide', gameId }).isOk()).toBe(true);
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toMatchObject({ opponentHidden: true });

    expect(h.games.applyGame(h.aoife, { type: 'hide', gameId }).isOk()).toBe(true);
    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toBeNull();
  });

  it('clears a pre-join hide once the hider actually joins, so their new game is not stuck invisible', () => {
    const h = harness();
    const r = h.games.applyGame(h.aoife, {
      type: 'propose',
      boardSize: 5,
      joinType: 'invited',
      invitedDisplayName: 'Takashi Mori',
    });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;
    h.games.applyGame(h.takashi, { type: 'hide', gameId });

    expect(h.games.applyGame(h.takashi, { type: 'join', gameId }).isOk()).toBe(true);

    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toMatchObject({
      opponentHidden: false,
      proposerHidden: false,
    });
    expect(h.games.listMyGames(h.takashi)._unsafeUnwrap().map((g) => g.id)).toContain(gameId);
  });

  it('refuses a non-participant', () => {
    const h = harness();
    const gameId = inPlay(h);

    expect(h.games.applyGame(wren(h), { type: 'hide', gameId })._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('refuses an admin account', () => {
    const h = harness();
    const gameId = inPlay(h);

    expect(h.games.applyGame(h.root, { type: 'hide', gameId })._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('reports an unknown game as not found', () => {
    const h = harness();

    expect(h.games.applyGame(h.aoife, { type: 'hide', gameId: 404 })._unsafeUnwrapErr().code).toBe('not-found');
  });
});

describe('games: admin delete and view', () => {
  function inPlay(h: Harness): number {
    const r = h.games.applyGame(h.aoife, { type: 'propose', boardSize: 5, joinType: 'open' });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;
    h.games.applyGame(h.takashi, { type: 'join', gameId });
    return gameId;
  }

  it('lets an admin view any game regardless of share state', () => {
    const h = harness();
    const r = h.games.applyGame(h.aoife, {
      type: 'propose',
      boardSize: 5,
      joinType: 'invited',
      invitedDisplayName: 'Takashi Mori',
    });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;
    h.games.applyGame(h.takashi, { type: 'join', gameId });

    const view = h.games.getGame(h.root, gameId)._unsafeUnwrap();
    expect(view.viewerSeat).toBeNull();
    expect(view.canAdminDelete).toBe(true);
  });

  it('ends the game, keeps the record, and stops further play', () => {
    const h = harness();
    const gameId = inPlay(h);
    h.games.applyGame(h.aoife, { type: 'playMove', gameId, move: 'a2' });

    expect(h.games.applyGame(h.root, { type: 'adminDelete', gameId }).isOk()).toBe(true);

    const game = h.persistence.findGameById(gameId)._unsafeUnwrap();
    expect(game).toMatchObject({ state: 'finished', adminRemoved: true });
    expect(h.persistence.listMoves(gameId)._unsafeUnwrap()).toHaveLength(1); // history is kept
    expect(trailEvents(h.db)).toContain('game-admin-deleted');

    // Further play is refused, like any other finished game.
    expect(h.games.applyGame(h.takashi, { type: 'playMove', gameId, move: 'e5' })._unsafeUnwrapErr().code).toBe(
      'not-in-play',
    );

    // Affected players still see it, marked, in their own list and view.
    const summary = h.games.listMyGames(h.aoife)._unsafeUnwrap().find((g) => g.id === gameId);
    expect(summary?.adminRemoved).toBe(true);
    expect(h.games.getGame(h.aoife, gameId)._unsafeUnwrap().adminRemoved).toBe(true);
  });

  it('preserves a real result when removing an already-finished game', () => {
    const h = harness();
    const gameId = inPlay(h);
    h.games.applyGame(h.aoife, { type: 'resign', gameId });
    const finishedAt = h.persistence.findGameById(gameId)._unsafeUnwrap()?.finishedAt;

    expect(h.games.applyGame(h.root, { type: 'adminDelete', gameId }).isOk()).toBe(true);

    expect(h.persistence.findGameById(gameId)._unsafeUnwrap()).toMatchObject({
      state: 'finished',
      result: '0-1',
      adminRemoved: true,
      finishedAt,
    });
  });

  it('refuses to remove a game twice', () => {
    const h = harness();
    const gameId = inPlay(h);
    h.games.applyGame(h.root, { type: 'adminDelete', gameId });

    expect(h.games.applyGame(h.root, { type: 'adminDelete', gameId })._unsafeUnwrapErr().code).toBe(
      'already-removed',
    );
  });

  it('refuses a non-admin', () => {
    const h = harness();
    const gameId = inPlay(h);

    expect(h.games.applyGame(h.aoife, { type: 'adminDelete', gameId })._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('reports an unknown game as not found', () => {
    const h = harness();

    expect(h.games.applyGame(h.root, { type: 'adminDelete', gameId: 404 })._unsafeUnwrapErr().code).toBe(
      'not-found',
    );
  });
});

describe('games: export', () => {
  /** An in-play open game between Aoife (seat 1) and Takashi (seat 2). */
  function inPlay(h: Harness): number {
    const r = h.games.applyGame(h.aoife, { type: 'propose', boardSize: 5, joinType: 'open' });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;
    h.games.applyGame(h.takashi, { type: 'join', gameId });
    return gameId;
  }

  /** Play `moves` alternately from seat 1, as a real game would run. */
  function playAll(h: Harness, gameId: number, moves: readonly string[]): void {
    moves.forEach((move, i) => {
      const actor = i % 2 === 0 ? h.aoife : h.takashi;
      const played = h.games.applyGame(actor, { type: 'playMove', gameId, move });
      expect(played.isOk()).toBe(true);
    });
  }

  function exported(
    h: Harness,
    actor: SessionUser,
    gameId: number,
    format: string,
    throughMove?: number,
  ): { text: string; throughMove: number; totalMoves: number } {
    const r = h.games.applyGame(actor, { type: 'export', gameId, format, throughMove });
    return r._unsafeUnwrap() as { text: string; throughMove: number; totalMoves: number };
  }

  it('exports the full game as PTN that re-imports and replays', () => {
    const h = harness();
    const gameId = inPlay(h);
    playAll(h, gameId, ROAD_MOVES);

    const out = exported(h, h.aoife, gameId, 'ptn');

    expect(out.throughMove).toBe(ROAD_MOVES.length);
    expect(out.totalMoves).toBe(ROAD_MOVES.length);
    // The whole point of the record: it survives a round trip through import.
    const reimported = fromPtnText(out.text);
    expect(reimported.isOk()).toBe(true);
    expect(reimported._unsafeUnwrap().history).toHaveLength(ROAD_MOVES.length);
  });

  it('names both players in the record, and the result once the game is finished', () => {
    const h = harness();
    const gameId = inPlay(h);
    playAll(h, gameId, ROAD_MOVES); // a road win for seat 1

    const out = exported(h, h.aoife, gameId, 'ptn');

    const parsed = parsePtn(out.text)._unsafeUnwrap();
    expect(parsed.tags.get('Player1')).toBe('Aoife Nolan');
    expect(parsed.tags.get('Player2')).toBe('Takashi Mori');
    expect(parsed.size).toBe(5);
    expect(parsed.result).toBe('R-0');
  });

  it('names the seat-1 player as Player1 when the proposer starts second', () => {
    const h = harness();
    const r = h.games.applyGame(h.aoife, {
      type: 'propose',
      boardSize: 5,
      joinType: 'open',
      starter: 'opponent',
    });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;
    h.games.applyGame(h.takashi, { type: 'join', gameId });
    // Takashi is seat 1 now, so he moves first and is Player1 in the record.
    h.games.applyGame(h.takashi, { type: 'playMove', gameId, move: 'a1' });

    const out = exported(h, h.aoife, gameId, 'ptn');
    const parsed = parsePtn(out.text)._unsafeUnwrap();

    expect(parsed.tags.get('Player1')).toBe('Takashi Mori');
    expect(parsed.tags.get('Player2')).toBe('Aoife Nolan');
  });

  it('exports a prefix that replays, and never claims a result the prefix has not reached', () => {
    const h = harness();
    const gameId = inPlay(h);
    playAll(h, gameId, ROAD_MOVES); // finished, R-0

    const out = exported(h, h.aoife, gameId, 'ptn', 4);

    expect(out.throughMove).toBe(4);
    expect(out.totalMoves).toBe(ROAD_MOVES.length);
    const reimported = fromPtnText(out.text);
    expect(reimported.isOk()).toBe(true);
    expect(reimported._unsafeUnwrap().history).toHaveLength(4);
    // The game was won at move 11; a prefix ending at 4 is still in play.
    expect(out.text).not.toContain('R-0');
    expect(parsePtn(out.text)._unsafeUnwrap().result).toBeNull();
  });

  it('exports the TPS of the position after a chosen move, and it round-trips', () => {
    const h = harness();
    const gameId = inPlay(h);
    playAll(h, gameId, ROAD_MOVES.slice(0, 3));

    const out = exported(h, h.aoife, gameId, 'tps', 2);

    // Two half-moves played, so it is player 1's turn on move 2.
    expect(out.text).toMatch(/ 1 2$/);
    const parsed = parseTps(out.text);
    expect(parsed.isOk()).toBe(true);
    expect(generateTps(parsed._unsafeUnwrap())).toBe(out.text);
  });

  it('exports the starting position as TPS through move 0', () => {
    const h = harness();
    const gameId = inPlay(h);
    playAll(h, gameId, ROAD_MOVES.slice(0, 2));

    const out = exported(h, h.aoife, gameId, 'tps', 0);

    expect(out.text).toBe('x5/x5/x5/x5/x5 1 1');
    expect(parseTps(out.text).isOk()).toBe(true);
  });

  it('records an ending the moves cannot show, like a resignation', () => {
    const h = harness();
    const gameId = inPlay(h);
    playAll(h, gameId, ROAD_MOVES.slice(0, 1));
    h.games.applyGame(h.aoife, { type: 'resign', gameId });

    const out = exported(h, h.aoife, gameId, 'ptn');

    // A resignation lives in the game record, not in the position, so it can
    // only reach the PTN from the stored result.
    expect(parsePtn(out.text)._unsafeUnwrap().result).toBe('0-1');
    expect(fromPtnText(out.text).isOk()).toBe(true);
  });

  it('records an agreed draw the same way', () => {
    const h = harness();
    const gameId = inPlay(h);
    h.games.applyGame(h.aoife, { type: 'offerDraw', gameId });
    h.games.applyGame(h.takashi, { type: 'acceptDraw', gameId });

    const out = exported(h, h.aoife, gameId, 'ptn');

    expect(parsePtn(out.text)._unsafeUnwrap().result).toBe('1/2-1/2');
    expect(fromPtnText(out.text).isOk()).toBe(true);
  });

  it('exports a proposal nobody has joined, naming only the proposer', () => {
    const h = harness();
    const r = h.games.applyGame(h.aoife, { type: 'propose', boardSize: 5, joinType: 'open', ptn: OPENING_PTN });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;

    const out = exported(h, h.aoife, gameId, 'ptn');

    expect(out.totalMoves).toBe(4);
    expect(parsePtn(out.text)._unsafeUnwrap().tags.has('Player2')).toBe(false);
    expect(fromPtnText(out.text).isOk()).toBe(true);
  });

  it('exports an empty game as a valid record and its starting position', () => {
    const h = harness();
    const r = h.games.applyGame(h.aoife, { type: 'propose', boardSize: 6, joinType: 'open' });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;

    expect(fromPtnText(exported(h, h.aoife, gameId, 'ptn').text).isOk()).toBe(true);
    expect(exported(h, h.aoife, gameId, 'tps').text).toBe('x6/x6/x6/x6/x6/x6 1 1');
  });

  it('carries imported history into the export', () => {
    const h = harness();
    const r = h.games.applyGame(h.aoife, { type: 'propose', boardSize: 5, joinType: 'open', ptn: OPENING_PTN });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;
    h.games.applyGame(h.takashi, { type: 'join', gameId });
    h.games.applyGame(h.aoife, { type: 'playMove', gameId, move: 'b2' });

    const out = exported(h, h.aoife, gameId, 'ptn');

    // Four imported moves plus the one played here.
    expect(out.totalMoves).toBe(5);
    expect(fromPtnText(out.text)._unsafeUnwrap().history).toHaveLength(5);
  });

  it('writes a trail event naming what was exported', () => {
    const h = harness();
    const gameId = inPlay(h);
    playAll(h, gameId, ROAD_MOVES.slice(0, 2));

    h.games.applyGame(h.aoife, { type: 'export', gameId, format: 'tps', throughMove: 1 });

    expect(trailEvents(h.db)).toContain('game-exported');
    const payload = (
      h.db.prepare("SELECT payload FROM activity_trail WHERE event = 'game-exported'").get() as {
        payload: string;
      }
    ).payload;
    expect(JSON.parse(payload)).toMatchObject({ format: 'tps', throughMove: 1 });
  });

  it('lets a spectator export a shared game', () => {
    const h = harness();
    const gameId = inPlay(h); // open games start shared
    playAll(h, gameId, ROAD_MOVES.slice(0, 2));
    const stranger = insertUser(h.db, { id: 9, username: 'stranger', displayName: 'Stranger' });

    expect(h.games.applyGame(stranger, { type: 'export', gameId, format: 'ptn' }).isOk()).toBe(true);
  });

  it('hides an unshared game from a stranger, as the game view does', () => {
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

    expect(
      h.games.applyGame(stranger, { type: 'export', gameId, format: 'ptn' })._unsafeUnwrapErr().code,
    ).toBe('not-found');
  });

  it('lets an admin export any game, shared or not', () => {
    const h = harness();
    const r = h.games.applyGame(h.aoife, {
      type: 'propose',
      boardSize: 5,
      joinType: 'invited',
      invitedDisplayName: 'Takashi Mori',
    });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;
    h.games.applyGame(h.takashi, { type: 'join', gameId });

    expect(h.games.applyGame(h.root, { type: 'export', gameId, format: 'ptn' }).isOk()).toBe(true);
  });

  it('refuses a move number beyond the history, and a negative one', () => {
    const h = harness();
    const gameId = inPlay(h);
    playAll(h, gameId, ROAD_MOVES.slice(0, 2));

    expect(
      h.games.applyGame(h.aoife, { type: 'export', gameId, format: 'ptn', throughMove: 3 })._unsafeUnwrapErr().code,
    ).toBe('invalid-move-number');
    expect(
      h.games.applyGame(h.aoife, { type: 'export', gameId, format: 'ptn', throughMove: -1 })._unsafeUnwrapErr().code,
    ).toBe('invalid-move-number');
  });

  it('refuses a format it does not write', () => {
    const h = harness();
    const gameId = inPlay(h);

    expect(
      h.games.applyGame(h.aoife, { type: 'export', gameId, format: 'pgn' })._unsafeUnwrapErr().code,
    ).toBe('invalid-export-format');
  });

  it('reports an unknown game as not found', () => {
    const h = harness();

    expect(
      h.games.applyGame(h.aoife, { type: 'export', gameId: 404, format: 'ptn' })._unsafeUnwrapErr().code,
    ).toBe('not-found');
  });
});

describe('games: a corrupt record', () => {
  /** An in-play open game between Aoife (seat 1) and Takashi (seat 2). */
  function inPlay(h: Harness): number {
    const r = h.games.applyGame(h.aoife, { type: 'propose', boardSize: 5, joinType: 'open' });
    const gameId = (r._unsafeUnwrap() as { gameId: number }).gameId;
    h.games.applyGame(h.takashi, { type: 'join', gameId });
    ['a1', 'a5', 'c3', 'c4'].forEach((move, i) => {
      const actor = i % 2 === 0 ? h.aoife : h.takashi;
      expect(h.games.applyGame(actor, { type: 'playMove', gameId, move }).isOk()).toBe(true);
    });
    return gameId;
  }

  function wreck(h: Harness, gameId: number, moveNumber: number, column: 'notation' | 'position'): void {
    h.db
      .prepare(`UPDATE game_records SET ${column} = 'nonsense' WHERE game_id = ? AND move_number = ?`)
      .run(gameId, moveNumber);
  }

  it('reports a record that no longer parses as corrupt, naming the game', () => {
    const h = harness();
    const gameId = inPlay(h);
    wreck(h, gameId, 2, 'notation');

    const error = h.games.getGame(h.aoife, gameId)._unsafeUnwrapErr();
    expect(error.code).toBe('corrupt-record');
    expect(error.message).toContain(`game ${gameId}`);
    expect(error.message).toContain('stored move 2');
  });

  // Ticket 01: the scrubber renders every move's position, so the view now
  // reads every live snapshot, not just the last one — unlike a move, which
  // still needs only the current position to validate against (below).
  it('the view touches every live position, since the scrubber renders each one', () => {
    const h = harness();
    const gameId = inPlay(h);
    wreck(h, gameId, 2, 'position');

    expect(h.games.getGame(h.aoife, gameId)._unsafeUnwrapErr().code).toBe('corrupt-record');
  });

  it('play still reads only the last position: an earlier wreck does not block a legal move', () => {
    const h = harness();
    const gameId = inPlay(h);
    wreck(h, gameId, 2, 'position');

    expect(h.games.applyGame(h.aoife, { type: 'playMove', gameId, move: 'e1' }).isOk()).toBe(true);
  });

  it('still catches a wrecked position when it is the one the read path reads', () => {
    const h = harness();
    const gameId = inPlay(h);
    wreck(h, gameId, 4, 'position');

    expect(h.games.getGame(h.aoife, gameId)._unsafeUnwrapErr().code).toBe('corrupt-record');
  });

  it('refuses a move on a corrupt record instead of playing onto a guess', () => {
    const h = harness();
    const gameId = inPlay(h);
    wreck(h, gameId, 1, 'notation');

    expect(
      h.games.applyGame(h.aoife, { type: 'playMove', gameId, move: 'e1' })._unsafeUnwrapErr().code,
    ).toBe('corrupt-record');
  });
});
