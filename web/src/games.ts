import { err, ok, type Result } from 'neverthrow';
import {
  createTakGame,
  formatMove,
  fromPtnText,
  generatePtn,
  generateTps,
  isBoardFinished,
  isFinished,
  isResultCode,
  parseMove,
  playMove as corePlayMove,
  resign as coreResign,
  resultCode,
} from '@tak/core';
import type { GameState, Player, ResultCode, StoneKind, TakGame } from '@tak/core';
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

/** Lifecycle states a player's own list shows: everything not yet finished. */
const ACTIVE_STATES: readonly GameLifecycleState[] = ['proposed', 'in_play'];

export type GameErrorCode =
  | 'forbidden'
  | 'not-found'
  | 'invalid-board-size'
  | 'invalid-join-type'
  | 'invalid-invite'
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
  /** Whose turn it is, or null while the game is not in play. */
  readonly toMove: PlayerRef | null;
  /** Ticket 13: this game was ended by an admin, not by play or agreement. */
  readonly adminRemoved: boolean;
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

/** What a player may narrow a proposal search by. All optional; blanks mean "any". */
export interface ProposedSearch {
  readonly boardSize?: number;
  readonly joinType?: string;
  readonly proposerDisplayName?: string;
}

/** One command per game mutation. The actor is passed to `applyGame`, not embedded here. */
export type GameCommand =
  | {
      readonly type: 'propose';
      /** Ignored when `ptn` is given: an imported record carries its own `[Size]`. */
      readonly boardSize: number;
      readonly joinType: string;
      /** Required for an invited proposal; the display name of the player to invite. */
      readonly invitedDisplayName?: string;
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
  /** The actor's own proposals and games in play, newest first. */
  listMyGames(actor: SessionUser): Result<GameSummary[], GameError>;
  /** Proposals the actor could join: open ones, plus invitations to them. */
  searchProposed(actor: SessionUser, search?: ProposedSearch): Result<GameSummary[], GameError>;
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
  return player === 1 ? game.proposerId : game.opponentId;
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
      const claimed = persistence.joinGame(game.id, actor.id);
      if (claimed.isErr()) return claimed;
      // The conditional UPDATE is the real guard: if it changed nothing, the
      // game stopped being an unjoined proposal, so write no trail event.
      if (!claimed.value) return ok(false);
      const trail = persistence.appendActivityTrail({
        userId: actor.id,
        gameId: game.id,
        event: 'game-joined',
        payload: { proposer: game.proposerId, joinType: game.joinType },
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
    if (game.proposerId === actorId) return 1;
    if (game.opponentId === actorId) return 2;
    return null;
  }

  /**
   * The playable game a record has reached — the one load path every command
   * and view uses. Imported history replays from the stored record; played
   * moves replay from their canonical notation. Only records that already
   * replayed cleanly are stored, so a failure here is corruption, not input.
   */
  function currentTakGame(game: GameRecord): Result<TakGame, GameError> {
    let tak: TakGame;
    if (game.importedPtn !== null) {
      const loaded = fromPtnText(game.importedPtn);
      if (loaded.isErr()) {
        return err(persistenceError(`stored record for game ${game.id} no longer replays: ${loaded.error.message}`));
      }
      tak = loaded.value;
    } else {
      tak = createTakGame(game.boardSize);
    }

    const rows = persistence.listMoves(game.id);
    if (rows.isErr()) return err(persistenceError(rows.error));
    for (const row of rows.value) {
      const parsed = parseMove(row.notation);
      if (parsed.isErr()) {
        return err(persistenceError(`stored move ${row.moveNumber} for game ${game.id} no longer parses: ${parsed.error.message}`));
      }
      const played = corePlayMove(tak, parsed.value, Date.parse(row.playedAt));
      if (played.isErr()) {
        return err(persistenceError(`stored move ${row.moveNumber} for game ${game.id} no longer replays: ${played.error.message}`));
      }
      tak = played.value;
    }
    return ok(tak);
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

    const current = currentTakGame(game);
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

    const current = currentTakGame(game);
    if (current.isErr()) return err(current.error);
    const seat: 1 | 2 = actor.id === game.proposerId ? 1 : 2;
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

    const current = currentTakGame(game.value);
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
    const current = currentTakGame(game.value);
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
   * The game as it stood after `through` moves of `full`'s history. Replaying
   * from scratch is the only way back to an earlier position: the stored record
   * is the moves, not a per-move snapshot of the board.
   */
  function gameAfter(game: GameRecord, full: TakGame, through: number): Result<TakGame, GameError> {
    if (through === full.history.length) return ok(full);
    let tak = createTakGame(game.boardSize);
    for (const recorded of full.history.slice(0, through)) {
      const played = corePlayMove(tak, recorded.move);
      if (played.isErr()) {
        return err(persistenceError(`game ${game.id} no longer replays to move ${through}: ${played.error.message}`));
      }
      tak = played.value;
    }
    return ok(tak);
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

    const current = currentTakGame(game);
    if (current.isErr()) return err(current.error);
    const full = current.value;

    const totalMoves = full.history.length;
    const throughMove = command.throughMove ?? totalMoves;
    if (!Number.isInteger(throughMove) || throughMove < 0 || throughMove > totalMoves) {
      return err({
        code: 'invalid-move-number',
        message: `This game has ${totalMoves} moves; choose one between 0 and ${totalMoves}.`,
      });
    }

    const prefix = gameAfter(game, full, throughMove);
    if (prefix.isErr()) return err(prefix.error);

    let text: string;
    if (format.value === 'tps') {
      text = generateTps(prefix.value.state);
    } else {
      // Who held each seat here. A record that does not name its players is a
      // move list, not a game record (CONTEXT.md: PTN is tags, moves, result).
      // Nothing else is claimed: an imported game's own tags are not this
      // game's to restate.
      const nameOf = nameResolver();
      const proposer = nameOf(game.proposerId);
      if (proposer.isErr()) return err(proposer.error);
      const tags: Array<readonly [string, string]> = [['Player1', proposer.value.displayName]];
      if (game.opponentId !== null) {
        const opponent = nameOf(game.opponentId);
        if (opponent.isErr()) return err(opponent.error);
        tags.push(['Player2', opponent.value.displayName]);
      }

      // A prefix stops short of the ending, so it must not carry the result:
      // the record would claim a finish those moves never reached.
      const result = throughMove === totalMoves ? asResultCode(game.result) : undefined;
      const generated = generatePtn(
        prefix.value.history.map((recorded) => recorded.move),
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

    const current = currentTakGame(game);
    if (current.isErr()) return err(current.error);
    const tak = current.value;

    const viewerSeat = seatOfActor(game, actor.id);
    const selfPlay = isSelfPlay(game);
    const toMoveSeat: 1 | 2 | null = game.state === 'in_play' ? tak.state.playerToMove : null;
    const toMove = toMoveSeat === null ? null : toMoveSeat === 1 ? proposer.value : opponent.value;

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
      const ref = seat === 1 ? proposer.value : opponent.value;
      if (ref === null) continue; // moves exist only after a join, so the joiner is known
      moves.push({
        number: i + 1,
        seat,
        player: ref,
        notation: formatMove(rec.move),
        imported: i < tak.fixedMoves,
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
      resultText: resultTextOf(game.result, proposer.value, opponent.value),
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
      const position = currentTakGame(game);
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
      adminRemoved: game.adminRemoved,
      toMove,
    });
  }

  /** Summarise a batch, sharing one name cache across the whole list. */
  function summariseAll(games: readonly GameRecord[], actor: SessionUser): Result<GameSummary[], GameError> {
    const nameOf = nameResolver();
    const summaries: GameSummary[] = [];
    for (const game of games) {
      const summary = summarise(game, actor, nameOf);
      if (summary.isErr()) return err(summary.error);
      summaries.push(summary.value);
    }
    return ok(summaries);
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
      }
    },

    getGame(actor, gameId): Result<GameView, GameError> {
      return gameView(actor, gameId);
    },

    listMyGames(actor: SessionUser): Result<GameSummary[], GameError> {
      // An admin has no games of their own; refusing here keeps the page and the
      // propose command telling the same story.
      const player = requirePlayer(actor);
      if (player.isErr()) return err(player.error);

      const rows = persistence.listGamesForUser(actor.id, ACTIVE_STATES);
      if (rows.isErr()) return err(persistenceError(rows.error));
      return summariseAll(rows.value, actor);
    },

    searchProposed(actor: SessionUser, search: ProposedSearch = {}): Result<GameSummary[], GameError> {
      const player = requirePlayer(actor);
      if (player.isErr()) return err(player.error);

      const filters = parseSearch(search);
      if (filters.isErr()) return err(filters.error);

      const rows = persistence.listProposedGames(filters.value);
      if (rows.isErr()) return err(persistenceError(rows.error));

      // This page is for taking up a game, so it lists what the actor could
      // actually join. That also keeps the ticket's rule exact — an invited
      // proposal reaches only the player it designates — where merely visible
      // would additionally show proposers the invitations they sent, which are
      // already on their own games page.
      return summariseAll(
        rows.value.filter((game) => joinableBy(game, actor)),
        actor,
      );
    },
  };
}

/** Coerce a submitted search to column filters. A blank field means "any". */
function parseSearch(search: ProposedSearch): Result<ProposedGameFilters, GameError> {
  const filters: {
    boardSize?: GameBoardSize;
    joinType?: JoinType;
    proposerDisplayName?: string;
  } = {};

  if (search.boardSize !== undefined) {
    const parsed = parseBoardSize(search.boardSize);
    if (parsed.isErr()) return err(parsed.error);
    filters.boardSize = parsed.value;
  }
  if (search.joinType !== undefined) {
    const parsed = parseJoinType(search.joinType);
    if (parsed.isErr()) return err(parsed.error);
    filters.joinType = parsed.value;
  }
  const name = search.proposerDisplayName?.trim();
  if (name) filters.proposerDisplayName = name;

  return ok(filters);
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
function resultTextOf(result: string | null, p1: PlayerRef, p2: PlayerRef | null): string | null {
  switch (result) {
    case 'R-0':
      return `Road win for ${p1.displayName}`;
    case '0-R':
      return p2 ? `Road win for ${p2.displayName}` : 'Road win for player 2';
    case 'F-0':
      return `Flat win for ${p1.displayName}`;
    case '0-F':
      return p2 ? `Flat win for ${p2.displayName}` : 'Flat win for player 2';
    case '1-0':
      return `${p1.displayName} wins by resignation`;
    case '0-1':
      return p2 ? `${p2.displayName} wins by resignation` : 'Player 2 wins by resignation';
    case '1/2-1/2':
      return 'Draw by agreement';
    default:
      return null;
  }
}
