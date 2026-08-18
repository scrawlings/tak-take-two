import { err, ok, type Result } from 'neverthrow';
import {
  createTakGame,
  formatMove,
  fromPtnText,
  generateTps,
  isBoardFinished,
  isFinished,
  mutualDraw as coreMutualDraw,
  parseMove,
  playMove as corePlayMove,
  resign as coreResign,
  resultCode,
} from '@tak/core';
import type { GameState, Player, StoneKind, TakGame } from '@tak/core';
import type {
  GameBoardSize,
  GameRecord,
  GameLifecycleState,
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
  /** The viewer is a participant and may resign or declare a draw. */
  readonly canEnd: boolean;
  /** Human-readable result, or null while in play. */
  readonly resultText: string | null;
  /** Remaining stones and capstones per seat. */
  readonly reserves: Readonly<Record<1 | 2, { readonly stones: number; readonly capstones: number }>>;
  /** Whether each seat has made its opening (first) move. */
  readonly opened: Readonly<Record<1 | 2, boolean>>;
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
  | { readonly type: 'mutualDraw'; readonly gameId: number };

/** One domain-shaped result per command; commands that only change state yield `{ type: 'ok' }`. */
export type GameCommandResult =
  | { readonly type: 'ok' }
  | { readonly type: 'propose'; readonly gameId: number }
  | { readonly type: 'join'; readonly gameId: number };

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
    const finished = persistence.finishGame(game.id, result);
    if (finished.isErr()) return finished;
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

  function mutualDraw(
    actor: SessionUser,
    command: Extract<GameCommand, { type: 'mutualDraw' }>,
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
      return err({ code: 'forbidden', message: 'You cannot draw against yourself.' });
    }

    const current = currentTakGame(game);
    if (current.isErr()) return err(current.error);
    const done = coreMutualDraw(current.value);
    if (done.isErr()) return err({ code: 'not-in-play', message: done.error.message });
    const result = resultCode(done.value)!;

    const persisted = persistence.transaction(() =>
      finishGameTransaction(actor, game, done.value, result, 'mutual-draw'),
    );
    if (persisted.isErr()) return err(persistenceError(persisted.error));

    return ok({ type: 'ok' });
  }

  function gameView(actor: SessionUser, gameId: number): Result<GameView, GameError> {
    const player = requirePlayer(actor);
    if (player.isErr()) return err(player.error);

    const found = persistence.findGameById(gameId);
    if (found.isErr()) return err(persistenceError(found.error));
    if (found.value === null) return err({ code: 'not-found', message: 'That game no longer exists.' });
    const game = found.value;
    if (!visibleTo(game, actor.id)) {
      return err({ code: 'not-found', message: 'That game no longer exists.' });
    }

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

    return ok({
      id: game.id,
      boardSize: game.boardSize,
      state: game.state,
      joinType: game.joinType,
      proposer: proposer.value,
      opponent: opponent.value,
      imported: game.importedPtn !== null,
      viewerSeat,
      selfPlay: isSelfPlay(game),
      moves,
      board: buildBoard(tak.state),
      toMove,
      toMoveSeat,
      canMove: game.state === 'in_play' && viewerSeat !== null && (selfPlay || viewerSeat === toMoveSeat),
      canEnd: game.state === 'in_play' && viewerSeat !== null && !selfPlay,
      resultText: resultTextOf(game.result, proposer.value, opponent.value),
      reserves: tak.state.reserves,
      opened: tak.state.opened,
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
        case 'mutualDraw':
          return mutualDraw(actor, command);
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
