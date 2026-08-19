/**
 * The key → action mapping and focus guard for the game screen's shortcuts
 * (ticket 02, ADR-0006): a pure module, tested through its interface, no DOM
 * beyond the duck-typed shapes below. The Alpine adapter (`board-adapter.ts`)
 * owns turning an action into the same affordance a click already performs —
 * this module only decides *which* action a keystroke means, if any.
 */

export type ShortcutAction = 'play' | 'back' | 'forward' | 'takeback' | 'cancel' | 'help';

/** The parts of `KeyboardEvent` this module reads — a test can hand a plain object. */
export interface ShortcutKey {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
}

/** The parts of the focused element this module reads. */
export interface FocusTarget {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
}

const BINDINGS: Readonly<Record<string, ShortcutAction>> = {
  Enter: 'play',
  '[': 'back',
  ']': 'forward',
  u: 'takeback',
  Escape: 'cancel',
  '?': 'help',
};

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** Whether typing here should never be intercepted — an input, a textarea, a select, or contenteditable. */
export function isTypingTarget(target: FocusTarget | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return TYPING_TAGS.has((target.tagName ?? '').toUpperCase());
}

/**
 * The shortcut a keystroke means, or null when it is not one of the game
 * screen's bindings, a modified chord (so browser/OS shortcuts are left
 * alone), or typed while focus is somewhere PTN entry needs the plain key.
 */
export function resolveShortcut(event: ShortcutKey, target: FocusTarget | null | undefined): ShortcutAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (isTypingTarget(target)) return null;
  return BINDINGS[event.key] ?? null;
}

/** What `[` / `]` should do next: move to a numbered position, snap to live, or nothing. */
export type StepResult = { readonly kind: 'goto'; readonly move: number } | { readonly kind: 'live' } | { readonly kind: 'noop' };

/**
 * The `[` / `]` boundary rule (ticket 02), as pure index arithmetic — no DOM,
 * so the "at the start" / "at live" edges pin directly against numbers rather
 * than through mocked elements. `reviewAt` is the move currently reviewed, or
 * null while live; `total` is how many moves the history holds.
 *
 * Backing up from live lands on the *last* move — exactly what clicking it
 * would do — so every further `back` is a genuine step earlier, and running
 * past move 1 is the no-op ("the start"). `forward` from the last reviewed
 * move goes live (that position and live are the same one); `forward` while
 * already live has nothing beyond it, which is the other no-op.
 */
export function stepReview(reviewAt: number | null, total: number, delta: -1 | 1): StepResult {
  if (total === 0) return { kind: 'noop' };
  if (delta < 0) {
    const target = (reviewAt ?? total + 1) - 1;
    return target < 1 ? { kind: 'noop' } : { kind: 'goto', move: target };
  }
  if (reviewAt === null) return { kind: 'noop' };
  const target = reviewAt + 1;
  return target > total ? { kind: 'live' } : { kind: 'goto', move: target };
}
