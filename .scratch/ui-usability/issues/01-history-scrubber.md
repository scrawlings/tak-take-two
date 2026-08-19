# 01 — History scrubber: review mode on the game screen

**What to build:** Clicking any move in the history puts the game screen into review mode: the board, reserves, and history highlight show the position after that move; the move form is replaced by a sticky review bar ("Viewing move N of M") with a snap-to-end button; a scrubbed viewer cannot make a move and the UI says so; if it is the viewer's turn at the live position, the bar says the game is waiting on them. New moves streaming in over SSE do not yank the viewer out of review — they stay put with a pulse, and the history list (and its embedded position data) grows. Works for players and spectators, on in-play and finished games. Spec: `.scratch/ui-usability/spec.md`.

**Blocked by:** None — but 02 (keyboard shortcuts) drives the same scrub state, so agree the module's interface before either lands.

**Status:** ready-for-agent

- [ ] `GameView.moves` carries the TPS of the position after each move (server-side via core's `stateAfter` + `generateTps`), riding in the moves region so streamed new moves grow the scrub set.
- [ ] A tested TPS→board renderer in the client bundle (ADR-0006): given a TPS string, renders the board region's cells (glyphs, heights, stack tips) exactly as the live render does; round-trips against core's `generateTps`/`parseTps` (every TPS the server emits re-parses to the same position).
- [ ] Scrub state lives in the stream-surviving scope (ADR-0007) — region swaps from SSE never reset it; the board shows the reviewed position while scrubbed.
- [ ] Review mode: clicking a move (or dragging a slider if added) enters review; the move form region is replaced by the review bar; reserves derive from the reviewed position (board count vs. known totals); the history highlights the reviewed move.
- [ ] Review bar: "Viewing move N of M", a **snap to end** button, and — when the viewer's turn is live but they are scrubbed — "Your turn — they're waiting on you".
- [ ] New-move behaviour: a streamed move while scrubbed keeps the review position, pulses the bar, and grows the history; snap-to-end returns to live.
- [ ] Available to spectators of shared games and on finished games (players and spectators alike).
- [ ] Tests at the HTTP seam (page contains one TPS per move; review state renders; streamed update while scrubbed keeps the position) and for the renderer module (round-trip, glyphs, heights, stacks).

## Comments

**2026-08-19 — Specified in grilling.** Review mode (form hidden, not disabled) was the user's explicit choice; they added: clarity that you are not viewing the last move, no moves while scrubbed, snap-to-end, and "waiting on you" visibility. Stay-put-on-stream was agreed. Scope: players + spectators, in-play + finished. Notifications were explicitly skipped out of this effort.
