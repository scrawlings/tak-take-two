/**
 * The Alpine adapter over the move builder (ADR-0006): it owns the DOM and the
 * seat rule, the module owns the move. Registering `takBoard` keeps the
 * component name and the `x-data` config the game page already renders.
 *
 * The seat rule lives here because whose stack a square holds is a view
 * concern (CONTEXT.md: Seat) that the Game module decided server-side and
 * passed down as config; the builder itself never learns about seats.
 */

import {
  adjustDrop,
  chooseStone,
  clearSelection,
  clickSquare,
  createBuilder,
  maxLift,
  setLift,
} from './move-builder.js';
import type { BuilderState, PathStep, SourceStack, SquareRef, StoneKind } from './move-builder.js';

/** What the game page tells the board about the viewer and the game. */
export interface BoardConfig {
  readonly canMove: boolean;
  readonly viewerSeat: number | null;
  readonly size: number;
  readonly selfPlay: boolean;
}

interface AlpineGlobal {
  data(name: string, factory: (config: BoardConfig) => object): void;
}

declare const Alpine: AlpineGlobal;

interface BoardComponent {
  state: BuilderState;
  /** Bound to the move field with `x-model`, so a player may still type over it. */
  move: string;
  readonly stone: StoneKind;
  readonly source: SourceStack | null;
  readonly sourceSquare: string;
  readonly lift: number;
  /** The bounds of the lift stepper, so a disabled button and a refused transition agree. */
  readonly liftCeiling: number;
  readonly liftFloor: number;
  readonly path: readonly PathStep[];
  apply(next: BuilderState): void;
  pick(stone: StoneKind): void;
  cellClick(el: HTMLElement): void;
  isSource(square: SquareRef): boolean;
  bumpLift(delta: number): void;
  bumpDrop(index: number, delta: 1 | -1): void;
  dropsOn(square: SquareRef): number;
  cancel(): void;
}

export function boardComponent(config: BoardConfig): BoardComponent {
  return {
    state: createBuilder(config.size),
    move: '',

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
     * Take the builder's next state and keep the move field in step. A
     * composition fills the field; putting the stack back down empties it,
     * because a cleared board that still offers the old move to Play is a trap.
     * Nothing else writes to the field: picking a stack up composes nothing
     * yet, and blanking it then would throw away what the player typed.
     */
    apply(next: BuilderState): void {
      const putBack = this.state.source !== null && next.source === null;
      this.state = next;
      if (next.notation !== '') this.move = next.notation;
      else if (putBack) this.move = '';
    },

    pick(stone: StoneKind): void {
      this.state = chooseStone(this.state, stone);
    },

    cellClick(el: HTMLElement): void {
      if (!config.canMove) return;
      const square = el.dataset.square ?? '';
      const height = Number(el.dataset.height ?? '0');
      const top = el.dataset.top ?? '';
      // `data-top` reads "seat|kind"; an empty square carries neither.
      const mine = top !== '' && (config.selfPlay || top[0] === String(config.viewerSeat));
      this.apply(clickSquare(this.state, { square, height, mine }));
    },

    isSource(square: SquareRef): boolean {
      return this.state.source?.square === square;
    },

    bumpLift(delta: number): void {
      this.apply(setLift(this.state, this.state.lift + delta));
    },

    bumpDrop(index: number, delta: 1 | -1): void {
      this.apply(adjustDrop(this.state, index, delta));
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

// Guarded so the component can be imported and driven by a test: this module
// is a browser bundle, but its behaviour is ordinary data and worth pinning.
if (typeof document !== 'undefined') {
  document.addEventListener('alpine:init', () => {
    Alpine.data('takBoard', boardComponent);
  });
}
