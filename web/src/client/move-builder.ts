/**
 * The board move builder: a seat-agnostic state machine that turns board
 * clicks into Portable Tak Notation (ADR-0006). It owns the interaction state
 * — the stone to place, the source stack, how many stones are lifted, and how
 * many drop on each square of the path — and derives from it the composed
 * notation and the path highlights the board draws.
 *
 * It knows the *shape* of a move, never its legality: the server stays the
 * single validator, because a player may always type notation by hand. What it
 * does guarantee is that every notation it composes is well formed — a
 * straight-line path, a lift within the carry limit and the stack, at least
 * one stone on every crossed square, and drops that sum to the lift. The tests
 * pin that by round-tripping each composition through core's parser.
 *
 * Pure data in, pure data out: no DOM, no framework. The Alpine adapter owns
 * the board elements and the seat rule (`web/src/client/board-adapter.ts`).
 */

/** A stone a player may place. */
export type StoneKind = 'flat' | 'standing' | 'capstone';

/** A PTN direction: up, down, left, right. */
export type Direction = '+' | '-' | '<' | '>';

/** A square as the board writes it: file letter then rank digit, e.g. `b4`. */
export type SquareRef = string;

/** The stack a move lifts from. */
export interface SourceStack {
  readonly square: SquareRef;
  readonly height: number;
}

/** One square the move crosses, and how many stones it receives. */
export interface PathStep {
  readonly square: SquareRef;
  readonly drops: number;
}

export interface BuilderState {
  /** The board's edge length, which is also the carry limit. */
  readonly size: number;
  /** The stone a click on an empty square would place. */
  readonly stone: StoneKind;
  /** The stack being moved, or null when no move is being composed. */
  readonly source: SourceStack | null;
  /** Stones lifted from the source; 0 with no source selected. */
  readonly lift: number;
  /** The direction the path runs, or null before a destination is chosen. */
  readonly direction: Direction | null;
  /** The squares crossed, in order, each with the stones dropped there. */
  readonly path: readonly PathStep[];
  /** The composed PTN, or '' when there is nothing to play yet. */
  readonly notation: string;
}

/** One board click, with the seat rule already applied by the adapter. */
export interface SquareClick {
  readonly square: SquareRef;
  /** How many stones the square holds. */
  readonly height: number;
  /** Whether the viewer may lift this stack — the adapter's decision, not ours. */
  readonly mine: boolean;
}

const FILES = 'abcdef';

/** An empty builder for a board of `size` squares a side. */
export function createBuilder(size: number): BuilderState {
  return { size, stone: 'flat', source: null, lift: 0, direction: null, path: [], notation: '' };
}

/** Choose the stone a click on an empty square places. */
export function chooseStone(state: BuilderState, stone: StoneKind): BuilderState {
  return { ...state, stone };
}

/** Drop the selection: no source, no path, nothing composed. */
export function clearSelection(state: BuilderState): BuilderState {
  return { ...state, source: null, lift: 0, direction: null, path: [], notation: '' };
}

/** The most stones this source could lift: the carry limit, or the stack if shorter. */
export function maxLift(state: BuilderState): number {
  return state.source === null ? 0 : Math.min(state.source.height, state.size);
}

function fileIndex(square: SquareRef): number {
  return FILES.indexOf(square[0] ?? '');
}

function rankOf(square: SquareRef): number {
  return Number(square.slice(1));
}

/** The direction and distance from `from` to `to`, or null if not a straight line. */
function straightLine(from: SquareRef, to: SquareRef): { direction: Direction; distance: number } | null {
  const df = fileIndex(to) - fileIndex(from);
  const dr = rankOf(to) - rankOf(from);
  if (df !== 0 && dr !== 0) return null;
  if (df === 0 && dr === 0) return null;
  if (df === 0) return { direction: dr > 0 ? '+' : '-', distance: Math.abs(dr) };
  return { direction: df > 0 ? '>' : '<', distance: Math.abs(df) };
}

/** The squares a move from `from` crosses, in order. */
function walk(from: SquareRef, direction: Direction, distance: number): SquareRef[] {
  const squares: SquareRef[] = [];
  for (let step = 1; step <= distance; step++) {
    const file = fileIndex(from) + (direction === '>' ? step : direction === '<' ? -step : 0);
    const rank = rankOf(from) + (direction === '+' ? step : direction === '-' ? -step : 0);
    squares.push(`${FILES[file]}${rank}`);
  }
  return squares;
}

/**
 * The opening distribution: one stone on every square crossed, the rest on the
 * last. It is the starting point for adjustment, not the only answer.
 */
function spread(lift: number, squares: readonly SquareRef[]): PathStep[] {
  return squares.map((square, i) => ({
    square,
    drops: i === squares.length - 1 ? lift - (squares.length - 1) : 1,
  }));
}

/** The PTN for the state's current selection, or '' when it composes nothing. */
function compose(state: BuilderState): string {
  if (state.source === null || state.direction === null || state.path.length === 0) return '';
  const drops = state.path.map((step) => step.drops).join('');
  return `${state.lift}${state.source.square}${state.direction}${drops}`;
}

/** Recompose the notation after a change to the selection. */
function recomposed(state: BuilderState): BuilderState {
  return { ...state, notation: compose(state) };
}

function placement(state: BuilderState, square: SquareRef): BuilderState {
  const prefix = state.stone === 'standing' ? 'S' : state.stone === 'capstone' ? 'C' : '';
  return { ...state, notation: `${prefix}${square}` };
}

/**
 * A click on a board square, which means different things as the composition
 * proceeds: place a stone, take up a stack, put it back down, or choose where
 * it travels. A click that means nothing here leaves the state untouched —
 * the builder never composes a move a click did not ask for.
 */
export function clickSquare(state: BuilderState, click: SquareClick): BuilderState {
  if (state.source === null) {
    if (click.height === 0) return placement(state, click.square);
    if (!click.mine) return state;
    const source = { square: click.square, height: click.height };
    return { ...state, source, lift: Math.min(click.height, state.size), direction: null, path: [], notation: '' };
  }

  if (click.square === state.source.square) return clearSelection(state);

  const line = straightLine(state.source.square, click.square);
  if (line === null) return state;
  // Every crossed square takes a stone, so the path can be no longer than the
  // hand. The click is refused rather than silently shortened.
  if (line.distance > state.lift) return state;

  const path = spread(state.lift, walk(state.source.square, line.direction, line.distance));
  return recomposed({ ...state, direction: line.direction, path });
}

/**
 * Lift a different number of stones. The count is clamped to what the stack
 * and the carry limit allow, and to what the chosen path needs — a path of
 * three squares cannot be walked with two stones. Changing it re-spreads the
 * drops, so the player adjusts from a fresh distribution rather than a stale one.
 */
export function setLift(state: BuilderState, lift: number): BuilderState {
  if (state.source === null) return state;
  const floor = Math.max(1, state.path.length);
  const clamped = Math.min(Math.max(lift, floor), maxLift(state));
  const path = spread(
    clamped,
    state.path.map((step) => step.square),
  );
  return recomposed({ ...state, lift: clamped, path });
}

/**
 * Move one stone on or off a square of the path, keeping the two invariants
 * that make the result well formed: every crossed square keeps at least one
 * stone, and the drops still sum to the lift. The stone comes from — or goes
 * back to — the last square that can spare it, and an adjustment no square can
 * pay for is refused rather than half-applied.
 */
export function adjustDrop(state: BuilderState, index: number, delta: 1 | -1): BuilderState {
  const drops = state.path.map((step) => step.drops);
  if (index < 0 || index >= drops.length) return state;

  const canSpare = (i: number): boolean => i !== index && (drops[i] ?? 0) >= 2;
  const lastWhere = (pays: (i: number) => boolean): number => {
    for (let i = drops.length - 1; i >= 0; i--) if (pays(i)) return i;
    return -1;
  };

  if (delta === 1) {
    const donor = lastWhere(canSpare);
    if (donor === -1) return state;
    drops[index]! += 1;
    drops[donor]! -= 1;
  } else {
    if (drops[index]! <= 1) return state;
    const recipient = lastWhere((i) => i !== index);
    if (recipient === -1) return state;
    drops[index]! -= 1;
    drops[recipient]! += 1;
  }

  const path = state.path.map((step, i) => ({ square: step.square, drops: drops[i]! }));
  return recomposed({ ...state, path });
}
