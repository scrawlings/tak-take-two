import { describe, it, expect } from 'vitest';
import { ok, type Result } from 'neverthrow';
import {
  createTakGame,
  generateTps,
  loadGame,
  parseMove,
  playMove,
  type StoredGame,
  type StoredMove,
  type TakGame,
} from '@tak/core';
import { createGameViews, recordError, type GameSummary, type GameViews, type GameViewsDeps } from '../src/game-views.js';
import type { GameRecord, GameSide } from '../src/persistence.js';
import type { SessionUser } from '../src/auth.js';

/**
 * The view assembly on its own: a hand-built record (plus the playable game
 * and names the lifecycle module would normally feed in) and a stub of the six
 * injected rules. The real rules — the same shapes, enforced next to the
 * commands — are exercised through `games.test.ts`; here the contract under
 * test is "given rules + record, produce the view", so the stubs mirror the
 * rules without importing them (the seam runs one way).
 */

const aoife: SessionUser = {
  id: 1,
  username: 'aoife',
  displayName: 'Aoife Nolan',
  role: 'player',
  forcePasswordChange: false,
  blocked: false,
};
const takashi: SessionUser = {
  id: 2,
  username: 'takashi',
  displayName: 'Takashi Mori',
  role: 'player',
  forcePasswordChange: false,
  blocked: false,
};
const root: SessionUser = {
  id: 3,
  username: 'root',
  displayName: 'Root Keeper',
  role: 'admin',
  forcePasswordChange: false,
  blocked: false,
};

function game(overrides: Partial<GameRecord> = {}): GameRecord {
  return {
    id: 1,
    boardSize: 5,
    state: 'proposed',
    joinType: 'open',
    proposerId: aoife.id,
    opponentId: null,
    invitedPlayerId: null,
    importedPtn: null,
    proposerShared: true,
    opponentShared: true,
    proposerHidden: false,
    opponentHidden: false,
    pendingKind: null,
    pendingBy: null,
    result: null,
    proposerSeat: 1,
    adminRemoved: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

/** The stored record + playable game for a live game with the given moves. */
function played(moves: readonly string[]): { record: StoredGame; tak: TakGame } {
  let tak = createTakGame(5);
  const stored: StoredMove[] = [];
  for (const text of moves) {
    tak = playMove(tak, parseMove(text)._unsafeUnwrap())._unsafeUnwrap();
    stored.push({ notation: text, playedAt: stored.length, position: generateTps(tak.state) });
  }
  return { record: { size: 5, importedPtn: null, result: null, moves: stored }, tak };
}

/** The stored record + playable game for a game imported from PTN, unplayed. */
function imported(ptn: string): { record: StoredGame; tak: TakGame } {
  // The write seam stores an import as `importedPtn` with no move rows; the
  // core replays the prefix as fixed history (ADR-0005).
  const record: StoredGame = { size: 5, importedPtn: ptn, moves: [], result: null };
  return { record, tak: loadGame(record)._unsafeUnwrap() };
}

/** A legal, unfinished 5×5 opening: each player's first turn places an opponent stone. */
const OPENING_PTN = '[Size "5"]\n1. a1 e5\n2. c3 c4';

/** Mirror of the lifecycle module's rules — the shapes only, see header comment. */
function deps(): GameViewsDeps {
  const seatOf = (g: GameRecord, player: 1 | 2): number | null => {
    if (g.proposerSeat === null) return null;
    if (player === 1) return g.proposerSeat === 1 ? g.proposerId : g.opponentId;
    return g.proposerSeat === 1 ? g.opponentId : g.proposerId;
  };
  const seatOfActor = (g: GameRecord, actorId: number): 1 | 2 | null => {
    if (g.proposerSeat === null) return null;
    if (g.proposerId === actorId) return g.proposerSeat;
    if (g.opponentId === actorId) return g.proposerSeat === 1 ? 2 : 1;
    return null;
  };
  const sidesOf = (g: GameRecord, actorId: number): GameSide[] => {
    const sides: GameSide[] = [];
    if (g.proposerId === actorId) sides.push('proposer');
    if (g.opponentId === actorId) sides.push('opponent');
    else if (g.opponentId === null && g.invitedPlayerId === actorId) sides.push('opponent');
    return sides;
  };
  return {
    seatOf,
    seatOfActor,
    sidesOf,
    isSelfPlay: (g) => g.proposerId === g.opponentId,
    deletableBy: (g, actorId) => g.state === 'proposed' && g.opponentId === null && g.proposerId === actorId,
    joinableBy: (g, actor) =>
      actor.role === 'player' && g.state === 'proposed' && g.opponentId === null &&
      (g.joinType === 'open' || g.invitedPlayerId === actor.id),
  };
}

function views(d: GameViewsDeps = deps()): GameViews {
  return createGameViews(d);
}

function names(users: readonly SessionUser[]): (id: number) => Result<{ id: number; displayName: string }, never> {
  const byId = new Map(users.map((u) => [u.id, u]));
  return (id) => {
    const u = byId.get(id);
    if (u === undefined) throw new Error(`no such user ${id}`);
    return ok({ id: u.id, displayName: u.displayName });
  };
}

/** An in-play game with aoife as proposer/seat 1 and takashi as opponent/seat 2. */
function inPlayWithMoves(moves: readonly string[]): { g: GameRecord; record: StoredGame; tak: TakGame } {
  const { record, tak } = played(moves);
  return {
    g: game({ state: 'in_play', opponentId: takashi.id, proposerSeat: 1 }),
    record,
    tak,
  };
}

describe('game views: gameView', () => {
  it('renders imported history as fixed and played moves as live', () => {
    const { record, tak } = imported(OPENING_PTN);
    const g = game({ state: 'in_play', opponentId: takashi.id, proposerSeat: 1 });
    // A join with no live moves: the history is exactly the imported prefix.
    const view = views().gameView({ actor: aoife, game: g, record, tak, nameOf: names([aoife, takashi]) })._unsafeUnwrap();

    expect(view.moves).toHaveLength(4);
    expect(view.moves.every((m) => m.imported)).toBe(true);
    expect(view.board).toHaveLength(5);
    expect(view.board[0]).toHaveLength(5);
    expect(view.toMoveSeat).toBe(1);
    expect(view.toMove).toEqual({ id: aoife.id, displayName: aoife.displayName });
  });

  it('marks the viewer seat and whether they may move', () => {
    const { g, record, tak } = inPlayWithMoves(['a1', 'e5']);

    const aoifeView = views().gameView({ actor: aoife, game: g, record, tak, nameOf: names([aoife, takashi]) })._unsafeUnwrap();
    expect(aoifeView.viewerSeat).toBe(1);
    expect(aoifeView.canMove).toBe(true); // proposer is seat 1, first to move
    expect(aoifeView.canResign).toBe(true);
    expect(aoifeView.canOfferDraw).toBe(true);
    expect(aoifeView.canOfferTakeBack).toBe(false); // no move of hers yet

    const takashiView = views().gameView({ actor: takashi, game: g, record, tak, nameOf: names([aoife, takashi]) })._unsafeUnwrap();
    expect(takashiView.viewerSeat).toBe(2);
    expect(takashiView.canMove).toBe(false);
    expect(takashiView.canResign).toBe(true);
    expect(takashiView.canOfferDraw).toBe(true);
  });

  it('shows a take-back request to the respondent with canRespond, and none to others', () => {
    const { g, record, tak } = inPlayWithMoves(['a1', 'e5']);
    const withRequest: GameRecord = { ...g, pendingKind: 'take-back', pendingBy: takashi.id };

    const view = views().gameView({ actor: aoife, game: withRequest, record, tak, nameOf: names([aoife, takashi]) })._unsafeUnwrap();
    expect(view.pending).toEqual({ kind: 'take-back', requester: { id: 2, displayName: 'Takashi Mori' } });
    expect(view.canRespond).toBe(true);
    expect(view.canOfferDraw).toBe(false);
    expect(view.canOfferTakeBack).toBe(false);
  });

  it('reports corrupt records through recordError with the game named', () => {
    const { g, record, tak } = inPlayWithMoves(['a1', 'e5']);
    const wrecked: StoredGame = { ...record, moves: [{ ...record.moves[0]!, position: 'nonsense' }] };

    const error = views().gameView({ actor: aoife, game: g, record: wrecked, tak, nameOf: names([aoife, takashi]) })._unsafeUnwrapErr();
    expect(error.code).toBe('corrupt-record');
    expect(error.message).toMatch(/game 1/);
    expect(recordError(1, { code: 'corrupt-record', message: 'x' })).toEqual({ code: 'corrupt-record', message: 'game 1: x' });
  });

  it('decides share/hide from the viewer side and admin powers from the role', () => {
    const { record, tak } = inPlayWithMoves(['a1', 'e5']);
    const unshared = game({ state: 'in_play', opponentId: takashi.id, proposerSeat: 1, proposerShared: false });

    const proposerView = views().gameView({ actor: aoife, game: unshared, record, tak, nameOf: names([aoife, takashi]) })._unsafeUnwrap();
    expect(proposerView.viewerShared).toBe(false);
    expect(proposerView.canHide).toBe(true);
    expect(proposerView.canAdminDelete).toBe(false);

    const adminView = views().gameView({ actor: root, game: unshared, record, tak, nameOf: names([aoife, takashi]) })._unsafeUnwrap();
    expect(adminView.viewerSeat).toBeNull();
    expect(adminView.canMove).toBe(false);
    expect(adminView.canAdminDelete).toBe(true);
    expect(adminView.canHide).toBe(false);
  });

  it('resolves a finished game result to text', () => {
    const { record, tak } = inPlayWithMoves(['a1', 'e5']);
    const finished = game({ state: 'finished', opponentId: takashi.id, proposerSeat: 1, result: '1/2-1/2' });

    const view = views().gameView({ actor: aoife, game: finished, record, tak, nameOf: names([aoife, takashi]) })._unsafeUnwrap();
    expect(view.resultText).toBe('Draw by agreement');
    expect(view.toMove).toBeNull();
  });
});

describe('game views: summarise', () => {
  it('names the invited player, resolves otherPlayer, and derives toMove from the fed seat', () => {
    const g = game({
      state: 'in_play',
      joinType: 'invited',
      opponentId: takashi.id,
      invitedPlayerId: takashi.id,
      proposerSeat: 1,
    });

    const summary = views().summarise({
      actor: aoife,
      game: g,
      nameOf: names([aoife, takashi]),
      lastMoveAt: new Map(),
      follows: new Set(),
      toMovePlayer: 2,
    })._unsafeUnwrap();

    expect(summary.invitedPlayer).toEqual({ id: 2, displayName: 'Takashi Mori' });
    expect(summary.imported).toBe(false);
    expect(summary.otherPlayer).toEqual({ id: 2, displayName: 'Takashi Mori' });
    expect(summary.toMove).toEqual({ id: 2, displayName: 'Takashi Mori' });
  });

  it('decides canDelete, canJoin and canSolo from the injected rules', () => {
    const proposed = game({});

    const owner = views().summarise({
      actor: aoife,
      game: proposed,
      nameOf: names([aoife]),
      lastMoveAt: new Map(),
      follows: new Set(),
      toMovePlayer: null,
    })._unsafeUnwrap();
    expect(owner.canDelete).toBe(true);
    expect(owner.canJoin).toBe(true);
    expect(owner.canSolo).toBe(true);

    const stranger = views().summarise({
      actor: takashi,
      game: proposed,
      nameOf: names([aoife, takashi]),
      lastMoveAt: new Map(),
      follows: new Set(),
      toMovePlayer: null,
    })._unsafeUnwrap();
    expect(stranger.canDelete).toBe(false);
    expect(stranger.canJoin).toBe(true);
    expect(stranger.canSolo).toBe(false);
    expect(stranger.otherPlayer).toBeNull();
  });

  it('falls back to createdAt for lastActivity, and reads the follow standing', () => {
    const g = game({ state: 'in_play', opponentId: takashi.id, proposerSeat: 1 });
    const summary = views().summarise({
      actor: aoife,
      game: g,
      nameOf: names([aoife, takashi]),
      lastMoveAt: new Map(),
      follows: new Set([aoife.id]),
      toMovePlayer: null,
    })._unsafeUnwrap();

    expect(summary.lastActivity).toBe(g.createdAt);
    expect(summary.toMove).toBeNull();
    expect(summary.followed).toBe(true);
    expect(summary.canFollow).toBe(false); // their own proposal
  });

  it('prefers a last-move timestamp over createdAt once a game has moved', () => {
    const g = game({ state: 'in_play', opponentId: takashi.id, proposerSeat: 1 });
    const summary = views().summarise({
      actor: aoife,
      game: g,
      nameOf: names([aoife, takashi]),
      lastMoveAt: new Map([[g.id, '2024-06-01T00:00:00.000Z']]),
      follows: new Set(),
      toMovePlayer: 1,
    })._unsafeUnwrap();

    expect(summary.lastActivity).toBe('2024-06-01T00:00:00.000Z');
  });
});

describe('game views: sortSummaries', () => {
  const row = (
    id: number,
    lastActivity: string,
    createdAt: string,
    boardSize: 5 | 6,
  ): GameSummary =>
    ({
      id,
      boardSize,
      state: 'proposed',
      joinType: 'open',
      proposer: { id: aoife.id, displayName: aoife.displayName },
      opponent: null,
      invitedPlayer: null,
      otherPlayer: null,
      imported: false,
      createdAt,
      canDelete: true,
      canJoin: true,
      canSolo: true,
      toMove: null,
      result: null,
      proposerSeat: 1,
      adminRemoved: false,
      lastActivity,
      followed: false,
      canFollow: true,
      canHide: true,
    }) as GameSummary;

  it('sorts by activity, newest first, with an id tiebreak', () => {
    const a = row(1, '2024-01-01', '2024-01-01', 5);
    const b = row(2, '2024-06-01', '2024-05-01', 5);
    const c = row(3, '2024-01-01', '2024-01-01', 5);

    expect(views().sortSummaries([a, b, c], 'activity', 'desc').map((g) => g.id)).toEqual([2, 3, 1]);
    // Tiebreak is always id-descending, whatever the direction.
    expect(views().sortSummaries([a, b, c], 'activity', 'asc').map((g) => g.id)).toEqual([3, 1, 2]);
  });

  it('sorts by creation date and by board size, honouring direction', () => {
    const a = row(1, '2024-01-01', '2024-06-01', 6);
    const b = row(2, '2024-06-01', '2024-01-01', 5);

    expect(views().sortSummaries([a, b], 'created', 'desc').map((g) => g.id)).toEqual([1, 2]);
    expect(views().sortSummaries([a, b], 'size', 'desc').map((g) => g.id)).toEqual([1, 2]);
    expect(views().sortSummaries([a, b], 'size', 'asc').map((g) => g.id)).toEqual([2, 1]);
  });
});
