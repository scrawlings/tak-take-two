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
import { cellContent, parseReviewPosition, reserveAt, stackTipContent } from './review.js';
import type { ReviewPosition } from './review.js';
import { resolveShortcut, stepReview } from './shortcuts.js';
import type { FocusTarget, ShortcutKey } from './shortcuts.js';

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

/**
 * The parts of a keyboard event and its target `handleKey` reads (ticket 02).
 * A plain shape, not `KeyboardEvent`, so a test can drive it without a DOM —
 * the same reasoning `BoardStanding` and the cell helpers already follow.
 */
export interface KeyEvent extends ShortcutKey {
  readonly target: FocusTarget | null;
  preventDefault(): void;
}

export interface BoardComponent {
  state: BuilderState;
  /** Bound to the move field with `x-model`, so a player may still type over it. */
  move: string;
  /** The source square's glyphs, bottom to top, read from the DOM at pickup. */
  sourceStack: string;
  /** The move number reviewed, or null while showing the live position. */
  reviewAt: number | null;
  /** The parsed position at `reviewAt`, or null while not reviewing. */
  reviewPosition: ReviewPosition | null;
  /** The move count at the moment review started, so a streamed move can be noticed. */
  reviewTotal: number | null;
  /** Whether the shortcuts help panel is open. */
  helpVisible: boolean;
  /** Alpine's root element, injected by Alpine itself — the wrapper `handleKey`'s
   *  DOM lookups (move links, the move and take-back forms) search within. */
  $root?: HTMLElement;
  readonly stone: StoneKind;
  readonly source: SourceStack | null;
  readonly sourceSquare: string;
  readonly lift: number;
  /** The bounds of the lift stepper, so a disabled button and a refused transition agree. */
  readonly liftCeiling: number;
  readonly liftFloor: number;
  readonly path: readonly PathStep[];
  readonly partition: string;
  /** Whether the game screen is showing an earlier move rather than the live position. */
  readonly reviewing: boolean;
  apply(next: BuilderState, pickedUpStack?: string): void;
  pick(stone: StoneKind): void;
  cellClick(el: HTMLElement): void;
  isSource(square: SquareRef): boolean;
  bumpLift(delta: number): void;
  shiftDrop(index: number, towards: 1 | -1): void;
  canShiftDrop(index: number, towards: 1 | -1): boolean;
  dropsOn(square: SquareRef): number;
  cancel(): void;
  /** Enter review at the move a history click named, reading its `data-move-number`/`data-tps`/`data-total`. */
  scrubTo(el: HTMLElement): void;
  /** Leave review and show the live position again. */
  snapToEnd(): void;
  /** The reviewed glyph and height marker for a square, or '' while not reviewing. */
  reviewCell(square: SquareRef): string;
  /** The reviewed stack-tip markup for a square, or '' while not reviewing. */
  reviewStackTip(square: SquareRef): string;
  /** A seat's reviewed reserve count, or '' while not reviewing. */
  reviewReserve(seat: 1 | 2, kind: 'stones' | 'capstones'): string;
  /** Whether a move has streamed in since review started, read off `data-total-moves`. */
  newMoveWhileReviewing(el: HTMLElement): boolean;
  /** Toggle the shortcuts help panel. */
  toggleHelp(): void;
  /** The history's move-link elements, in move order. */
  moveLinks(): HTMLElement[];
  /** Step the scrubber one move back (-1) or forward (1); see `handleKey` for the boundary rules. */
  step(delta: -1 | 1): void;
  /** Submit the form whose action ends with `suffix` — the same submit its own button performs. */
  submitForm(suffix: string): void;
  /** Resolve a keystroke to a shortcut and perform the same affordance a click would (ticket 02). */
  handleKey(event: KeyEvent): void;
}

export function boardComponent(config: BoardConfig): BoardComponent {
  return {
    state: createBuilder(config.size),
    move: '',
    sourceStack: '',
    reviewAt: null,
    reviewPosition: null,
    reviewTotal: null,
    helpVisible: false,
    $root: undefined,

    get reviewing(): boolean {
      return this.reviewAt !== null;
    },

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
      if (this.reviewing) return; // no move can be composed while showing an earlier position
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

    /**
     * Enter review at the move a history click named. The element carries its
     * own `data-move-number`, `data-tps` and `data-total` (the move count as
     * of that render) rather than this reading some ancestor's — the same
     * self-contained-element idiom `cellClick` uses, and it means a move
     * clicked from a page that has since grown still records the total *as
     * of the click*, which is what `newMoveWhileReviewing` compares against.
     * Any in-progress composition is dropped: a scrubbed board shows no path.
     */
    scrubTo(el: HTMLElement): void {
      const number = Number(el.dataset.moveNumber ?? '');
      const position = parseReviewPosition(el.dataset.tps ?? '');
      if (!Number.isInteger(number) || position === null) return;
      this.reviewAt = number;
      this.reviewPosition = position;
      this.reviewTotal = Number(el.dataset.total ?? number);
      this.apply(clearSelection(this.state));
    },

    /** Leave review and show the live position again. */
    snapToEnd(): void {
      this.reviewAt = null;
      this.reviewPosition = null;
      this.reviewTotal = null;
    },

    reviewCell(square: SquareRef): string {
      return this.reviewPosition === null ? '' : cellContent(this.reviewPosition, square);
    },

    reviewStackTip(square: SquareRef): string {
      return this.reviewPosition === null ? '' : stackTipContent(this.reviewPosition, square);
    },

    reviewReserve(seat: 1 | 2, kind: 'stones' | 'capstones'): string {
      return this.reviewPosition === null ? '' : String(reserveAt(this.reviewPosition, seat, kind));
    },

    /** A move has streamed in since `scrubTo` recorded the total moves then. */
    newMoveWhileReviewing(el: HTMLElement): boolean {
      if (!this.reviewing || this.reviewTotal === null) return false;
      return Number(el.dataset.totalMoves ?? '0') > this.reviewTotal;
    },

    toggleHelp(): void {
      this.helpVisible = !this.helpVisible;
    },

    /**
     * The history's move-link elements, in move order, so `step` can index
     * straight to the one it wants and hand it to `scrubTo` — the same
     * element a click would have carried, just found instead of clicked.
     */
    moveLinks(): HTMLElement[] {
      return Array.from(this.$root?.querySelectorAll<HTMLElement>('.move-link') ?? []);
    },

    /**
     * `[` / `]`: step the scrubber. The boundary rule itself — where "the
     * start" and "live" fall — is pure index arithmetic in `stepReview`
     * (ADR-0006); this only turns its answer into DOM: find the move-link
     * for the target move number and hand it to `scrubTo`, the same element
     * a click would have carried.
     */
    step(delta: -1 | 1): void {
      const links = this.moveLinks();
      const result = stepReview(this.reviewAt, links.length, delta);
      if (result.kind === 'noop') return;
      if (result.kind === 'live') {
        this.snapToEnd();
        return;
      }
      const el = links[result.move - 1];
      if (el) this.scrubTo(el);
    },

    /**
     * Find the form whose action ends with `suffix` and submit it — the same
     * submit its own button performs. A take-back form absent because none
     * may currently be offered, or a move form hidden by review, means
     * nothing matches, so this is a no-op rather than a special case.
     */
    submitForm(suffix: string): void {
      this.$root?.querySelector<HTMLFormElement>(`form[action$="${suffix}"]`)?.requestSubmit();
    },

    handleKey(event: KeyEvent): void {
      const action = resolveShortcut(event, event.target);
      if (action === null) return;
      event.preventDefault();
      switch (action) {
        case 'help':
          this.toggleHelp();
          break;
        case 'cancel':
          if (this.reviewing) this.snapToEnd();
          else this.cancel();
          break;
        case 'back':
          this.step(-1);
          break;
        case 'forward':
          this.step(1);
          break;
        case 'play':
          if (!this.reviewing) this.submitForm('/move');
          break;
        case 'takeback':
          this.submitForm('/take-back');
          break;
      }
    },
  };
}
