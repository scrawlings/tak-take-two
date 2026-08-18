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
  stone: StoneKind;
  readonly source: SourceStack | null;
  readonly lift: number;
  readonly liftCeiling: number;
  readonly path: readonly PathStep[];
  apply(next: BuilderState): void;
  cellClick(el: HTMLElement): void;
  bumpLift(delta: number): void;
  bumpDrop(index: number, delta: 1 | -1): void;
  dropsOn(square: SquareRef): number;
  cancel(): void;
}

export function boardComponent(config: BoardConfig): BoardComponent {
  return {
    state: createBuilder(config.size),
    move: '',
    stone: 'flat',

    get source(): SourceStack | null {
      return this.state.source;
    },
    get lift(): number {
      return this.state.lift;
    },
    get liftCeiling(): number {
      return maxLift(this.state);
    },
    get path(): readonly PathStep[] {
      return this.state.path;
    },

    /**
     * Take the builder's next state, and put a composed move in the field.
     * Only a composition writes to the field: picking up a stack composes
     * nothing yet, and blanking what the player typed at that moment would
     * throw away their own work.
     */
    apply(next: BuilderState): void {
      this.state = next;
      if (next.notation !== '') this.move = next.notation;
    },

    cellClick(el: HTMLElement): void {
      if (!config.canMove) return;
      const square = el.dataset.square ?? '';
      const height = Number(el.dataset.height ?? '0');
      const top = el.dataset.top ?? '';
      // `data-top` reads "seat|kind"; an empty square carries neither.
      const mine = top !== '' && (config.selfPlay || top[0] === String(config.viewerSeat));
      this.apply(clickSquare(chooseStone(this.state, this.stone), { square, height, mine }));
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
      this.state = clearSelection(this.state);
      this.move = '';
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('takBoard', boardComponent);
});
