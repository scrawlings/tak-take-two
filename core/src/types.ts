// Domain types for the Tak rules engine.
// Pure data — no I/O, no framework dependencies.

/** Board edge length. This system supports 5×5 and 6×6 boards. */
export type BoardSize = 5 | 6;

/** A player: 1 (first to move) or 2. */
export type Player = 1 | 2;

/** A board file (column), a–f. The union constrains coordinates at compile time. */
export type File = 'a' | 'b' | 'c' | 'd' | 'e' | 'f';

/** A board rank (row), 1–6. */
export type Rank = 1 | 2 | 3 | 4 | 5 | 6;

declare const squareBrand: unique symbol;

/** A board square, addressed by file and rank. Nominal: construct it via `square()`. */
export type Square = readonly [File, Rank] & { readonly [squareBrand]: true };

/** Orthogonal move direction, from Player 1's perspective. */
export type Direction = '+' | '-' | '<' | '>';

/** The three stone kinds. */
export type StoneKind = 'flat' | 'standing' | 'capstone';

/** A single stone, owned by a player. */
export interface Stone {
  readonly player: Player;
  readonly kind: StoneKind;
}

/** A stack of stones, bottom to top. The top stone controls the stack. */
export type Stack = readonly Stone[];

/** A player's remaining pieces. */
export interface PlayerReserve {
  readonly stones: number;
  readonly capstones: number;
}

export type Reserves = Record<Player, PlayerReserve>;

/** A finished game's outcome. */
export type Outcome =
  | { readonly type: 'road'; readonly winner: Player }
  | { readonly type: 'flat'; readonly winner: Player | 'draw' };

/** A move: place a stone, or move a stack. */
export type Move =
  | { readonly type: 'place'; readonly square: Square; readonly stone: StoneKind }
  | {
      readonly type: 'move';
      readonly square: Square;
      readonly direction: Direction;
      readonly drops: readonly number[];
    };

/** The board: a dense grid of stacks indexed [fileIndex][rankIndex]. */
export interface Board {
  readonly size: BoardSize;
  readonly grid: readonly (readonly Stack[])[];
}

/** Full immutable game state. */
export interface GameState {
  readonly size: BoardSize;
  readonly board: Board;
  readonly playerToMove: Player;
  /** Full-move counter (starts at 1; a full move = both players' turns). */
  readonly moveNumber: number;
  readonly reserves: Reserves;
  /** Whether each player has made their opening (first) move. */
  readonly opened: Record<Player, boolean>;
  readonly outcome: Outcome | null;
}

export type RuleErrorCode =
  | 'square-off-board'
  | 'square-occupied'
  | 'opening-must-be-flat'
  | 'opening-not-complete'
  | 'no-stones-in-reserve'
  | 'no-capstone-in-reserve'
  | 'source-empty'
  | 'not-your-stack'
  | 'carry-limit-exceeded'
  | 'carry-exceeds-stack'
  | 'no-drops'
  | 'invalid-drop'
  | 'drops-off-board'
  | 'crossing-standing-stone'
  | 'crossing-capstone'
  | 'cannot-stack-on-standing-stone'
  | 'cannot-stack-on-capstone'
  | 'game-finished';

export interface RuleError {
  readonly code: RuleErrorCode;
  readonly message: string;
}

/** The opponent of a player. */
export function opponent(player: Player): Player {
  return player === 1 ? 2 : 1;
}

/** Construct a square from its file and rank. */
export function square(file: File, rank: Rank): Square {
  return [file, rank] as unknown as Square;
}

/** A player's starting reserve for a board size. */
export function initialReserve(size: BoardSize): PlayerReserve {
  return size === 5 ? { stones: 21, capstones: 1 } : { stones: 30, capstones: 1 };
}
