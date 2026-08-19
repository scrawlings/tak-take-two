# 01 — History scrubber: review mode on the game screen

**What to build:** Clicking any move in the history puts the game screen into review mode: the board, reserves, and history highlight show the position after that move; the move form is replaced by a sticky review bar ("Viewing move N of M") with a snap-to-end button; a scrubbed viewer cannot make a move and the UI says so; if it is the viewer's turn at the live position, the bar says the game is waiting on them. New moves streaming in over SSE do not yank the viewer out of review — they stay put with a pulse, and the history list (and its embedded position data) grows. Works for players and spectators, on in-play and finished games. Spec: `.scratch/ui-usability/spec.md`.

**Blocked by:** None — but 02 (keyboard shortcuts) drives the same scrub state, so agree the module's interface before either lands.

**Status:** done

- [x] `GameView.moves` carries the TPS of the position after each move (server-side via core's `stateAfter` + `generateTps`), riding in the moves region so streamed new moves grow the scrub set.
- [x] A tested TPS→board renderer in the client bundle (ADR-0006): given a TPS string, renders the board region's cells (glyphs, heights, stack tips) exactly as the live render does; round-trips against core's `generateTps`/`parseTps` (every TPS the server emits re-parses to the same position).
- [x] Scrub state lives in the stream-surviving scope (ADR-0007) — region swaps from SSE never reset it; the board shows the reviewed position while scrubbed.
- [x] Review mode: clicking a move (or dragging a slider if added) enters review; the move form region is replaced by the review bar; reserves derive from the reviewed position (board count vs. known totals); the history highlights the reviewed move.
- [x] Review bar: "Viewing move N of M", a **snap to end** button, and — when the viewer's turn is live but they are scrubbed — "Your turn — they're waiting on you".
- [x] New-move behaviour: a streamed move while scrubbed keeps the review position, pulses the bar, and grows the history; snap-to-end returns to live.
- [x] Available to spectators of shared games and on finished games (players and spectators alike).
- [x] Tests at the HTTP seam (page contains one TPS per move; review state renders; streamed update while scrubbed keeps the position) and for the renderer module (round-trip, glyphs, heights, stacks).

## Comments

**2026-08-19 — Specified in grilling.** Review mode (form hidden, not disabled) was the user's explicit choice; they added: clarity that you are not viewing the last move, no moves while scrubbed, snap-to-end, and "waiting on you" visibility. Stay-put-on-stream was agreed. Scope: players + spectators, in-play + finished. Notifications were explicitly skipped out of this effort.

**2026-08-19 — Implemented.** `GameView.moves[i].tps` is computed in `gameView` via `stateAfter(record, i+1)` + `generateTps`, reusing the same read path `export`'s TPS uses — this now means `getGame` reads every live move's stored position, not just the last one (`games.test.ts`'s corrupt-record suite was split to say so explicitly: the view touches every snapshot, `applyGame`'s `playMove` still touches only the last).

Client side, `web/src/client/review.ts` is a new pure module (ADR-0006 precedent): a standalone TPS parser (no `@tak/core` import) plus the cell/stack-tip/reserve markup, round-trip tested against core's `generateTps`/`parseTps` in `web/test/review.test.ts`. `board-adapter.ts`'s `takBoard` component absorbed the review state machine (`reviewAt`/`reviewPosition`/`reviewTotal`, `scrubTo`/`snapToEnd`) rather than a separate Alpine component — nesting two Alpine scopes for one DOM region cluster risked scope-chain ambiguity, and the four regions review needs (board, controls, reserves, moves) are exactly the set `takBoard`'s wrapper already needed to grow to cover.

The key design problem was ADR-0007's rule that `board`/`controls` get replaced by every SSE frame regardless of relevance (Alpine's own mutation makes the innerHTML comparison always differ). The fix: every reviewable value (cell glyph/height/stack-tip, reserve counts, the move form vs. review bar) is rendered server-side as **two overlaid spans**, one `x-show="!reviewing"` with the live literal content and one `x-show="reviewing" x-cloak" x-html/x-text="review…(…)"`. Because the swapped-in markup carries the same bindings against the surviving `takBoard` scope, Alpine re-evaluates them immediately on every swap and the reviewed position "wins" without any imperative re-apply step or MutationObserver. `renderGamePage` widened the `takBoard` wrapper div to enclose `reserves` and `moves` (previously only `board`+`controls`) so those regions can reach the same scope.

Each move in the history is now a `<button class="move-link">` carrying its own `data-move-number`/`data-tps`/`data-total` (self-contained, matching `cellClick($el)`'s idiom); `scrubTo($el)` reads them directly, no DOM traversal needed. The review bar's "new move" pulse compares `reviewTotal` (captured at scrub time) against `data-total-moves` on the bar's own element, refreshed every controls render.

Tests: `review.test.ts` (parser + round-trip + markup), `board-adapter.test.ts` (scrub/snap/guard-clicks/pulse, as plain data per the existing precedent), `games.test.ts` (per-move TPS, and the corrupt-record split), `games-http.test.ts` (scrubber markup, review bar, finished-game and spectator access), `stream-http.test.ts` (a streamed move carries its TPS and grows `data-total-moves`). Full suite green (596 tests), typecheck and lint clean, client bundle rebuilt.
