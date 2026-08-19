/**
 * The Alpine adapter over the move builder (ADR-0006): it owns the DOM and the
 * seat rule, the module owns the move. It is registered as `takBoard` by the
 * bundle's entry point, which is the one place that names the site's
 * components.
 *
 * The seat rule lives here because whose stack a square holds is a view
 * concern (CONTEXT.md: Seat) that the Game module decided server-side; the
 * builder itself never learns about seats.
 *
 * Its *inputs* are read from the board element on every click rather than
 * taken from the `x-data` config, because they change while the page is open:
 * a move passes the turn, and a joiner settles a random start. The config the
 * stream never replaces (ADR-0007) may therefore hold only what cannot change
 * — the board's size — or a streamed update would leave a live move form above
 * a board that still refuses every click.
 */

import {
  chooseStone,
  clearSelection,
  clickSquare,
  createBuilder,
  maxLift,
  moveDrop,
  setLift,
} from './move-builder.js';
import type { BuilderState, PathStep, SourceStack, SquareRef, StoneKind } from './move-builder.js';

/**
 * What the game page tells the board once and for all. Everything else the
 * adapter needs is on the board element, which the stream keeps current.
 */
export interface BoardConfig {
  readonly size: number;
}

/**
 * What the viewer may do with this board right now, as the server rendered it
 * into the streamed board element.
 */
interface BoardStanding {
  /** The viewer may play a move at all. */
  readonly canMove: boolean;
  /** The seat the viewer holds, as a string, or '' for a spectator. */
  readonly viewerSeat: string;
  /** One account holds both seats, so either colour is theirs to lift. */
  readonly selfPlay: boolean;
}

/** Read the standing off the board this cell belongs to. */
function standingOf(cell: HTMLElement): BoardStanding {
  const data = cell.closest<HTMLElement>('.board')?.dataset ?? {};
  return {
    canMove: data.canMove === '1',
    viewerSeat: data.viewerSeat ?? '',
    selfPlay: data.selfPlay === '1',
  };
}

export interface BoardComponent {
  state: BuilderState;
  /** Bound to the move field with `x-model`, so a player may still type over it. */
  move: string;
  /** The source square's glyphs, bottom to top, read from the DOM at pickup. */
  sourceStack: string;
  readonly stone: StoneKind;
  readonly source: SourceStack | null;
  readonly sourceSquare: string;
  readonly lift: number;
  /** The bounds of the lift stepper, so a disabled button and a refused transition agree. */
  readonly liftCeiling: number;
  readonly liftFloor: number;
  readonly path: readonly PathStep[];
  readonly partition: string;
  apply(next: BuilderState, pickedUpStack?: string): void;
  pick(stone: StoneKind): void;
  cellClick(el: HTMLElement): void;
  isSource(square: SquareRef): boolean;
  bumpLift(delta: number): void;
  shiftDrop(index: number, towards: 1 | -1): void;
  canShiftDrop(index: number, towards: 1 | -1): boolean;
  dropsOn(square: SquareRef): number;
  cancel(): void;
}

export function boardComponent(config: BoardConfig): BoardComponent {
  return {
    state: createBuilder(config.size),
    move: '',
    sourceStack: '',

    get stone(): StoneKind {
      return this.state.stone;
    },
    get source(): SourceStack | null {
      return this.state.source;
    },
    /** The source's name, or '' — the templates want a string either way. */
    get sourceSquare(): string {
      return this.state.source?.square ?? '';
    },
    get lift(): number {
      return this.state.lift;
    },
    get liftCeiling(): number {
      return maxLift(this.state);
    },
    /** A path needs a stone for every square it crosses, and a lift needs one stone. */
    get liftFloor(): number {
      return Math.max(1, this.state.path.length);
    },
    get path(): readonly PathStep[] {
      return this.state.path;
    },

    /**
     * The whole source stack, rendered as its own glyphs — bottom to top,
     * left to right, the same order the drops consume the hand — split at
     * where the lift cuts it, and the lifted part split again by the current
     * path. What stays behind is shown too: it is as much a part of the
     * decision as what moves, so a `‖` marks the cut and `·` marks the drops.
     */
    get partition(): string {
      const boundary = Math.max(0, this.sourceStack.length - this.state.lift);
      const staying = this.sourceStack.slice(0, boundary);
      const hand = this.sourceStack.slice(boundary);
      const groups: string[] = [];
      let taken = 0;
      for (const step of this.state.path) {
        groups.push(hand.slice(taken, taken + step.drops));
        taken += step.drops;
      }
      const moving = (groups.length > 0 ? groups : [hand]).join(' · ');
      return staying === '' ? moving : `${staying} ‖ ${moving}`;
    },

    /**
     * Take the builder's next state and keep the move field and the carried
     * stack's glyphs in step. A composition fills the move field; putting the
     * stack back down empties it, because a cleared board that still offers
     * the old move to Play is a trap. Nothing else writes to the field:
     * picking a stack up composes nothing yet, and blanking it then would
     * throw away what the player typed. `pickedUpStack` is only meaningful on
     * the click that lifts a stack — the DOM element is the one place that
     * glyph string exists, so `cellClick` reads it and hands it through.
     */
    apply(next: BuilderState, pickedUpStack = ''): void {
      const putBack = this.state.source !== null && next.source === null;
      const pickedUp = this.state.source === null && next.source !== null;
      this.state = next;
      if (pickedUp) this.sourceStack = pickedUpStack;
      else if (putBack) this.sourceStack = '';
      if (next.notation !== '') this.move = next.notation;
      else if (putBack) this.move = '';
    },

    pick(stone: StoneKind): void {
      this.state = chooseStone(this.state, stone);
    },

    cellClick(el: HTMLElement): void {
      const standing = standingOf(el);
      if (!standing.canMove) return;
      const square = el.dataset.square ?? '';
      const height = Number(el.dataset.height ?? '0');
      const top = el.dataset.top ?? '';
      // `data-top` reads "seat|kind"; an empty square carries neither.
      const mine = top !== '' && (standing.selfPlay || top[0] === standing.viewerSeat);
      this.apply(clickSquare(this.state, { square, height, mine }), el.dataset.stack ?? '');
    },

    isSource(square: SquareRef): boolean {
      return this.state.source?.square === square;
    },

    bumpLift(delta: number): void {
      this.apply(setLift(this.state, this.state.lift + delta));
    },

    /** Push one stone from a path square to its neighbour, back (-1) or on (+1). */
    shiftDrop(index: number, towards: 1 | -1): void {
      this.apply(moveDrop(this.state, index, towards));
    },

    /**
     * Whether that push would do anything — a square holding its last stone has
     * none to give, and the ends of the path have nowhere to send one. The
     * buttons read this so a dead control looks dead.
     */
    canShiftDrop(index: number, towards: 1 | -1): boolean {
      const neighbour = index + towards;
      if (neighbour < 0 || neighbour >= this.state.path.length) return false;
      return (this.state.path[index]?.drops ?? 0) > 1;
    },

    /** The stones this square receives, or 0 when the path does not cross it. */
    dropsOn(square: SquareRef): number {
      return this.state.path.find((step) => step.square === square)?.drops ?? 0;
    },

    cancel(): void {
      this.apply(clearSelection(this.state));
    },
  };
}
