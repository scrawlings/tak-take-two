/**
 * The board's markup contract — every string that crosses the seam between the
 * server-rendered pages (`views.ts`) and the bundled client (`web/src/client/`,
 * ADR-0006/ADR-0007): attribute names, the selectors and dataset keys derived
 * from them, the value encodings both sides write, and the Alpine vocabulary
 * the markup calls. Before this module, each name was a string literal on both
 * sides of the seam, so renaming one side compiled clean and broke at runtime,
 * pinned only by a few HTTP assertions — the same bug class ADR-0008 fixed for
 * list filters, here on the harder bundle seam. With both sides importing the
 * same constants, a rename is a compile error on the side that missed it.
 *
 * This module is deliberately pure: no DOM, no node — the server tsconfig
 * omits the DOM lib and the client tsconfig omits the node types, and both
 * must accept this file (the client bundle inlines it via vite, the server
 * imports it directly). It is also a source of the client bundle: the
 * fingerprint test (ADR-0006) fails if it changes without a rebuild.
 */

/** A data- attribute the server emits and the client reads. */
export const SQUARE_ATTR = 'data-square';
export const HEIGHT_ATTR = 'data-height';
export const TOP_ATTR = 'data-top';
export const STACK_ATTR = 'data-stack';
export const CAN_MOVE_ATTR = 'data-can-move';
export const VIEWER_SEAT_ATTR = 'data-viewer-seat';
export const SELF_PLAY_ATTR = 'data-self-play';
export const MOVE_NUMBER_ATTR = 'data-move-number';
export const TPS_ATTR = 'data-tps';
export const TOTAL_ATTR = 'data-total';
export const TOTAL_MOVES_ATTR = 'data-total-moves';
export const REGION_ATTR = 'data-region';

/**
 * The dataset key for a data- attribute — `data-can-move` → `canMove`. The
 * client reads `el.dataset[key]`; the server emits `data-...` attributes. One
 * implementation of the kebab→camel rule, so the two forms can never drift.
 */
export function datasetKey(attr: string): string {
  const name = attr.slice('data-'.length);
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * The attribute selector for a data- attribute — `data-region` → `[data-region]`.
 * The client matches regions generically by this selector; the server emits
 * the attribute. Derived here, beside `datasetKey`, for the same reason.
 */
export function attributeSelector(attr: string): string {
  return `[${attr}]`;
}

/** A class name the server emits and the client selects by. */
export const BOARD_CLASS = 'board';
export const MOVE_LINK_CLASS = 'move-link';

/**
 * The value encodings the board's attributes carry. Both sides write/read
 * these literals: the boolean flags are `'1'`/`'0'` because they ride in
 * attributes, and `data-top` reads "seat|kind", split client-side on the
 * separator.
 */
export const FLAG_ON = '1';
export const FLAG_OFF = '0';
export const TOP_SEPARATOR = '|';

/**
 * The action-path suffixes the shortcuts submit by (`form[action$="..."]`).
 * The server emits `action="/games/${id}/move"`; the client matches the tail.
 */
export const MOVE_ACTION_SUFFIX = '/move';
export const TAKE_BACK_ACTION_SUFFIX = '/take-back';

/** The Alpine component names — registered by the bundle, invoked by the markup. */
export const COMPONENTS = {
  board: 'takBoard',
  stream: 'takStream',
} as const;

/**
 * The methods the server-rendered markup calls on the `takBoard` scope, by
 * name. The adapter's methods stay literal keys (for `this.` binding); the
 * markup interpolates these constants; a guard test pins the two together.
 */
export const METHODS = {
  cellClick: 'cellClick',
  isSource: 'isSource',
  pick: 'pick',
  bumpLift: 'bumpLift',
  shiftDrop: 'shiftDrop',
  canShiftDrop: 'canShiftDrop',
  dropsOn: 'dropsOn',
  cancel: 'cancel',
  scrubTo: 'scrubTo',
  snapToEnd: 'snapToEnd',
  reviewCell: 'reviewCell',
  reviewStackTip: 'reviewStackTip',
  reviewReserve: 'reviewReserve',
  newMoveWhileReviewing: 'newMoveWhileReviewing',
  toggleHelp: 'toggleHelp',
  handleKey: 'handleKey',
} as const;

/** The state property the move field binds to (`x-model="move"`). */
export const MOVE_MODEL = 'move';

/**
 * The board glyphs (candidate 5's web-side half): one table for both the
 * server's live board (`views.ts`) and the bundle's review renderer
 * (`review.ts`), which previously duplicated it with a "matches exactly"
 * comment. P1 fills; P2 outlines. The kind union mirrors core's `StoneKind`
 * without importing it — this module stays dependency-free so both tsconfigs
 * and the bundle accept it.
 */
export type GlyphStoneKind = 'flat' | 'standing' | 'capstone';

export const STONE_GLYPH: Readonly<Record<1 | 2, Readonly<Record<GlyphStoneKind, string>>>> = {
  1: { flat: '●', standing: '▲', capstone: '■' },
  2: { flat: '○', standing: '△', capstone: '□' },
};

/** The board glyph for one stone, from the shared table. */
export function stoneGlyph(player: 1 | 2, kind: GlyphStoneKind): string {
  return STONE_GLYPH[player][kind];
}

/**
 * What the game page tells the board once, and what it tells the stream. Both
 * are typed here so the server's emission (`boardConfig`/`streamConfig`) is
 * checked against the shape the client reads — the one contract that is a
 * shape rather than a string.
 */
export interface BoardConfig {
  readonly size: number;
}

export interface StreamConfig {
  readonly url: string;
}
