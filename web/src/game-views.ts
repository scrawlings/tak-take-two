import { err, ok, type Result } from 'neverthrow';
import { formatMove, positionsOf } from '@tak/core';
import type {
  GameError as CoreGameError,
  GameState,
  Player,
  StoneKind,
  StoredGame,
  TakGame,
} from '@tak/core';
import type {
  GameBoardSize,
  GameRecord,
  GameLifecycleState,
  GameSide,
  JoinType,
} from './persistence.js';
import type { SessionUser } from './auth.js';
import type { FilterErrorCode, MyGamesQuery as ResolvedMyGamesQuery } from './list-query.js';

/**
 * The view assembly for the game screen and the games lists — what a game
 * looks like, and every "may the viewer do this" rule the templates need
 * already decided. It is fed by the lifecycle module (`games.ts`), which does
 * all the reading: visibility, name resolution, and record loads happen there
 * and arrive here through the context objects. This module imports nothing
 * from `games.ts` — the dependency runs one way, so a view-shape change or a
 * new view rule touches this file (and its tests) alone, and the command
 * rules stay with the commands that enforce them.
 *
 * The rules that straddle both concerns — seat resolution, self-play, the
 * per-side standing, delete/join eligibility — are injected at the factory:
 * the lifecycle module passes its own implementations, so each rule keeps a
 * single statement where the commands enforce it.
 */

// The four list-filter codes are composed in from `list-query.ts`, the one
// statement of the filter vocabulary (ADR-0013's derivation): the game module
// owns the lifecycle codes, the filter module owns the four it can fail under,
// and the parent union can never desync from the child because it contains it.
export type GameErrorCode =
  | FilterErrorCode
  | 'forbidden'
  | 'not-found'
  | 'invalid-invite'
  | 'invalid-starter'
  | 'invalid-ptn'
  | 'already-joined'
  | 'not-invited'
  | 'not-proposed'
  | 'not-in-play'
  | 'not-your-turn'
  | 'invalid-move'
  | 'request-pending'
  | 'no-pending-request'
  | 'no-move-to-take-back'
  | 'already-removed'
  | 'invalid-export-format'
  | 'invalid-move-number'
  | 'invalid-follow'
  /** The stored record no longer parses or replays (ADR-0005); internal, like `persistence`. */
  | 'corrupt-record'
  | 'persistence';

export interface GameError {
  readonly code: GameErrorCode;
  readonly message: string;
}

/** A player as the game views name them: the display name, never the username. */
export interface PlayerRef {
  readonly id: number;
  readonly displayName: string;
}

/** One row of a games list, with every rule the view needs already decided. */
export interface GameSummary {
  readonly id: number;
  readonly boardSize: GameBoardSize;
  readonly state: GameLifecycleState;
  readonly joinType: JoinType;
  readonly proposer: PlayerRef;
  readonly opponent: PlayerRef | null;
  readonly invitedPlayer: PlayerRef | null;
  /** The participant who is not the viewer, or null while nobody has joined. */
  readonly otherPlayer: PlayerRef | null;
  /** True when the game was proposed from a PTN record rather than an empty board. */
  readonly imported: boolean;
  readonly createdAt: string;
  /** Whether the viewer may delete this proposal — decided here, never in a view. */
  readonly canDelete: boolean;
  /** Whether the viewer may join this proposal — likewise decided here. */
  readonly canJoin: boolean;
  /**
   * The viewer may claim their own proposal, making it a self-play game
   * (CONTEXT.md: Self-play); the join button reads “solo” for them.
   */
  readonly canSolo: boolean;
  /** Whose turn it is, or null while the game is not in play. */
  readonly toMove: PlayerRef | null;
  /** The stored PTN result (`R-0`, `1/2-1/2`, …), or null while not finished. */
  readonly result: string | null;
  /**
   * The core seat (1 or 2) the proposer holds; null means random, resolved
   * when the joiner claims the game. Seat 1 (filled) moves first.
   */
  readonly proposerSeat: 1 | 2 | null;
  /** Ticket 13: this game was ended by an admin, not by play or agreement. */
  readonly adminRemoved: boolean;
  /**
   * The last played move's timestamp, or `createdAt` for a game with none yet
   * (ticket 03) — derived at read time by the lifecycle module's batched
   * timestamp query, so it can never drift the way a stored column could.
   */
  readonly lastActivity: string;
  /** Whether the viewer follows the proposer (ticket 04; CONTEXT.md: Follow). */
  readonly followed: boolean;
  /** Whether a follow/unfollow button makes sense here — never true for the viewer's own proposal. */
  readonly canFollow: boolean;
  /** The viewer is a participant and may hide this game from their own views (ticket 05), same rule as `GameView.canHide`. */
  readonly canHide: boolean;
}

/** One stone as the board view shows it. */
export interface StoneView {
  readonly player: 1 | 2;
  readonly kind: StoneKind;
}

/** One square of the rendered board, with its stack bottom-to-top. */
export interface BoardSquareView {
  readonly file: string;
  readonly rank: number;
  readonly stack: readonly StoneView[];
}

/** One move of the full history (imported first, then played). */
export interface MoveView {
  /** 1-based index in the full history. */
  readonly number: number;
  /** 1 (proposer) or 2 (joiner). */
  readonly seat: 1 | 2;
  readonly player: PlayerRef;
  /** Canonical PTN (`a1`, `Sa1`, `5b4>212`). */
  readonly notation: string;
  /** Imported (fixed) rather than played on this site. */
  readonly imported: boolean;
  /** TPS of the position after this move — what the review scrubber renders from. */
  readonly tps: string;
}

/** One pending request/offer (ticket 12): a take-back request or a draw offer. */
export interface PendingRequestView {
  readonly kind: 'take-back' | 'draw';
  readonly requester: PlayerRef;
}

/** The full game view — every rule the template needs already decided. */
export interface GameView {
  readonly id: number;
  readonly boardSize: GameBoardSize;
  readonly state: GameLifecycleState;
  readonly joinType: JoinType;
  readonly proposer: PlayerRef;
  readonly opponent: PlayerRef | null;
  readonly imported: boolean;
  /** 1 or 2, or null when the viewer is a spectator. */
  readonly viewerSeat: 1 | 2 | null;
  /** One account holds both seats (CONTEXT.md: Self-play). */
  readonly selfPlay: boolean;
  /** Full history, imported first then played. */
  readonly moves: readonly MoveView[];
  /** Rows top-down; each row files left-to-right. */
  readonly board: readonly (readonly BoardSquareView[])[];
  /** Whose turn it is, or null while not in play. */
  readonly toMove: PlayerRef | null;
  /** 1 or 2, or null while not in play. */
  readonly toMoveSeat: 1 | 2 | null;
  /**
   * The core seat (1 or 2) the proposer holds; null means random, resolved
   * when the joiner claims the game. Seat 1 (filled) moves first.
   */
  readonly proposerSeat: 1 | 2 | null;
  /** The viewer may play a move right now. */
  readonly canMove: boolean;
  /** One pending request/offer, from a participant, awaiting the other's answer. */
  readonly pending: PendingRequestView | null;
  /** The viewer is the respondent and may accept/reject the pending request. */
  readonly canRespond: boolean;
  /** The viewer is a participant and may resign. */
  readonly canResign: boolean;
  /** The viewer may offer a draw (nothing pending, not self-play). */
  readonly canOfferDraw: boolean;
  /** The viewer may request a take-back of their last move. */
  readonly canOfferTakeBack: boolean;
  /** Human-readable result, or null while in play. */
  readonly resultText: string | null;
  /** Remaining stones and capstones per seat. */
  readonly reserves: Readonly<Record<1 | 2, { readonly stones: number; readonly capstones: number }>>;
  /**
   * The player to move is on their opening turn (CONTEXT.md: Opening turn), so
   * the stone they place is their opponent's. False while not in play.
   */
  readonly isOpeningTurn: boolean;
  /**
   * The seat whose *stone* goes onto the board next — not the seat to move.
   * On an opening turn those differ: the mover places their opponent's stone.
   * Null while not in play. Decided here so no template re-derives the rule.
   */
  readonly stoneSeat: 1 | 2 | null;
  /** The viewer's own share toggle, or null when they are not a participant. */
  readonly viewerShared: boolean | null;
  /** The viewer is a participant and may hide this game from their own views. */
  readonly canHide: boolean;
  /** The viewer is an admin and this game is not already admin-removed. */
  readonly canAdminDelete: boolean;
  /** Ticket 13: this game was ended by an admin, not by play or agreement. */
  readonly adminRemoved: boolean;
}

/** What a games list may be sorted by (ticket 03) — `list-query.ts`'s `MY_GAMES_SCHEMA` is the one declaration of the values themselves. */
export type GameListSort = ResolvedMyGamesQuery['sort'];

/**
 * The rules the view assembly needs but must not restate: each is implemented
 * once, in the lifecycle module, next to the commands that enforce it, and
 * handed in here. A test of this module supplies its own (mirroring) rules.
 */
export interface GameViewsDeps {
  readonly seatOf: (game: GameRecord, player: Player) => number | null;
  readonly seatOfActor: (game: GameRecord, actorId: number) => 1 | 2 | null;
  readonly sidesOf: (game: GameRecord, actorId: number) => GameSide[];
  readonly isSelfPlay: (game: GameRecord) => boolean;
  readonly deletableBy: (game: GameRecord, actorId: number) => boolean;
  readonly joinableBy: (game: GameRecord, actor: SessionUser) => boolean;
}

/** Everything the game-screen view needs from the lifecycle module's reads. */
export interface GameViewContext {
  readonly actor: SessionUser;
  readonly game: GameRecord;
  /** The stored record, as the core loader wants it — needed for the scrubber's per-move TPS. */
  readonly record: StoredGame;
  /** The playable game the record loads to (ADR-0005's read path). */
  readonly tak: TakGame;
  /** Resolves user ids to display names once per request. */
  readonly nameOf: (id: number) => Result<PlayerRef, GameError>;
}

/** Everything one list row needs from the lifecycle module's reads. */
export interface GameSummaryContext {
  readonly actor: SessionUser;
  readonly game: GameRecord;
  readonly nameOf: (id: number) => Result<PlayerRef, GameError>;
  readonly lastMoveAt: ReadonlyMap<number, string>;
  readonly follows: ReadonlySet<number>;
  /** The next mover as a core seat (1 or 2), pre-resolved by the lifecycle module; null while not in play. */
  readonly toMovePlayer: Player | null;
}

export interface GameViews {
  gameView(context: GameViewContext): Result<GameView, GameError>;
  summarise(context: GameSummaryContext): Result<GameSummary, GameError>;
  sortSummaries(
    summaries: readonly GameSummary[],
    sort: GameListSort,
    direction: 'asc' | 'desc',
  ): GameSummary[];
}

/** A core loader fault, named for the caller: the core reports what is wrong
 * with the record, the Game module says which game it belongs to. `corrupt-record`
 * is stored data gone bad, not a failed query — it is answered 500 all the
 * same. It is the loader's only possible fault (ADR-0005) — `loadGame` and
 * `positionsOf` alike — now that `positionsOf` has no move-number bounds of
 * its own to fail on; the export range-checks `throughMove` before asking. */
export function recordError(gameId: number, error: CoreGameError): GameError {
  return { code: 'corrupt-record', message: `game ${gameId}: ${error.message}` };
}

const FILES = ['a', 'b', 'c', 'd', 'e', 'f'] as const;

/** The board as display rows (top-down), each square carrying its stack. */
function buildBoard(state: GameState): readonly (readonly BoardSquareView[])[] {
  const rows: BoardSquareView[][] = [];
  for (let rank = state.size; rank >= 1; rank--) {
    const row: BoardSquareView[] = [];
    for (let fi = 0; fi < state.size; fi++) {
      const file = FILES[fi]!;
      const stack = state.board.grid[fi]?.[rank - 1] ?? [];
      row.push({ file, rank, stack: stack.map((s) => ({ player: s.player, kind: s.kind })) });
    }
    rows.push(row);
  }
  return rows;
}

/** The human-readable result, or null while in play. */
function resultTextOf(result: string | null, p1: PlayerRef | null, p2: PlayerRef | null): string | null {
  switch (result) {
    case 'R-0':
      return `Road win for ${p1?.displayName ?? 'player 1'}`;
    case '0-R':
      return p2 ? `Road win for ${p2.displayName}` : 'Road win for player 2';
    case 'F-0':
      return `Flat win for ${p1?.displayName ?? 'player 1'}`;
    case '0-F':
      return p2 ? `Flat win for ${p2.displayName}` : 'Flat win for player 2';
    case '1-0':
      return `${p1?.displayName ?? 'Player 1'} wins by resignation`;
    case '0-1':
      return p2 ? `${p2.displayName} wins by resignation` : 'Player 2 wins by resignation';
    case '1/2-1/2':
      return 'Draw by agreement';
    default:
      return null;
  }
}

export function createGameViews(deps: GameViewsDeps): GameViews {
  /** The full view of one game: the record, the playable game, and the names, all fed in. */
  function gameView(context: GameViewContext): Result<GameView, GameError> {
    const { actor, game, record, tak, nameOf } = context;
    // Ticket 13: an admin may view any game regardless of share state.
    const isAdmin = actor.role === 'admin';

    const proposer = nameOf(game.proposerId);
    if (proposer.isErr()) return err(proposer.error);
    const opponent = game.opponentId === null ? ok(null) : nameOf(game.opponentId);
    if (opponent.isErr()) return err(opponent.error);

    const viewerSeat = deps.seatOfActor(game, actor.id);
    const selfPlay = deps.isSelfPlay(game);
    const toMoveSeat: 1 | 2 | null = game.state === 'in_play' ? tak.state.playerToMove : null;
    // Seat 1 (filled) and seat 2 (open) resolve through the proposer's seat,
    // which the starter choice sets — the proposer need not be seat 1.
    const seat1Ref = deps.seatOf(game, 1) === game.proposerId ? proposer.value : opponent.value;
    const seat2Ref = deps.seatOf(game, 2) === game.proposerId ? proposer.value : opponent.value;
    const toMove = toMoveSeat === null ? null : toMoveSeat === 1 ? seat1Ref : seat2Ref;
    // CONTEXT.md's Place rule, stated once: a player's opening turn places one
    // of their opponent's stones, every turn after it places their own. Both
    // facts are positional — they never consult the viewer.
    const isOpeningTurn = toMoveSeat !== null && !tak.state.opened[toMoveSeat];
    const stoneSeat: 1 | 2 | null =
      toMoveSeat === null ? null : isOpeningTurn ? (toMoveSeat === 1 ? 2 : 1) : toMoveSeat;

    // The single pending request/offer, resolved to a name for the board.
    let pending: PendingRequestView | null = null;
    if (game.pendingKind !== null && game.pendingBy !== null) {
      const requester = nameOf(game.pendingBy);
      if (requester.isErr()) return err(requester.error);
      pending = { kind: game.pendingKind, requester: requester.value };
    }
    const requesterSeat = game.pendingBy === null ? null : deps.seatOfActor(game, game.pendingBy);
    const inPlay = game.state === 'in_play';
    const participant = viewerSeat !== null;
    const noPending = pending === null;
    // The last live move's seat, or null when the history ends in imported moves.
    const lastLiveSeat: 1 | 2 | null =
      tak.history.length > tak.fixedMoves ? ((tak.history.length - 1) % 2 === 0 ? 1 : 2) : null;

    // The scrubber renders straight from this: the position after every move,
    // read the same way `export`'s TPS does — one core call for the whole
    // record, not one per move (core computes the imported prefix once).
    const positions = positionsOf(record).mapErr((error) => recordError(game.id, error));
    if (positions.isErr()) return err(positions.error);

    const moves: MoveView[] = [];
    for (let i = 0; i < tak.history.length; i++) {
      const rec = tak.history[i]!;
      const seat: 1 | 2 = i % 2 === 0 ? 1 : 2;
      const ref = seat === 1 ? seat1Ref : seat2Ref;
      if (ref === null) continue; // moves exist only after a join, so the joiner is known
      moves.push({
        number: i + 1,
        seat,
        player: ref,
        notation: formatMove(rec.move),
        imported: i < tak.fixedMoves,
        tps: positions.value[i + 1]!,
      });
    }

    // Ticket 13: the viewer's own share/hide standing, and an admin's removal power.
    const sides = deps.sidesOf(game, actor.id);
    const viewerShared =
      sides.length === 0 ? null : sides.includes('proposer') ? game.proposerShared : game.opponentShared;

    return ok({
      id: game.id,
      boardSize: game.boardSize,
      state: game.state,
      joinType: game.joinType,
      proposer: proposer.value,
      opponent: opponent.value,
      imported: game.importedPtn !== null,
      viewerSeat,
      selfPlay,
      proposerSeat: game.proposerSeat,
      moves,
      board: buildBoard(tak.state),
      toMove,
      toMoveSeat,
      canMove: inPlay && participant && noPending && (selfPlay || viewerSeat === toMoveSeat),
      pending,
      canRespond: pending !== null && participant && requesterSeat !== null && requesterSeat !== viewerSeat,
      canResign: inPlay && participant && !selfPlay,
      canOfferDraw: inPlay && participant && !selfPlay && noPending,
      canOfferTakeBack: inPlay && participant && !selfPlay && noPending && lastLiveSeat === viewerSeat,
      resultText: resultTextOf(game.result, seat1Ref, seat2Ref),
      reserves: tak.state.reserves,
      isOpeningTurn,
      stoneSeat,
      viewerShared,
      canHide: sides.length > 0,
      canAdminDelete: isAdmin && !game.adminRemoved,
      adminRemoved: game.adminRemoved,
    });
  }

  /** One row of a games list, with every rule already decided. */
  function summarise(context: GameSummaryContext): Result<GameSummary, GameError> {
    const { actor, game, nameOf, lastMoveAt, follows, toMovePlayer } = context;

    const proposer = nameOf(game.proposerId);
    if (proposer.isErr()) return err(proposer.error);

    const resolveOptional = (id: number | null): Result<PlayerRef | null, GameError> =>
      id === null ? ok(null) : nameOf(id);

    const opponent = resolveOptional(game.opponentId);
    if (opponent.isErr()) return err(opponent.error);
    const invitedPlayer = resolveOptional(game.invitedPlayerId);
    if (invitedPlayer.isErr()) return err(invitedPlayer.error);

    // The next mover was pre-resolved by the lifecycle module (from the batched
    // positions read, or the per-record fallback); here it becomes a name.
    let toMove: PlayerRef | null = null;
    if (toMovePlayer !== null) {
      const seat = deps.seatOf(game, toMovePlayer);
      if (seat !== null) {
        const resolved = nameOf(seat);
        if (resolved.isErr()) return err(resolved.error);
        toMove = resolved.value;
      }
    }

    const other =
      opponent.value === null
        ? null
        : opponent.value.id === actor.id
          ? proposer.value
          : opponent.value;

    return ok({
      id: game.id,
      boardSize: game.boardSize,
      state: game.state,
      joinType: game.joinType,
      proposer: proposer.value,
      opponent: opponent.value,
      invitedPlayer: invitedPlayer.value,
      otherPlayer: other,
      imported: game.importedPtn !== null,
      createdAt: game.createdAt,
      canDelete: deps.deletableBy(game, actor.id),
      canJoin: deps.joinableBy(game, actor),
      canSolo: game.proposerId === actor.id && deps.joinableBy(game, actor),
      adminRemoved: game.adminRemoved,
      toMove,
      result: game.result,
      proposerSeat: game.proposerSeat,
      lastActivity: lastMoveAt.get(game.id) ?? game.createdAt,
      followed: follows.has(game.proposerId),
      canFollow: game.proposerId !== actor.id,
      canHide: deps.sidesOf(game, actor.id).length > 0,
    });
  }

  /** `listMyGames`'s sort keys (ticket 03), each with a stable id-descending tiebreak. */
  function sortSummaries(
    summaries: readonly GameSummary[],
    sort: GameListSort,
    direction: 'asc' | 'desc',
  ): GameSummary[] {
    const key = (g: GameSummary): string | number => {
      switch (sort) {
        case 'activity':
          return g.lastActivity;
        case 'created':
          return g.createdAt;
        case 'size':
          return g.boardSize;
      }
    };
    const factor = direction === 'asc' ? 1 : -1;
    return [...summaries].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      if (ka < kb) return -factor;
      if (ka > kb) return factor;
      return b.id - a.id;
    });
  }

  return { gameView, summarise, sortSummaries };
}
