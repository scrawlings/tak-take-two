// The headless game aggregate: a playable Tak game with a full, immutable move
// history (per-move timestamps), undo, resign, mutual draw, and finished state.
// Pure module — no I/O, no framework dependencies, no exceptions.
// Every failure path returns a neverthrow Result.

import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import { applyMove, createGame } from './game';
import { generatePtn, parsePtn } from './ptn';
import { opponent } from './types';
import type {
  BoardSize,
  GameState,
  Move,
  Outcome,
  Player,
  PtnError,
  PtnGame,
  PtnOptions,
  ResultCode,
  RuleError,
} from './types';

/** A single recorded move with the time it was played. */
export interface RecordedMove {
  readonly move: Move;
  /** Epoch milliseconds when the move was played; null for imported (fixed) history. */
  readonly playedAt: number | null;
}

/** How a game ended. `board` is a road/flat win detected by the rules engine. */
export type GameEnd =
  | { readonly kind: 'board'; readonly outcome: Outcome }
  | { readonly kind: 'resign'; readonly winner: Player }
  | { readonly kind: 'mutual-draw' };

/**
 * A headless game: the current rules state plus the full move history.
 * The first `fixedMoves` history entries are imported (fixed) and cannot be
 * undone; everything after them is live and undoable while the game is in play.
 */
export interface TakGame {
  /** The current board state (position, turn, reserves, engine outcome). */
  readonly state: GameState;
  /** Every move in play order, each with its timestamp (null for imported moves). */
  readonly history: readonly RecordedMove[];
  /** Number of leading history entries that are fixed (imported) and not undoable. */
  readonly fixedMoves: number;
  /** Non-null once the game has ended (board win, resign, or mutual draw). */
  readonly result: GameEnd | null;
}

export type GameErrorCode = 'game-finished' | 'no-move-to-undo' | 'invalid-move';

export interface GameError {
  readonly code: GameErrorCode;
  readonly message: string;
  /** The underlying rules error when `code` is `invalid-move`. */
  readonly ruleError?: RuleError;
}

function gameError(code: GameErrorCode, message: string, extra: Partial<GameError> = {}): GameError {
  return { code, message, ...extra };
}

/** Replay moves from an empty board, returning the final state (or a rule error). */
function replay(size: BoardSize, moves: readonly Move[]): Result<GameState, RuleError> {
  let state = createGame(size);
  for (const m of moves) {
    const applied = applyMove(state, m);
    if (applied.isErr()) return err(applied.error);
    state = applied.value;
  }
  return ok(state);
}

/** The aggregate-level end implied by an engine outcome, if any. */
function boardEnd(state: GameState): GameEnd | null {
  return state.outcome === null ? null : { kind: 'board', outcome: state.outcome };
}

/** Map a PTN result code to an aggregate end (board, resign, or draw). */
function endFromCode(code: ResultCode | null): GameEnd | null {
  switch (code) {
    case 'R-0':
      return { kind: 'board', outcome: { type: 'road', winner: 1 } };
    case '0-R':
      return { kind: 'board', outcome: { type: 'road', winner: 2 } };
    case 'F-0':
      return { kind: 'board', outcome: { type: 'flat', winner: 1 } };
    case '0-F':
      return { kind: 'board', outcome: { type: 'flat', winner: 2 } };
    case '1-0':
      return { kind: 'resign', winner: 1 };
    case '0-1':
      return { kind: 'resign', winner: 2 };
    case '1/2-1/2':
      return { kind: 'mutual-draw' };
    case '*':
    case null:
      return null; // abandoned / no recorded result — not a modelled finish
  }
}

/** Create a new empty game on a 5×5 or 6×6 board. */
export function createTakGame(size: BoardSize): TakGame {
  return { state: createGame(size), history: [], fixedMoves: 0, result: null };
}

export interface FromPtnOptions {
  /** Timestamp stamped on every imported move (e.g. the import time). Defaults to null. */
  readonly playedAt?: number | null;
}

/** Load a parsed, replay-validated PTN game as fixed history. */
export function fromPtn(game: PtnGame, options: FromPtnOptions = {}): Result<TakGame, GameError> {
  const replayed = replay(game.size, game.moves);
  if (replayed.isErr()) {
    return err(
      gameError('invalid-move', `imported record contains an illegal move: ${replayed.error.message}`, {
        ruleError: replayed.error,
      }),
    );
  }
  const playedAt = options.playedAt ?? null;
  const history: RecordedMove[] = game.moves.map((move) => ({ move, playedAt }));
  const result = boardEnd(replayed.value) ?? endFromCode(game.result);
  return ok({ state: replayed.value, history, fixedMoves: history.length, result });
}

/** Load a PTN record from text (parse + replay-validate + load as fixed history). */
export function fromPtnText(
  text: string,
  options: FromPtnOptions = {},
): Result<TakGame, GameError | PtnError> {
  const parsed = parsePtn(text);
  if (parsed.isErr()) return err(parsed.error);
  return fromPtn(parsed.value, options);
}

/** Play a move, recording it with a timestamp. */
export function playMove(game: TakGame, move: Move, playedAt: number = Date.now()): Result<TakGame, GameError> {
  if (game.result !== null) {
    return err(gameError('game-finished', 'the game has already finished'));
  }
  const applied = applyMove(game.state, move);
  if (applied.isErr()) {
    return err(gameError('invalid-move', applied.error.message, { ruleError: applied.error }));
  }
  const history = [...game.history, { move, playedAt }];
  return ok({ state: applied.value, history, fixedMoves: game.fixedMoves, result: boardEnd(applied.value) });
}

/** Undo the last live move, restoring the prior state. Only possible while in play. */
export function undo(game: TakGame): Result<TakGame, GameError> {
  if (game.result !== null) {
    return err(gameError('game-finished', 'cannot undo a finished game'));
  }
  if (game.history.length <= game.fixedMoves) {
    return err(gameError('no-move-to-undo', 'there is no live move to undo'));
  }
  const moves = game.history.slice(0, -1).map((r) => r.move);
  const replayed = replay(game.state.size, moves);
  if (replayed.isErr()) {
    return err(gameError('invalid-move', replayed.error.message, { ruleError: replayed.error }));
  }
  return ok({ state: replayed.value, history: game.history.slice(0, -1), fixedMoves: game.fixedMoves, result: null });
}

/** Resign as `player`; the opponent wins. */
export function resign(game: TakGame, player: Player): Result<TakGame, GameError> {
  if (game.result !== null) {
    return err(gameError('game-finished', 'the game has already finished'));
  }
  return ok({ ...game, result: { kind: 'resign', winner: opponent(player) } });
}

/** End the game as an agreed draw. */
export function mutualDraw(game: TakGame): Result<TakGame, GameError> {
  if (game.result !== null) {
    return err(gameError('game-finished', 'the game has already finished'));
  }
  return ok({ ...game, result: { kind: 'mutual-draw' } });
}

/** Whether the game has ended (board win, resign, or mutual draw). */
export function isFinished(game: TakGame): boolean {
  return game.result !== null;
}

/** The PTN result code for a finished game, or null while in play. */
export function resultCode(game: TakGame): ResultCode | null {
  const end = game.result;
  if (end === null) return null;
  switch (end.kind) {
    case 'board':
      if (end.outcome.type === 'road') return end.outcome.winner === 1 ? 'R-0' : '0-R';
      if (end.outcome.winner === 'draw') return '1/2-1/2';
      return end.outcome.winner === 1 ? 'F-0' : '0-F';
    case 'resign':
      return end.winner === 1 ? '1-0' : '0-1';
    case 'mutual-draw':
      return '1/2-1/2';
  }
}

/** Export the game as PTN text (full game; includes the result when finished). */
export function toPtn(game: TakGame, options: PtnOptions = {}): Result<string, PtnError> {
  const moves = game.history.map((r) => r.move);
  const result = resultCode(game);
  return generatePtn(moves, game.state.size, { tags: options.tags, result: result ?? undefined });
}
