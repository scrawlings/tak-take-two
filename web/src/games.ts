import { err, ok, type Result } from 'neverthrow';
import {
  formatMove,
  fromPtnText,
  generatePtn,
  generateTps,
  isBoardFinished,
  isFinished,
  isResultCode,
  loadGame,
  parseMove,
  playMove as corePlayMove,
  resign as coreResign,
  resultCode,
  stateAfter,
} from '@tak/core';
import type {
  GameError as CoreGameError,
  GameState,
  Player,
  ResultCode,
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
  Persistence,
  ProposedGameFilters,
  UserRecord,
} from './persistence.js';
import type { SessionUser } from './auth.js';
import {
  FIND_GAMES_SCHEMA,
  MY_GAMES_SCHEMA,
  resolveQuery,
  type FindGamesSearch,
  type MyGamesQuery as ResolvedMyGamesQuery,
} from './list-query.js';

/**
 * The web Game module — the game lifecycle behind one command union (ADR-0004).
 * Routes authenticate (session → user) and render; `applyGame` owns every
 * lifecycle invariant: who may propose, what a legal proposal is, PTN import
 * validation, delete-only-while-unjoined, and the activity-trail events. It
 * never touches SQL — persistence grows the accessors — and it never re-implements
 * Tak rules, which stay in the headless core (ADR-0001).
 *
 * ADR-0004 first sketched `applyGame(gameId, actorId, command)`; ticket 09 built
 * the module and settled it as `applyGame(actor, command)`, because `propose`
 * has no game to address yet. The ADR records the amendment.
 */

/** Every lifecycle state a player's own list can show — the default, unfiltered view (ticket 03). */
const ALL_LIST_STATES: readonly GameLifecycleState[] = ['proposed', 'in_play', 'finished'];

/** What "Your games" may be sorted by (ticket 03) — `list-query.ts`'s `MY_GAMES_SCHEMA` is the one declaration of the values themselves. */
type GameListSort = ResolvedMyGamesQuery['sort'];

export type GameErrorCode =
  | 'forbidden'
  | 'not-found'
  | 'invalid-board-size'
  | 'invalid-join-type'
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
  | 'invalid-status'
  | 'invalid-sort'
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
   * (ticket 03) — derived here, in `summarise`, from `game_records` at read
   * time, so it can never drift the way a stored column could.
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
  /** Whether each seat has made its opening (first) move. */
  readonly opened: Readonly<Record<1 | 2, boolean>>;
  /** The viewer's own share toggle, or null when they are not a participant. */
  readonly viewerShared: boolean | null;
  /** The viewer is a participant and may hide this game from their own views. */
  readonly canHide: boolean;
  /** The viewer is an admin and this game is not already admin-removed. */
  readonly canAdminDelete: boolean;
  /** Ticket 13: this game was ended by an admin, not by play or agreement. */
  readonly adminRemoved: boolean;
}

/**
 * What a player may narrow a proposal search by, and how a player may narrow
 * and order their own games list (ticket 03). Each is `list-query.ts`'s
 * validated, resolved shape (`MyGamesQuery`/`FindGamesSearch`, re-exported
 * here as `ProposedSearch` under this module's own established name) — every
 * field already checked against its schema, so this module only ever sees a
 * value it can trust. `Partial` because a caller (a test, most often) may
 * still supply only the fields it cares about; the rest fall back to
 * `MY_GAMES_DEFAULT`/`FIND_GAMES_DEFAULT` below.
 */
export type ProposedSearch = Partial<FindGamesSearch>;
export type MyGamesQuery = Partial<ResolvedMyGamesQuery>;

/** One command per game mutation. The actor is passed to `applyGame`, not embedded here. */
export type GameCommand =
  | {
      readonly type: 'propose';
      /** Ignored when `ptn` is given: an imported record carries its own `[Size]`. */
      readonly boardSize: number;
      readonly joinType: string;
      /** Required for an invited proposal; the display name of the player to invite. */
      readonly invitedDisplayName?: string;
      /** Who starts (seat 1): `me`, `opponent`, or `random`. Defaults to `me`. */
      readonly starter?: string;
      /** A PTN record to import as fixed history. Blank or absent proposes an empty board. */
      readonly ptn?: string;
    }
  | { readonly type: 'deleteProposal'; readonly gameId: number }
  | { readonly type: 'join'; readonly gameId: number }
  | { readonly type: 'playMove'; readonly gameId: number; readonly move: string }
  | { readonly type: 'resign'; readonly gameId: number }
  | { readonly type: 'requestTakeBack'; readonly gameId: number }
  | { readonly type: 'acceptTakeBack'; readonly gameId: number }
  | { readonly type: 'rejectTakeBack'; readonly gameId: number }
  | { readonly type: 'offerDraw'; readonly gameId: number }
  | { readonly type: 'acceptDraw'; readonly gameId: number }
  | { readonly type: 'rejectDraw'; readonly gameId: number }
  | { readonly type: 'share'; readonly gameId: number; readonly on: boolean }
  | { readonly type: 'hide'; readonly gameId: number }
  | { readonly type: 'adminDelete'; readonly gameId: number }
  /** Ticket 04: curate the find page (CONTEXT.md: Follow) — no game to address, like `propose`. */
  | { readonly type: 'follow'; readonly userId: number }
  | { readonly type: 'unfollow'; readonly userId: number }
  | {
      readonly type: 'export';
      readonly gameId: number;
      /** `ptn` or `tps`; parsed here so routes stay dumb adapters. */
      readonly format: string;
      /**
       * 1-based index into the full history (as `MoveView.number` numbers it):
       * PTN up to and including it, or the TPS of the position after it. `0` is
       * the starting position; absent means the whole game.
       */
      readonly throughMove?: number;
    };

/** What a game record may be copied out as (CONTEXT.md: Game record). */
export type ExportFormat = 'ptn' | 'tps';

/** One domain-shaped result per command; commands that only change state yield `{ type: 'ok' }`. */
export type GameCommandResult =
  | { readonly type: 'ok' }
  | { readonly type: 'propose'; readonly gameId: number }
  | { readonly type: 'join'; readonly gameId: number }
  | {
      readonly type: 'export';
      readonly format: ExportFormat;
      readonly text: string;
      /** The move it runs through, and the history it was taken from. */
      readonly throughMove: number;
      readonly totalMoves: number;
    };

/** One generated record, as `applyGame` returns it and the export page renders it. */
export type GameExport = Extract<GameCommandResult, { type: 'export' }>;

export interface Games {
  /** Run one game command. Commands authorise themselves. */
  applyGame(actor: SessionUser, command: GameCommand): Result<GameCommandResult, GameError>;
  /** The full view of one game, for the game screen. */
  getGame(actor: SessionUser, gameId: number): Result<GameView, GameError>;
  /**
   * The actor's own games, filtered and sorted per `query` (ticket 03);
   * defaults to every state, most recent activity first, and admin-removed
   * tombstones hidden unless `query.showRemoved` (ticket 06).
   */
  listMyGames(actor: SessionUser, query?: MyGamesQuery): Result<GameSummary[], GameError>;
  /** Proposals the actor could join: open ones, plus invitations to them. */
  searchProposed(actor: SessionUser, search?: ProposedSearch): Result<GameSummary[], GameError>;
  /** Every game on the site, newest first — admin only (ticket 13). */
  listAllGames(actor: SessionUser): Result<GameSummary[], GameError>;
}

function persistenceError(message: string): GameError {
  return { code: 'persistence', message };
}

/**
 * Only players play. An admin is never a player (CONTEXT.md); a person who is
 * both holds two accounts.
 */
function requirePlayer(actor: SessionUser): Result<void, GameError> {
  if (actor.role !== 'player') {
    return err({ code: 'forbidden', message: 'Admin accounts cannot propose or play games.' });
  }
  return ok(undefined);
}

/**
 * The one statement of the delete rule: the proposer may withdraw a proposal
 * until someone joins it. `deleteProposal` enforces it and `canDelete` reports
 * it, so the list and the command can never disagree.
 */
function deletableBy(game: GameRecord, actorId: number): boolean {
  return game.state === 'proposed' && game.opponentId === null && game.proposerId === actorId;
}

/** Whether a proposal is still open to be claimed at all, by anyone. */
function isUnjoinedProposal(game: GameRecord): boolean {
  return game.state === 'proposed' && game.opponentId === null;
}

/**
 * The one statement of the join rule: an unjoined proposal may be claimed by
 * anyone if it is open, and only by the designated player if it is invited.
 * A player may claim their own proposal — the design allows self-play for study.
 * `join` enforces it and `canJoin` reports it, so the two cannot disagree.
 */
function joinableBy(game: GameRecord, actor: SessionUser): boolean {
  if (actor.role !== 'player' || !isUnjoinedProposal(game)) return false;
  return game.joinType === 'open' || game.invitedPlayerId === actor.id;
}

/** The two ends of a game, plus the player an unjoined proposal designates. */
function isParticipant(game: GameRecord, actorId: number): boolean {
  return (
    game.proposerId === actorId ||
    game.opponentId === actorId ||
    game.invitedPlayerId === actorId
  );
}

/**
 * Which side(s) of the game `actorId` occupies — proposer, opponent, or (for
 * self-play) both. An invited player who has not yet joined occupies the
 * opponent side pre-emptively, so they may set its share/hide before joining.
 * Ticket 13: share and hide act per side, and this is the one place that
 * decides which side an actor's command reaches.
 */
function sidesOf(game: GameRecord, actorId: number): GameSide[] {
  const sides: GameSide[] = [];
  if (game.proposerId === actorId) sides.push('proposer');
  if (game.opponentId === actorId) sides.push('opponent');
  else if (game.opponentId === null && game.invitedPlayerId === actorId) sides.push('opponent');
  return sides;
}

/**
 * Whether `actor` may see a game. ADR-0003 to the letter: participants always
 * see their own game, and everyone else sees it iff both share toggles are on.
 *
 * This reads the toggles rather than re-deriving visibility from `joinType`.
 * The two agree today — proposing an open game turns both toggles on — but only
 * the toggles stay right once ticket 13 lets a player change them.
 */
function visibleTo(game: GameRecord, actorId: number): boolean {
  return isParticipant(game, actorId) || (game.proposerShared && game.opponentShared);
}

/** The proposer is always Player 1 and the joiner Player 2 (CONTEXT.md: Seat). */
function seatOf(game: GameRecord, player: Player): number | null {
  const proposerSeat = game.proposerSeat;
  if (proposerSeat === null) return null; // random, unresolved — still proposed
  if (player === 1) return proposerSeat === 1 ? game.proposerId : game.opponentId;
  return proposerSeat === 1 ? game.opponentId : game.proposerId;
}

/** Whether one account holds both seats — the proposer joined their own proposal (CONTEXT.md: Self-play). */
function isSelfPlay(game: GameRecord): boolean {
  return game.proposerId === game.opponentId;
}

function parseBoardSize(value: number): Result<GameBoardSize, GameError> {
  if (value === 5 || value === 6) return ok(value);
  return err({ code: 'invalid-board-size', message: 'Board size must be 5 or 6.' });
}

function parseJoinType(value: string): Result<JoinType, GameError> {
  if (value === 'open' || value === 'invited') return ok(value);
  return err({ code: 'invalid-join-type', message: 'Choose an open or an invited game.' });
}

/**
 * The proposer's seat choice: `me` → 1, `opponent` → 2, `random` → null (a
 * coin flip when the joiner claims the game). The result is the proposer's
 * core seat, the one fact every other seat mapping derives from.
 */
function parseStarter(value: string | undefined): Result<1 | 2 | null, GameError> {
  switch (value ?? 'me') {
    case 'me':
      return ok(1);
    case 'opponent':
      return ok(2);
    case 'random':
      return ok(null);
    default:
      return err({ code: 'invalid-starter', message: 'Choose who starts: you, the other player, or at random.' });
  }
}

function parseExportFormat(value: string): Result<ExportFormat, GameError> {
  if (value === 'ptn' || value === 'tps') return ok(value);
  return err({ code: 'invalid-export-format', message: 'Choose PTN or TPS.' });
}

/**
 * The stored result as a core `ResultCode`. What counts as one is core's to
 * say (ADR-0001), so this only guards the null column; anything unrecognised
 * exports as no result rather than failing the export over it.
 */
function asResultCode(value: string | null): ResultCode | undefined {
  return value !== null && isResultCode(value) ? value : undefined;
}

export function createGames(persistence: Persistence): Games {
  /** Resolve user ids to display names once per list, not once per row. */
  function nameResolver(): (id: number) => Result<PlayerRef, GameError> {
    const seen = new Map<number, PlayerRef>();
    return (id: number) => {
      const cached = seen.get(id);
      if (cached) return ok(cached);
      const found = persistence.findUserById(id);
      if (found.isErr()) return err(persistenceError(found.error));
      // A deleted account leaves the id behind; name it rather than fail the list.
      const ref: PlayerRef = { id, displayName: found.value?.displayName ?? 'a departed player' };
      seen.set(id, ref);
      return ok(ref);
    };
  }

  /** The invited player for an invited proposal, or null for an open one. */
  function resolveInvite(
    joinType: JoinType,
    displayName: string | undefined,
  ): Result<UserRecord | null, GameError> {
    if (joinType === 'open') return ok(null);

    const name = displayName?.trim() ?? '';
    if (name === '') {
      return err({ code: 'invalid-invite', message: 'Name the player you want to invite.' });
    }

    const found = persistence.findUserByDisplayName(name);
    if (found.isErr()) return err(persistenceError(found.error));
    if (found.value === null) {
      return err({ code: 'invalid-invite', message: `No player is called "${name}".` });
    }
    if (found.value.role !== 'player') {
      return err({ code: 'invalid-invite', message: `${name} is an admin account and cannot play.` });
    }
    if (found.value.blocked) {
      return err({ code: 'invalid-invite', message: `${name}'s account is blocked.` });
    }
    return ok(found.value);
  }

  /**
   * Validate a PTN record by full replay in the core, returning the text to
   * store and the board size it fixes. Blank text means "no import".
   */
  function validateImport(
    ptn: string | undefined,
  ): Result<{ text: string; boardSize: GameBoardSize } | null, GameError> {
    const text = ptn?.trim() ?? '';
    if (text === '') return ok(null);

    const loaded = fromPtnText(text);
    if (loaded.isErr()) {
      return err({ code: 'invalid-ptn', message: `That record is not a legal game: ${loaded.error.message}` });
    }
    // The *position* bars import, not the record's result tag: a resignation
    // or agreed draw still leaves the position playable.
    if (isBoardFinished(loaded.value)) {
      return err({
        code: 'invalid-ptn',
        message: 'That record ends in a won position, so there is nothing left to play.',
      });
    }
    return ok({ text, boardSize: loaded.value.state.size });
  }

  function propose(
    actor: SessionUser,
    command: Extract<GameCommand, { type: 'propose' }>,
  ): Result<GameCommandResult, GameError> {
    const player = requirePlayer(actor);
    if (player.isErr()) return err(player.error);

    const joinType = parseJoinType(command.joinType);
    if (joinType.isErr()) return err(joinType.error);

    const proposerSeat = parseStarter(command.starter);
    if (proposerSeat.isErr()) return err(proposerSeat.error);

    const imported = validateImport(command.ptn);
    if (imported.isErr()) return err(imported.error);

    // An imported record fixes its own board size; only a from-scratch game
    // takes the size from the form.
    let boardSize: GameBoardSize;
    if (imported.value !== null) {
      boardSize = imported.value.boardSize;
    } else {
      const parsed = parseBoardSize(command.boardSize);
      if (parsed.isErr()) return err(parsed.error);
      boardSize = parsed.value;
    }

    const invited = resolveInvite(joinType.value, command.invitedDisplayName);
    if (invited.isErr()) return err(invited.error);

    const created = persistence.transaction((): Result<GameRecord, string> => {
      const inserted = persistence.createGame({
        boardSize,
        joinType: joinType.value,
        proposerId: actor.id,
        invitedPlayerId: invited.value?.id ?? null,
        importedPtn: imported.value?.text ?? null,
        proposerSeat: proposerSeat.value,
        // ADR-0003: an open game starts shared, because joining one implies
        // sharing; an invited game starts private to its two players.
        proposerShared: joinType.value === 'open',
        opponentShared: joinType.value === 'open',
      });
      if (inserted.isErr()) return inserted;
      const trail = persistence.appendActivityTrail({
        userId: actor.id,
        gameId: inserted.value.id,
        event: 'game-proposed',
        payload: {
          boardSize,
          joinType: joinType.value,
          invited: invited.value?.displayName ?? null,
          imported: imported.value !== null,
          proposerSeat: proposerSeat.value,
        },
      });
      if (trail.isErr()) return err(trail.error);
      return inserted;
    });
    if (created.isErr()) return err(persistenceError(created.error));

    return ok({ type: 'propose', gameId: created.value.id });
  }

  function deleteProposal(actor: SessionUser, gameId: number): Result<GameCommandResult, GameError> {
    const found = persistence.findGameById(gameId);
    if (found.isErr()) return err(persistenceError(found.error));
    if (found.value === null) return err({ code: 'not-found', message: 'That game no longer exists.' });

    // `deletableBy` makes the decision; the cascade below only says why it
    // refused, so the rule cannot drift from the one the list reports.
    const game = found.value;
    if (!deletableBy(game, actor.id)) {
      if (game.proposerId !== actor.id) {
        return err({ code: 'forbidden', message: 'Only the player who proposed a game can delete it.' });
      }
      if (game.state !== 'proposed') {
        return err({ code: 'not-proposed', message: 'This game has already started, so it cannot be deleted.' });
      }
      return err({ code: 'already-joined', message: 'Someone has joined this game, so it cannot be deleted.' });
    }

    const deleted = persistence.transaction((): Result<void, string> => {
      // activity_trail.game_id is ON DELETE SET NULL, so deleting the game
      // erases the column this entry is about. The trail is append-only
      // evidence, so the id goes in the payload too, where nothing clears it.
      const trail = persistence.appendActivityTrail({
        userId: actor.id,
        gameId: game.id,
        event: 'game-proposal-deleted',
        payload: { gameId: game.id, boardSize: game.boardSize, joinType: game.joinType },
      });
      if (trail.isErr()) return trail;
      return persistence.deleteGame(game.id);
    });
    if (deleted.isErr()) return err(persistenceError(deleted.error));

    return ok({ type: 'ok' });
  }

  function join(actor: SessionUser, gameId: number): Result<GameCommandResult, GameError> {
    const player = requirePlayer(actor);
    if (player.isErr()) return err(player.error);

    const found = persistence.findGameById(gameId);
    if (found.isErr()) return err(persistenceError(found.error));
    // An invited proposal the actor may not see must not be distinguishable
    // from one that does not exist, or the search filter would leak through it.
    if (found.value === null || !visibleTo(found.value, actor.id)) {
      return err({ code: 'not-found', message: 'That game no longer exists.' });
    }

    // `joinableBy` makes the decision; the cascade only says why it refused.
    const game = found.value;
    if (!joinableBy(game, actor)) {
      if (game.state !== 'proposed') {
        return err({ code: 'not-proposed', message: 'This game has already started.' });
      }
      if (game.opponentId !== null) {
        return err({ code: 'already-joined', message: 'Someone else joined this game first.' });
      }
      return err({ code: 'not-invited', message: 'This game is for the player it names.' });
    }

    const joined = persistence.transaction((): Result<boolean, string> => {
      // A random start resolves here, once, when the second player claims the
      // game; a seat the proposer already chose is left alone by COALESCE.
      const proposerSeat: 1 | 2 = game.proposerSeat ?? (Math.random() < 0.5 ? 1 : 2);
      const claimed = persistence.joinGame(game.id, actor.id, proposerSeat);
      if (claimed.isErr()) return claimed;
      // The conditional UPDATE is the real guard: if it changed nothing, the
      // game stopped being an unjoined proposal, so write no trail event.
      if (!claimed.value) return ok(false);
      const trail = persistence.appendActivityTrail({
        userId: actor.id,
        gameId: game.id,
        event: 'game-joined',
        payload: { proposer: game.proposerId, joinType: game.joinType, proposerSeat },
      });
      if (trail.isErr()) return err(trail.error);
      return ok(true);
    });
    if (joined.isErr()) return err(persistenceError(joined.error));
    if (!joined.value) {
      return err({ code: 'already-joined', message: 'Someone else joined this game first.' });
    }

    return ok({ type: 'join', gameId: game.id });
  }

  /** The seat (1/2) an actor holds in a game, or null when not a participant. */
  function seatOfActor(game: GameRecord, actorId: number): 1 | 2 | null {
    const proposerSeat = game.proposerSeat;
    if (proposerSeat === null) return null; // random, unresolved — still proposed
    if (game.proposerId === actorId) return proposerSeat;
    if (game.opponentId === actorId) return proposerSeat === 1 ? 2 : 1;
    return null;
  }

  /**
   * The stored game as the core loader wants it: the record's own columns plus
   * the move rows, unchanged. Reading the rows is this module's job; folding
   * them into a playable game is the core's (ADR-0005).
   */
  function storedGame(game: GameRecord): Result<StoredGame, GameError> {
    const rows = persistence.listMoves(game.id);
    if (rows.isErr()) return err(persistenceError(rows.error));
    return ok({
      size: game.boardSize,
      importedPtn: game.importedPtn,
      result: game.result,
      moves: rows.value.map((row) => ({
        notation: row.notation,
        playedAt: Date.parse(row.playedAt),
        position: row.position,
      })),
    });
  }

  /**
   * A core loader fault, named for the caller: the core reports what is wrong
   * with the record, this module says which game it belongs to. `corrupt-record`
   * is stored data gone bad, not a failed query — it is answered 500 all the
   * same. The loader's only other fault is a move number outside the record,
   * which the export range-checks before asking, so it should not arrive.
   */
  function recordError(gameId: number, error: CoreGameError): GameError {
    if (error.code !== 'corrupt-record') return { code: 'invalid-move-number', message: error.message };
    return { code: 'corrupt-record', message: `game ${gameId}: ${error.message}` };
  }

  /**
   * The playable game a record has reached — the one load path every command
   * and view uses. The core materializes it from the stored rows, reading the
   * last move's position snapshot rather than replaying the game (ADR-0005).
   */
  function loadTakGame(game: GameRecord): Result<TakGame, GameError> {
    return storedGame(game).andThen((record) =>
      loadGame(record).mapErr((error) => recordError(game.id, error)),
    );
  }

  /**
   * The stored record alongside the playable game it loads to. `export` and
   * the scrubber's per-move TPS both need the record itself (for `stateAfter`)
   * as well as what `loadTakGame` gives them, so this reads the rows once and
   * hands back both rather than each re-deriving `tak` from a `record` it
   * already has.
   */
  function loadStoredGame(game: GameRecord): Result<{ record: StoredGame; tak: TakGame }, GameError> {
    const record = storedGame(game);
    if (record.isErr()) return err(record.error);
    const tak = loadGame(record.value).mapErr((error) => recordError(game.id, error));
    if (tak.isErr()) return err(tak.error);
    return ok({ record: record.value, tak: tak.value });
  }

  /**
   * The atomic finish: mark the game finished with its result code, write the
   * derived game stats, and record the `game-finished` trail event.
   */
  function finishGameTransaction(
    actor: SessionUser,
    game: GameRecord,
    played: TakGame,
    result: string,
    how: string,
  ): Result<void, string> {
    const finished = persistence.clearPendingRequest(game.id);
    if (finished.isErr()) return finished;
    const marked = persistence.finishGame(game.id, result);
    if (marked.isErr()) return marked;
    const durationSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(game.createdAt)) / 1000));
    const stats = persistence.writeGameStats({
      gameId: game.id,
      boardSize: game.boardSize,
      moveCount: played.history.length,
      durationSeconds,
      result,
    });
    if (stats.isErr()) return stats;
    return persistence.appendActivityTrail({
      userId: actor.id,
      gameId: game.id,
      event: 'game-finished',
      payload: { result, how },
    });
  }

  function playMove(
    actor: SessionUser,
    command: Extract<GameCommand, { type: 'playMove' }>,
  ): Result<GameCommandResult, GameError> {
    const player = requirePlayer(actor);
    if (player.isErr()) return err(player.error);

    const found = persistence.findGameById(command.gameId);
    if (found.isErr()) return err(persistenceError(found.error));
    if (found.value === null) return err({ code: 'not-found', message: 'That game no longer exists.' });
    const game = found.value;

    if (!visibleTo(game, actor.id)) {
      return err({ code: 'not-found', message: 'That game no longer exists.' });
    }
    if (!isParticipant(game, actor.id)) {
      return err({ code: 'forbidden', message: 'Only the two players may move in a game.' });
    }
    if (game.state !== 'in_play') {
      return err({ code: 'not-in-play', message: 'This game is not being played right now.' });
    }
    if (game.pendingKind !== null) {
      const what = game.pendingKind === 'draw' ? 'A draw offer' : 'A take-back request';
      return err({ code: 'request-pending', message: `${what} is pending; accept or reject it first.` });
    }

    const current = loadTakGame(game);
    if (current.isErr()) return err(current.error);
    if (seatOf(game, current.value.state.playerToMove) !== actor.id) {
      return err({ code: 'not-your-turn', message: 'It is not your turn.' });
    }

    const parsed = parseMove(command.move);
    if (parsed.isErr()) {
      return err({ code: 'invalid-move', message: `That is not a legal move: ${parsed.error.message}` });
    }
    const played = corePlayMove(current.value, parsed.value);
    if (played.isErr()) {
      return err({ code: 'invalid-move', message: `That move is illegal: ${played.error.message}` });
    }

    const notation = formatMove(parsed.value);
    const moveNumber = played.value.history.length;
    const finishedResult = isFinished(played.value) ? resultCode(played.value) : null;

    const persisted = persistence.transaction((): Result<void, string> => {
      const appended = persistence.appendMove({
        gameId: game.id,
        moveNumber,
        playerId: actor.id,
        notation,
        position: generateTps(played.value.state),
      });
      if (appended.isErr()) return err(appended.error);
      const trail = persistence.appendActivityTrail({
        userId: actor.id,
        gameId: game.id,
        event: 'move-played',
        payload: { moveNumber, notation, result: finishedResult },
      });
      if (trail.isErr()) return trail;
      if (finishedResult !== null) {
        // Only a move can finish the board, so a non-null result here is a road or flat win.
        const how = played.value.result?.kind === 'board' ? played.value.result.outcome.type : 'board';
        const fin = finishGameTransaction(actor, game, played.value, finishedResult, how);
        if (fin.isErr()) return fin;
      }
      return ok(undefined);
    });
    if (persisted.isErr()) return err(persistenceError(persisted.error));

    return ok({ type: 'ok' });
  }

  function resign(
    actor: SessionUser,
    command: Extract<GameCommand, { type: 'resign' }>,
  ): Result<GameCommandResult, GameError> {
    const player = requirePlayer(actor);
    if (player.isErr()) return err(player.error);

    const found = persistence.findGameById(command.gameId);
    if (found.isErr()) return err(persistenceError(found.error));
    if (found.value === null) return err({ code: 'not-found', message: 'That game no longer exists.' });
    const game = found.value;

    if (!visibleTo(game, actor.id)) {
      return err({ code: 'not-found', message: 'That game no longer exists.' });
    }
    if (!isParticipant(game, actor.id)) {
      return err({ code: 'forbidden', message: 'Only the two players may end a game.' });
    }
    if (game.state !== 'in_play') {
      return err({ code: 'not-in-play', message: 'This game is not being played right now.' });
    }
    if (isSelfPlay(game)) {
      return err({ code: 'forbidden', message: 'You cannot resign against yourself.' });
    }

    const current = loadTakGame(game);
    if (current.isErr()) return err(current.error);
    const seat = seatOfActor(game, actor.id);
    if (seat === null) {
      return err({ code: 'forbidden', message: 'Only the two players may end a game.' });
    }
    const done = coreResign(current.value, seat);
    if (done.isErr()) return err({ code: 'not-in-play', message: done.error.message });
    const result = resultCode(done.value)!;

    const persisted = persistence.transaction(() =>
      finishGameTransaction(actor, game, done.value, result, 'resign'),
    );
    if (persisted.isErr()) return err(persistenceError(persisted.error));

    return ok({ type: 'ok' });
  }

  /**
   * The shared preamble for the offer/respond commands: a player, a visible
   * in-play game they participate in, and not self-play. Returns the game.
   */
  function loadInPlayGame(
    actor: SessionUser,
    gameId: number,
    act: string,
    selfPlayMessage: string,
  ): Result<GameRecord, GameError> {
    const player = requirePlayer(actor);
    if (player.isErr()) return err(player.error);

    const found = persistence.findGameById(gameId);
    if (found.isErr()) return err(persistenceError(found.error));
    if (found.value === null) return err({ code: 'not-found', message: 'That game no longer exists.' });
    const game = found.value;

    if (!visibleTo(game, actor.id)) {
      return err({ code: 'not-found', message: 'That game no longer exists.' });
    }
    if (!isParticipant(game, actor.id)) {
      return err({ code: 'forbidden', message: `Only the two players may ${act}.` });
    }
    if (game.state !== 'in_play') {
      return err({ code: 'not-in-play', message: 'This game is not being played right now.' });
    }
    if (isSelfPlay(game)) {
      return err({ code: 'forbidden', message: selfPlayMessage });
    }
    return ok(game);
  }

  /**
   * The respondent check: the game carries a pending request of `kind`, and the
   * actor is the other player. Returns the requester's id.
   */
  function checkPending(
    game: GameRecord,
    kind: 'take-back' | 'draw',
    actor: SessionUser,
    what: string,
  ): Result<number, GameError> {
    if (game.pendingKind !== kind || game.pendingBy === null) {
      return err({ code: 'no-pending-request', message: `There is no pending ${what}.` });
    }
    if (game.pendingBy === actor.id) {
      return err({ code: 'forbidden', message: 'Only the other player can respond.' });
    }
    return ok(game.pendingBy);
  }

  function offerDraw(
    actor: SessionUser,
    command: Extract<GameCommand, { type: 'offerDraw' }>,
  ): Result<GameCommandResult, GameError> {
    const game = loadInPlayGame(actor, command.gameId, 'request a draw', 'You cannot draw against yourself.');
    if (game.isErr()) return err(game.error);
    if (game.value.pendingKind !== null) {
      return err({ code: 'request-pending', message: 'Only one request or offer may be pending.' });
    }

    const persisted = persistence.transaction((): Result<void, string> => {
      const set = persistence.setPendingRequest(game.value.id, 'draw', actor.id);
      if (set.isErr()) return set;
      return persistence.appendActivityTrail({ userId: actor.id, gameId: game.value.id, event: 'draw-offered' });
    });
    if (persisted.isErr()) return err(persistenceError(persisted.error));

    return ok({ type: 'ok' });
  }

  function acceptDraw(
    actor: SessionUser,
    command: Extract<GameCommand, { type: 'acceptDraw' }>,
  ): Result<GameCommandResult, GameError> {
    const game = loadInPlayGame(actor, command.gameId, 'respond to a draw offer', 'You cannot respond to yourself.');
    if (game.isErr()) return err(game.error);
    const requester = checkPending(game.value, 'draw', actor, 'draw offer');
    if (requester.isErr()) return err(requester.error);

    const current = loadTakGame(game.value);
    if (current.isErr()) return err(current.error);

    const persisted = persistence.transaction((): Result<void, string> => {
      const accepted = persistence.appendActivityTrail({
        userId: actor.id,
        gameId: game.value.id,
        event: 'draw-accepted',
        payload: { by: requester.value },
      });
      if (accepted.isErr()) return accepted;
      return finishGameTransaction(actor, game.value, current.value, '1/2-1/2', 'mutual-draw');
    });
    if (persisted.isErr()) return err(persistenceError(persisted.error));

    return ok({ type: 'ok' });
  }

  function rejectDraw(
    actor: SessionUser,
    command: Extract<GameCommand, { type: 'rejectDraw' }>,
  ): Result<GameCommandResult, GameError> {
    const game = loadInPlayGame(actor, command.gameId, 'respond to a draw offer', 'You cannot respond to yourself.');
    if (game.isErr()) return err(game.error);
    const requester = checkPending(game.value, 'draw', actor, 'draw offer');
    if (requester.isErr()) return err(requester.error);

    const persisted = persistence.transaction((): Result<void, string> => {
      const cleared = persistence.clearPendingRequest(game.value.id);
      if (cleared.isErr()) return cleared;
      return persistence.appendActivityTrail({
        userId: actor.id,
        gameId: game.value.id,
        event: 'draw-rejected',
        payload: { by: requester.value },
      });
    });
    if (persisted.isErr()) return err(persistenceError(persisted.error));

    return ok({ type: 'ok' });
  }

  function requestTakeBack(
    actor: SessionUser,
    command: Extract<GameCommand, { type: 'requestTakeBack' }>,
  ): Result<GameCommandResult, GameError> {
    const game = loadInPlayGame(
      actor,
      command.gameId,
      'request a take-back',
      'You cannot request a take-back against yourself.',
    );
    if (game.isErr()) return err(game.error);
    if (game.value.pendingKind !== null) {
      return err({ code: 'request-pending', message: 'Only one request or offer may be pending.' });
    }

    // A take-back needs a live move of yours, played since the opponent moved.
    const current = loadTakGame(game.value);
    if (current.isErr()) return err(current.error);
    const tak = current.value;
    if (tak.history.length <= tak.fixedMoves) {
      return err({ code: 'no-move-to-take-back', message: 'There is no move of yours to take back.' });
    }
    const lastSeat: 1 | 2 = (tak.history.length - 1) % 2 === 0 ? 1 : 2;
    if (seatOfActor(game.value, actor.id) !== lastSeat) {
      return err({
        code: 'no-move-to-take-back',
        message: 'Your opponent has already moved; there is nothing to take back.',
      });
    }

    const persisted = persistence.transaction((): Result<void, string> => {
      const set = persistence.setPendingRequest(game.value.id, 'take-back', actor.id);
      if (set.isErr()) return set;
      return persistence.appendActivityTrail({ userId: actor.id, gameId: game.value.id, event: 'take-back-requested' });
    });
    if (persisted.isErr()) return err(persistenceError(persisted.error));

    return ok({ type: 'ok' });
  }

  function acceptTakeBack(
    actor: SessionUser,
    command: Extract<GameCommand, { type: 'acceptTakeBack' }>,
  ): Result<GameCommandResult, GameError> {
    const game = loadInPlayGame(
      actor,
      command.gameId,
      'respond to a take-back request',
      'You cannot respond to yourself.',
    );
    if (game.isErr()) return err(game.error);
    const requester = checkPending(game.value, 'take-back', actor, 'take-back request');
    if (requester.isErr()) return err(requester.error);

    // The board cannot have changed since the request: moves are blocked while
    // pending, so the last recorded move is still the requester's.
    const persisted = persistence.transaction((): Result<void, string> => {
      const deleted = persistence.deleteLastMove(game.value.id);
      if (deleted.isErr()) return deleted;
      const cleared = persistence.clearPendingRequest(game.value.id);
      if (cleared.isErr()) return cleared;
      return persistence.appendActivityTrail({
        userId: actor.id,
        gameId: game.value.id,
        event: 'take-back-accepted',
        payload: { by: requester.value },
      });
    });
    if (persisted.isErr()) return err(persistenceError(persisted.error));

    return ok({ type: 'ok' });
  }

  function rejectTakeBack(
    actor: SessionUser,
    command: Extract<GameCommand, { type: 'rejectTakeBack' }>,
  ): Result<GameCommandResult, GameError> {
    const game = loadInPlayGame(
      actor,
      command.gameId,
      'respond to a take-back request',
      'You cannot respond to yourself.',
    );
    if (game.isErr()) return err(game.error);
    const requester = checkPending(game.value, 'take-back', actor, 'take-back request');
    if (requester.isErr()) return err(requester.error);

    const persisted = persistence.transaction((): Result<void, string> => {
      const cleared = persistence.clearPendingRequest(game.value.id);
      if (cleared.isErr()) return cleared;
      return persistence.appendActivityTrail({
        userId: actor.id,
        gameId: game.value.id,
        event: 'take-back-rejected',
        payload: { by: requester.value },
      });
    });
    if (persisted.isErr()) return err(persistenceError(persisted.error));

    return ok({ type: 'ok' });
  }

  /** Load a game and the actor's side(s) in it, refusing a non-participant. */
  function loadOwnSides(
    actor: SessionUser,
    gameId: number,
    act: string,
  ): Result<{ game: GameRecord; sides: GameSide[] }, GameError> {
    const player = requirePlayer(actor);
    if (player.isErr()) return err(player.error);

    const found = persistence.findGameById(gameId);
    if (found.isErr()) return err(persistenceError(found.error));
    if (found.value === null) return err({ code: 'not-found', message: 'That game no longer exists.' });
    const game = found.value;

    const sides = sidesOf(game, actor.id);
    if (sides.length === 0) {
      return err({ code: 'forbidden', message: `Only a participant may ${act}.` });
    }
    return ok({ game, sides });
  }

  function share(
    actor: SessionUser,
    command: Extract<GameCommand, { type: 'share' }>,
  ): Result<GameCommandResult, GameError> {
    const loaded = loadOwnSides(actor, command.gameId, 'change sharing');
    if (loaded.isErr()) return err(loaded.error);
    const { game, sides } = loaded.value;

    const persisted = persistence.transaction((): Result<void, string> => {
      for (const side of sides) {
        const set = persistence.setGameShare(game.id, side, command.on);
        if (set.isErr()) return set;
      }
      return persistence.appendActivityTrail({
        userId: actor.id,
        gameId: game.id,
        event: command.on ? 'game-shared' : 'game-unshared',
      });
    });
    if (persisted.isErr()) return err(persistenceError(persisted.error));

    return ok({ type: 'ok' });
  }

  /**
   * Hide the game for the actor's side(s). Self-play holds both sides, so it
   * always counts as mutual; otherwise mutual is the other side's hidden flag,
   * read before this hide is applied. Mutual hide deletes the game outright
   * (CONTEXT.md: Hide) — unlike an admin's removal, nobody needs to be told,
   * since both participants chose it themselves.
   */
  function hide(
    actor: SessionUser,
    command: Extract<GameCommand, { type: 'hide' }>,
  ): Result<GameCommandResult, GameError> {
    const loaded = loadOwnSides(actor, command.gameId, 'hide a game');
    if (loaded.isErr()) return err(loaded.error);
    const { game, sides } = loaded.value;

    const mutual = sides.length === 2 || (sides[0] === 'proposer' ? game.opponentHidden : game.proposerHidden);

    const persisted = persistence.transaction((): Result<void, string> => {
      const hidden = persistence.hideGame(game.id, sides);
      if (hidden.isErr()) return hidden;
      const trail = persistence.appendActivityTrail({ userId: actor.id, gameId: game.id, event: 'game-hidden' });
      if (trail.isErr()) return trail;
      if (!mutual) return ok(undefined);

      // activity_trail.game_id is ON DELETE SET NULL, so the id goes in the
      // payload too, same as deleteProposal's trail entry.
      const deleted = persistence.appendActivityTrail({
        userId: actor.id,
        gameId: game.id,
        event: 'game-deleted',
        payload: { gameId: game.id, reason: 'both-hidden' },
      });
      if (deleted.isErr()) return deleted;
      return persistence.deleteGame(game.id);
    });
    if (persisted.isErr()) return err(persistenceError(persisted.error));

    return ok({ type: 'ok' });
  }

  /**
   * Add or drop one id from the actor's follow list and persist the whole
   * thing back with a trail entry (ticket 04) — `setUserPrefs` replaces
   * wholesale, so every write reads the current list first rather than
   * risking two concurrent edits clobbering each other's addition. Shared by
   * `follow` and `unfollow`, which differ only in the edit and the event.
   */
  function editFollows(
    actor: SessionUser,
    userId: number,
    event: 'player-followed' | 'player-unfollowed',
    edit: (follows: Set<number>) => void,
  ): Result<GameCommandResult, GameError> {
    const prefs = persistence.getUserPrefs(actor.id);
    if (prefs.isErr()) return err(persistenceError(prefs.error));
    const follows = new Set(prefs.value.follows);
    edit(follows);

    const persisted = persistence.transaction((): Result<void, string> => {
      const saved = persistence.setUserPrefs(actor.id, { follows: [...follows] });
      if (saved.isErr()) return saved;
      return persistence.appendActivityTrail({ userId: actor.id, event, payload: { followedUserId: userId } });
    });
    if (persisted.isErr()) return err(persistenceError(persisted.error));

    return ok({ type: 'ok' });
  }

  function follow(
    actor: SessionUser,
    command: Extract<GameCommand, { type: 'follow' }>,
  ): Result<GameCommandResult, GameError> {
    const player = requirePlayer(actor);
    if (player.isErr()) return err(player.error);
    if (command.userId === actor.id) {
      return err({ code: 'invalid-follow', message: 'You cannot follow yourself.' });
    }
    const target = persistence.findUserById(command.userId);
    if (target.isErr()) return err(persistenceError(target.error));
    if (target.value === null) return err({ code: 'not-found', message: 'That player no longer exists.' });

    return editFollows(actor, command.userId, 'player-followed', (follows) => follows.add(command.userId));
  }

  function unfollow(
    actor: SessionUser,
    command: Extract<GameCommand, { type: 'unfollow' }>,
  ): Result<GameCommandResult, GameError> {
    const player = requirePlayer(actor);
    if (player.isErr()) return err(player.error);

    // No existence check: unfollowing an id that was never followed, or one
    // whose account is since gone, is a no-op either way — not an error.
    return editFollows(actor, command.userId, 'player-unfollowed', (follows) => follows.delete(command.userId));
  }

  /**
   * An admin's forced end to any game. Unlike a mutual hide, the row stays —
   * with any real result it already had — so affected players see why it
   * ended, on the game view and in their lists.
   */
  function adminDelete(
    actor: SessionUser,
    command: Extract<GameCommand, { type: 'adminDelete' }>,
  ): Result<GameCommandResult, GameError> {
    if (actor.role !== 'admin') {
      return err({ code: 'forbidden', message: 'Only an admin can do that.' });
    }

    const found = persistence.findGameById(command.gameId);
    if (found.isErr()) return err(persistenceError(found.error));
    if (found.value === null) return err({ code: 'not-found', message: 'That game no longer exists.' });
    const game = found.value;
    if (game.adminRemoved) {
      return err({ code: 'already-removed', message: 'This game has already been removed by an admin.' });
    }

    const persisted = persistence.transaction((): Result<void, string> => {
      const cleared = persistence.clearPendingRequest(game.id);
      if (cleared.isErr()) return cleared;
      const removed = persistence.adminRemoveGame(game.id);
      if (removed.isErr()) return removed;
      return persistence.appendActivityTrail({
        userId: actor.id,
        gameId: game.id,
        event: 'game-admin-deleted',
        payload: { by: actor.username, priorState: game.state },
      });
    });
    if (persisted.isErr()) return err(persistenceError(persisted.error));

    return ok({ type: 'ok' });
  }

  /**
   * Load a game the actor is allowed to look at. Ticket 13: an admin may see
   * any game regardless of share state; everyone else goes through `visibleTo`.
   * A game they may not see reads as absent, so share state never leaks.
   */
  function loadVisibleGame(actor: SessionUser, gameId: number): Result<GameRecord, GameError> {
    const found = persistence.findGameById(gameId);
    if (found.isErr()) return err(persistenceError(found.error));
    if (found.value === null) return err({ code: 'not-found', message: 'That game no longer exists.' });
    const game = found.value;
    if (actor.role !== 'admin' && !visibleTo(game, actor.id)) {
      return err({ code: 'not-found', message: 'That game no longer exists.' });
    }
    return ok(game);
  }

  /**
   * Copy the record out as PTN or TPS (ticket 15). This is a read, but an
   * audited one — CONTEXT.md lists exports among the activity trail's events —
   * so it is a command rather than a query, and the trail write stays inside
   * the module as ADR-0004 requires.
   */
  function exportGame(
    actor: SessionUser,
    command: Extract<GameCommand, { type: 'export' }>,
  ): Result<GameCommandResult, GameError> {
    const format = parseExportFormat(command.format);
    if (format.isErr()) return err(format.error);

    const loaded = loadVisibleGame(actor, command.gameId);
    if (loaded.isErr()) return err(loaded.error);
    const game = loaded.value;

    const loadedRecord = loadStoredGame(game);
    if (loadedRecord.isErr()) return err(loadedRecord.error);
    const { record, tak: full } = loadedRecord.value;

    const totalMoves = full.history.length;
    const throughMove = command.throughMove ?? totalMoves;
    if (!Number.isInteger(throughMove) || throughMove < 0 || throughMove > totalMoves) {
      return err({
        code: 'invalid-move-number',
        message: `This game has ${totalMoves} moves; choose one between 0 and ${totalMoves}.`,
      });
    }

    let text: string;
    if (format.value === 'tps') {
      // A position needs the board, so the export asks the core for the state
      // after that move — one snapshot read, not a replay.
      const position = stateAfter(record, throughMove).mapErr((error) => recordError(game.id, error));
      if (position.isErr()) return err(position.error);
      text = generateTps(position.value);
    } else {
      // Who held each seat here. A record that does not name its players is a
      // move list, not a game record (CONTEXT.md: PTN is tags, moves, result).
      // Nothing else is claimed: an imported game's own tags are not this
      // game's to restate. Seats come from the starter choice, so Player1 is
      // the seat-1 account, not necessarily the proposer.
      const nameOf = nameResolver();
      const seat1 = seatOf(game, 1);
      const seat2 = seatOf(game, 2);
      const tags: Array<readonly [string, string]> = [];
      if (seat1 !== null) {
        const p1 = nameOf(seat1);
        if (p1.isErr()) return err(p1.error);
        tags.push(['Player1', p1.value.displayName]);
      }
      if (seat2 !== null) {
        const p2 = nameOf(seat2);
        if (p2.isErr()) return err(p2.error);
        tags.push(['Player2', p2.value.displayName]);
      }

      // A prefix stops short of the ending, so it must not carry the result:
      // the record would claim a finish those moves never reached.
      const result = throughMove === totalMoves ? asResultCode(game.result) : undefined;
      const generated = generatePtn(
        full.history.slice(0, throughMove).map((recorded) => recorded.move),
        game.boardSize,
        { tags, result },
      );
      if (generated.isErr()) {
        return err(persistenceError(`game ${game.id} did not generate valid PTN: ${generated.error.message}`));
      }
      text = generated.value;
    }

    const trail = persistence.appendActivityTrail({
      userId: actor.id,
      gameId: game.id,
      event: 'game-exported',
      payload: { format: format.value, throughMove, complete: throughMove === totalMoves },
    });
    if (trail.isErr()) return err(persistenceError(trail.error));

    return ok({ type: 'export', format: format.value, text, throughMove, totalMoves });
  }

  function gameView(actor: SessionUser, gameId: number): Result<GameView, GameError> {
    // Ticket 13: an admin may view any game regardless of share state.
    const isAdmin = actor.role === 'admin';

    const loaded = loadVisibleGame(actor, gameId);
    if (loaded.isErr()) return err(loaded.error);
    const game = loaded.value;

    const nameOf = nameResolver();
    const proposer = nameOf(game.proposerId);
    if (proposer.isErr()) return err(proposer.error);
    const opponent = game.opponentId === null ? ok(null) : nameOf(game.opponentId);
    if (opponent.isErr()) return err(opponent.error);

    const loadedRecord = loadStoredGame(game);
    if (loadedRecord.isErr()) return err(loadedRecord.error);
    const { record, tak } = loadedRecord.value;

    const viewerSeat = seatOfActor(game, actor.id);
    const selfPlay = isSelfPlay(game);
    const toMoveSeat: 1 | 2 | null = game.state === 'in_play' ? tak.state.playerToMove : null;
    // Seat 1 (filled) and seat 2 (open) resolve through the proposer's seat,
    // which the starter choice sets — the proposer need not be seat 1.
    const seat1Ref = seatOf(game, 1) === game.proposerId ? proposer.value : opponent.value;
    const seat2Ref = seatOf(game, 2) === game.proposerId ? proposer.value : opponent.value;
    const toMove = toMoveSeat === null ? null : toMoveSeat === 1 ? seat1Ref : seat2Ref;

    // The single pending request/offer, resolved to a name for the board.
    let pending: PendingRequestView | null = null;
    if (game.pendingKind !== null && game.pendingBy !== null) {
      const requester = nameOf(game.pendingBy);
      if (requester.isErr()) return err(requester.error);
      pending = { kind: game.pendingKind, requester: requester.value };
    }
    const requesterSeat = game.pendingBy === null ? null : seatOfActor(game, game.pendingBy);
    const inPlay = game.state === 'in_play';
    const participant = viewerSeat !== null;
    const noPending = pending === null;
    // The last live move's seat, or null when the history ends in imported moves.
    const lastLiveSeat: 1 | 2 | null =
      tak.history.length > tak.fixedMoves ? ((tak.history.length - 1) % 2 === 0 ? 1 : 2) : null;

    const moves: MoveView[] = [];
    for (let i = 0; i < tak.history.length; i++) {
      const rec = tak.history[i]!;
      const seat: 1 | 2 = i % 2 === 0 ? 1 : 2;
      const ref = seat === 1 ? seat1Ref : seat2Ref;
      if (ref === null) continue; // moves exist only after a join, so the joiner is known
      // The scrubber renders straight from this: the position after each move,
      // read the same way `export`'s TPS does (core's `stateAfter`).
      const position = stateAfter(record, i + 1).mapErr((error) => recordError(game.id, error));
      if (position.isErr()) return err(position.error);
      moves.push({
        number: i + 1,
        seat,
        player: ref,
        notation: formatMove(rec.move),
        imported: i < tak.fixedMoves,
        tps: generateTps(position.value),
      });
    }

    // Ticket 13: the viewer's own share/hide standing, and an admin's removal power.
    const sides = sidesOf(game, actor.id);
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
      opened: tak.state.opened,
      viewerShared,
      canHide: sides.length > 0,
      canAdminDelete: isAdmin && !game.adminRemoved,
      adminRemoved: game.adminRemoved,
    });
  }

  /** Build the view of one game for `actor`, resolving names through `nameOf`. */
  function summarise(
    game: GameRecord,
    actor: SessionUser,
    nameOf: (id: number) => Result<PlayerRef, GameError>,
    lastMoveAt: ReadonlyMap<number, string>,
    follows: ReadonlySet<number>,
  ): Result<GameSummary, GameError> {
    const proposer = nameOf(game.proposerId);
    if (proposer.isErr()) return err(proposer.error);

    const resolveOptional = (id: number | null): Result<PlayerRef | null, GameError> =>
      id === null ? ok(null) : nameOf(id);

    const opponent = resolveOptional(game.opponentId);
    if (opponent.isErr()) return err(opponent.error);
    const invitedPlayer = resolveOptional(game.invitedPlayerId);
    if (invitedPlayer.isErr()) return err(invitedPlayer.error);

    let toMove: PlayerRef | null = null;
    if (game.state === 'in_play') {
      const position = loadTakGame(game);
      if (position.isErr()) return err(position.error);
      const seat = seatOf(game, position.value.state.playerToMove);
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
      canDelete: deletableBy(game, actor.id),
      canJoin: joinableBy(game, actor),
      canSolo: game.proposerId === actor.id && joinableBy(game, actor),
      adminRemoved: game.adminRemoved,
      toMove,
      result: game.result,
      proposerSeat: game.proposerSeat,
      lastActivity: lastMoveAt.get(game.id) ?? game.createdAt,
      followed: follows.has(game.proposerId),
      canFollow: game.proposerId !== actor.id,
      canHide: sidesOf(game, actor.id).length > 0,
    });
  }

  /** Summarise a batch, sharing one name cache, one last-move-timestamp query, and the actor's follow list across the whole list. */
  function summariseAll(games: readonly GameRecord[], actor: SessionUser): Result<GameSummary[], GameError> {
    const nameOf = nameResolver();
    const lastMoveAt = persistence.listLastMoveTimestamps(games.map((g) => g.id));
    if (lastMoveAt.isErr()) return err(persistenceError(lastMoveAt.error));
    const prefs = persistence.getUserPrefs(actor.id);
    if (prefs.isErr()) return err(persistenceError(prefs.error));
    const follows = new Set(prefs.value.follows);
    const summaries: GameSummary[] = [];
    for (const game of games) {
      const summary = summarise(game, actor, nameOf, lastMoveAt.value, follows);
      if (summary.isErr()) return err(summary.error);
      summaries.push(summary.value);
    }
    return ok(summaries);
  }

  /** `listMyGames`'s sort keys (ticket 03), each with a stable id-descending tiebreak. */
  function sortSummaries(summaries: readonly GameSummary[], sort: GameListSort, direction: 'asc' | 'desc'): GameSummary[] {
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

  return {
    applyGame(actor, command): Result<GameCommandResult, GameError> {
      switch (command.type) {
        case 'propose':
          return propose(actor, command);
        case 'deleteProposal':
          return deleteProposal(actor, command.gameId);
        case 'join':
          return join(actor, command.gameId);
        case 'playMove':
          return playMove(actor, command);
        case 'resign':
          return resign(actor, command);
        case 'requestTakeBack':
          return requestTakeBack(actor, command);
        case 'acceptTakeBack':
          return acceptTakeBack(actor, command);
        case 'rejectTakeBack':
          return rejectTakeBack(actor, command);
        case 'offerDraw':
          return offerDraw(actor, command);
        case 'acceptDraw':
          return acceptDraw(actor, command);
        case 'rejectDraw':
          return rejectDraw(actor, command);
        case 'share':
          return share(actor, command);
        case 'hide':
          return hide(actor, command);
        case 'adminDelete':
          return adminDelete(actor, command);
        case 'export':
          return exportGame(actor, command);
        case 'follow':
          return follow(actor, command);
        case 'unfollow':
          return unfollow(actor, command);
      }
    },

    getGame(actor, gameId): Result<GameView, GameError> {
      return gameView(actor, gameId);
    },

    listMyGames(actor: SessionUser, query: MyGamesQuery = {}): Result<GameSummary[], GameError> {
      // An admin has no games of their own; refusing here keeps the page and the
      // propose command telling the same story.
      const player = requirePlayer(actor);
      if (player.isErr()) return err(player.error);

      // `list-query.ts` (via `app.ts`) has already validated every field —
      // ADR-0008's narrow exception to this module owning validation — so
      // this module only ever composes the resolved values, filling in
      // whatever a caller (a test, most often) left out.
      const resolved = resolveQuery(MY_GAMES_SCHEMA, query);

      const states = resolved.status === null ? ALL_LIST_STATES : [resolved.status];
      const rows = persistence.listGamesForUser(actor.id, states, resolved.showRemoved);
      if (rows.isErr()) return err(persistenceError(rows.error));

      const summaries = summariseAll(rows.value, actor);
      if (summaries.isErr()) return err(summaries.error);
      return ok(sortSummaries(summaries.value, resolved.sort, resolved.direction));
    },

    searchProposed(actor: SessionUser, search: ProposedSearch = {}): Result<GameSummary[], GameError> {
      const player = requirePlayer(actor);
      if (player.isErr()) return err(player.error);

      const resolved = resolveQuery(FIND_GAMES_SCHEMA, search);
      const filters: ProposedGameFilters = {
        ...(resolved.boardSize !== null && { boardSize: resolved.boardSize }),
        ...(resolved.joinType !== null && { joinType: resolved.joinType as JoinType }),
        ...(resolved.proposerDisplayName !== null && { proposerDisplayName: resolved.proposerDisplayName }),
      };

      const rows = persistence.listProposedGames(filters);
      if (rows.isErr()) return err(persistenceError(rows.error));

      // This page is for taking up a game, so it lists what the actor could
      // actually join. That also keeps the ticket's rule exact — an invited
      // proposal reaches only the player it designates — where merely visible
      // would additionally show proposers the invitations they sent, which are
      // already on their own games page.
      const summaries = summariseAll(
        rows.value.filter((game) => joinableBy(game, actor)),
        actor,
      );
      if (summaries.isErr()) return err(summaries.error);

      // Curated mode (ticket 04) composes with the filters above: it narrows
      // what's already matched, rather than running a separate query.
      if (!resolved.curated) return ok(summaries.value);
      return ok(summaries.value.filter((g) => g.followed));
    },

    listAllGames(actor: SessionUser): Result<GameSummary[], GameError> {
      // Ticket 13: admins may view any game regardless of share state, and may
      // remove any game. The list is how they find one to open or remove.
      if (actor.role !== 'admin') {
        return err({ code: 'forbidden', message: 'Only an admin can list every game.' });
      }

      const rows = persistence.listAllGames();
      if (rows.isErr()) return err(persistenceError(rows.error));
      return summariseAll(rows.value, actor);
    },
  };
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
