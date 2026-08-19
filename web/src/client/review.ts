/**
 * Review mode's position renderer (ticket 01, ADR-0006): a small, pure TPS
 * parser and the cell/reserve markup it feeds. The board region already
 * renders every square's live glyphs server-side; this module produces the
 * same markup for an earlier position so the Alpine adapter can show it
 * instead while the viewer is scrubbed.
 *
 * It never imports `@tak/core` — like the move builder, it stays a standalone
 * module the browser bundle can carry cheaply. The no-drift guarantee comes
 * from round-trip tests against core's `generateTps`/`parseTps`, not from
 * sharing code with it.
 */

export type StoneKind = 'flat' | 'standing' | 'capstone';

export interface ReviewStone {
  readonly player: 1 | 2;
  readonly kind: StoneKind;
}

/** A square's stack, bottom to top — empty means no stones there. */
export type ReviewStack = readonly ReviewStone[];

export interface ReviewReserve {
  readonly stones: number;
  readonly capstones: number;
}

/** A position the scrubber can render: one board, one reserve count per seat. */
export interface ReviewPosition {
  readonly size: number;
  readonly stacks: Readonly<Record<string, ReviewStack>>;
  readonly reserves: Readonly<Record<1 | 2, ReviewReserve>>;
}

const FILES = 'abcdef';

/** Each player's starting reserve for a board size — mirrors core's `initialReserve`. */
const INITIAL_RESERVE: Readonly<Record<number, ReviewReserve>> = {
  5: { stones: 21, capstones: 1 },
  6: { stones: 30, capstones: 1 },
};

/** One TPS cell: a run of empty squares, or a stack bottom to top. */
function parseCell(cell: string): { readonly empties: number } | { readonly stack: ReviewStack } | null {
  const run = /^x([1-9]\d*)?$/.exec(cell);
  if (run !== null) return { empties: run[1] === undefined ? 1 : Number(run[1]) };

  const stack = /^([12]+)([SC]?)$/.exec(cell);
  if (stack === null) return null;
  const stones: ReviewStone[] = [...stack[1]!].map((ch) => ({
    player: ch === '1' ? 1 : 2,
    kind: 'flat' as const,
  }));
  const top = stack[2];
  if (top === 'S' || top === 'C') {
    const last = stones[stones.length - 1]!;
    stones[stones.length - 1] = { player: last.player, kind: top === 'S' ? 'standing' : 'capstone' };
  }
  return { stack: stones };
}

/**
 * Parse a TPS string into a reviewable position, or null when it does not
 * parse. Every TPS this module is fed is server-emitted (round-trip tested
 * against core), so null only guards a scrub click against data that somehow
 * failed to reach the page intact — it never fires in practice.
 */
export function parseReviewPosition(text: string): ReviewPosition | null {
  const fields = text.trim().split(/\s+/).filter((t) => t.length > 0);
  if (fields.length !== 3) return null;
  const [boardText, turnText, moveText] = fields as [string, string, string];
  if (!/^[12]$/.test(turnText)) return null;
  if (!/^[1-9]\d*$/.test(moveText)) return null;

  const rows = boardText.split('/');
  if (rows.length !== 5 && rows.length !== 6) return null;
  const size = rows.length;
  const reserve = INITIAL_RESERVE[size]!;

  const stacks: Record<string, ReviewStack> = {};
  const counts: Record<1 | 2, { stones: number; capstones: number }> = {
    1: { stones: 0, capstones: 0 },
    2: { stones: 0, capstones: 0 },
  };

  for (let r = 0; r < rows.length; r++) {
    const rank = size - r;
    let fi = 0;
    for (const cellText of rows[r]!.split(',')) {
      const cell = parseCell(cellText);
      if (cell === null) return null;
      if ('empties' in cell) {
        fi += cell.empties;
        continue;
      }
      if (fi >= size) return null;
      stacks[`${FILES[fi]}${rank}`] = cell.stack;
      for (const stone of cell.stack) {
        if (stone.kind === 'capstone') counts[stone.player].capstones++;
        else counts[stone.player].stones++;
      }
      fi++;
    }
    if (fi !== size) return null;
  }

  return {
    size,
    stacks,
    reserves: {
      1: { stones: reserve.stones - counts[1].stones, capstones: reserve.capstones - counts[1].capstones },
      2: { stones: reserve.stones - counts[2].stones, capstones: reserve.capstones - counts[2].capstones },
    },
  };
}

const GLYPH: Readonly<Record<1 | 2, Readonly<Record<StoneKind, string>>>> = {
  1: { flat: '●', standing: '▲', capstone: '■' },
  2: { flat: '○', standing: '△', capstone: '□' },
};

/** The board glyph for one stone — matches `views.ts`'s `stoneGlyph` exactly. */
export function stoneGlyph(stone: ReviewStone): string {
  return GLYPH[stone.player][stone.kind];
}

/** A square's stack in this position, or empty when nothing is there. */
function stackAt(position: ReviewPosition, square: string): ReviewStack {
  return position.stacks[square] ?? [];
}

/** The cell's glyph and height marker, matching the server's `renderBoard` cell markup. */
export function cellContent(position: ReviewPosition, square: string): string {
  const stack = stackAt(position, square);
  const top = stack[stack.length - 1];
  const glyph = top === undefined ? '·' : stoneGlyph(top);
  const height = stack.length > 1 ? `<span class="cell-height">${stack.length}</span>` : '';
  return `${glyph}${height}`;
}

/** The hover stack-tip markup for a square, or '' when it holds nothing. */
export function stackTipContent(position: ReviewPosition, square: string): string {
  const stack = stackAt(position, square);
  if (stack.length === 0) return '';
  return `<span class="stack-tip">${[...stack]
    .reverse()
    .map((s) => `<span>${stoneGlyph(s)}</span>`)
    .join('')}</span>`;
}

/** One seat's remaining stones or capstones in this position. */
export function reserveAt(position: ReviewPosition, seat: 1 | 2, kind: keyof ReviewReserve): number {
  return position.reserves[seat][kind];
}
