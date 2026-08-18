import { err, ok, type Result } from 'neverthrow';
import { fromPtnText } from '@tak/core';
import type {
  GameBoardSize,
  GameRecord,
  GameLifecycleState,
  JoinType,
  Persistence,
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
  | 'not-proposed'
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
  | { readonly type: 'deleteProposal'; readonly gameId: number };

/** One domain-shaped result per command; commands that only change state yield `{ type: 'ok' }`. */
export type GameCommandResult =
  | { readonly type: 'ok' }
  | { readonly type: 'propose'; readonly gameId: number };

export interface Games {
  /** Run one game command. Commands authorise themselves. */
  applyGame(actor: SessionUser, command: GameCommand): Result<GameCommandResult, GameError>;
  /** The actor's own proposals and games in play, newest first. */
  listMyGames(actor: SessionUser): Result<GameSummary[], GameError>;
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
    // What bars an import is a *position* the rules have already decided — you
    // cannot continue from a won board. A `[Result]` tag is only metadata about
    // the game the record came from: a resignation, an agreed draw, or a prefix
    // exported with its result line still says nothing about this new game, and
    // `TakGame.result` folds both together, so read the engine outcome directly.
    if (loaded.value.state.outcome !== null) {
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

  return {
    applyGame(actor, command): Result<GameCommandResult, GameError> {
      switch (command.type) {
        case 'propose':
          return propose(actor, command);
        case 'deleteProposal':
          return deleteProposal(actor, command.gameId);
      }
    },

    listMyGames(actor: SessionUser): Result<GameSummary[], GameError> {
      // An admin has no games of their own; refusing here keeps the page and the
      // propose command telling the same story.
      const player = requirePlayer(actor);
      if (player.isErr()) return err(player.error);

      const rows = persistence.listGamesForUser(actor.id, ACTIVE_STATES);
      if (rows.isErr()) return err(persistenceError(rows.error));

      const nameOf = nameResolver();
      const summaries: GameSummary[] = [];
      for (const game of rows.value) {
        const proposer = nameOf(game.proposerId);
        if (proposer.isErr()) return err(proposer.error);

        let opponent: PlayerRef | null = null;
        if (game.opponentId !== null) {
          const resolved = nameOf(game.opponentId);
          if (resolved.isErr()) return err(resolved.error);
          opponent = resolved.value;
        }

        let invitedPlayer: PlayerRef | null = null;
        if (game.invitedPlayerId !== null) {
          const resolved = nameOf(game.invitedPlayerId);
          if (resolved.isErr()) return err(resolved.error);
          invitedPlayer = resolved.value;
        }

        summaries.push({
          id: game.id,
          boardSize: game.boardSize,
          state: game.state,
          joinType: game.joinType,
          proposer: proposer.value,
          opponent,
          invitedPlayer,
          otherPlayer: opponent === null ? null : opponent.id === actor.id ? proposer.value : opponent,
          imported: game.importedPtn !== null,
          createdAt: game.createdAt,
          canDelete: deletableBy(game, actor.id),
        });
      }
      return ok(summaries);
    },
  };
}
