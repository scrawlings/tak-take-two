# 14 — Real-time updates

**What to build:** SSE live updates, Alpine-driven — moves stream to participants and spectators in real time, lists refresh live, and the spectator view is gated by share. No datastar (ADR-0007): an SSE route re-renders the streamed regions with the existing view functions and pushes fragments; a small Alpine component on the game screen swaps them; scripts load per page.

**Blocked by:** 11 — Play: game view, moves, finish; 13 — Share, hide, admin delete

**Status:** done

- [x] Participants see moves appear on the game view without a manual refresh.
- [x] Spectators of shared games see moves live; unshared games cannot be watched.
- [x] "My games" and search views reflect state changes without a manual refresh.
- [x] The board and history stay consistent under near-simultaneous updates from both players.
- [x] The shell gains a per-page scripts option; non-interactive pages (login, account, status, admin) ship no client runtime; the game page opts into Alpine.

## Comments

**2026-08-17 — Design note.** ADR-0004 (`docs/adr/0004-game-lifecycle-module.md`) fixes the web Game lifecycle seam: routes are thin adapters over a single Game module behind a command-union interface (`applyGame(gameId, actorId, command)`). Delivery concern — adapt at the routes, over the Game module. Read the ADR before designing.

**2026-08-18 — Design note (ADR-0007).** The reactivity fork is resolved: Datastar (a beta dependency, never invoked, shipped to every page) is dropped; Alpine is the single client runtime. The game screen streams three regions — status line, board, move list — re-rendered by the existing view functions (`renderGameStatus`, `renderBoard`, `renderHistory`) and pushed as SSE fragments; an Alpine component holds the EventSource (auto-reconnecting) and swaps via `x-html`. The click-builder's composition state lives on an `x-data` wrapper the stream never replaces. Spectator streaming is gated at the SSE route by the module's visibility rule (ADR-0003), same as the page. Detail design — fragment shapes, list streams, consistency under simultaneous moves — belongs to this ticket.

**2026-08-19 — Built.**

*The change broker* (`web/src/updates.ts`). A revision per topic, and waiting on it. ADR-0004 keeps the Game module free of events, so this sits beside the routes: `announceGameChanges(games, updates)` wraps the module once, and every successful command publishes `game:<id>` and the shared `games` topic. Wrapping in one place is what keeps fourteen mutating routes from each remembering to publish. Revisions rather than a queue are what makes simultaneous moves safe — a stream that slept through two moves is woken once and reads the position after both, so it can never render a stale board over a fresh one, and can never build a backlog.

*The stream adapter* (`streamPage` in `web/src/app.ts`) — the live twin of `pageAction`. It authorises **before** opening the stream, so a viewer who may not see the page gets a status an EventSource treats as final (404/403) rather than a stream it would reconnect to forever; then, on every change, it re-reads through the Game module and pushes the page's regions as one frame. Re-reading rather than pushing what the command produced is what gates a spectator *per frame*: a share switched off mid-watch ends the stream with a `gone` event, and the client asks the page route for the honest answer.

*Three streams:* `/games/:id/stream`, `/games/stream`, `/games/find/stream` (carrying the same filters the page searched with, so the stream's answer is the page's).

*The client* (`web/src/client/stream.ts`, registered as `takStream`). Finds its regions by `data-region` and **skips any region whose HTML is unchanged** — the first frame is normally byte-identical to what the server just rendered, so connecting touches no DOM at all. That, rather than careful node choice, is what protects a half-composed move.

**Three decisions that amend ADR-0007** (recorded there, not left silent):

- **Five regions, not three.** `renderGameControls` and `renderReserves` joined the status line, board and move list: a move changes them too, and a fresh board beside a stale stone count — or beside a form still saying it is not your turn — is the very inconsistency the stream exists to remove.
- **`data-region` + `innerHTML`, not `x-html`.** `x-ref`/`x-html` binds to the nearest `x-data` root, and the board region deliberately sits *inside* the nested `takBoard` scope so a swap cannot take the composition state with it. The component finds regions under its own root instead — and gets the skip-if-unchanged rule, which `x-html` seeding would not have given.
- **One bundle, one entry.** `web/src/client/index.ts` is now the single place naming the site's Alpine components (`takBoard`, `takStream`); `BOARD_SCRIPT` became `CLIENT_SCRIPT`, and the shell inlines it for the three pages that need it.

**Two things found while building, beyond the checklist:**

- *A stream outlived its session.* Ending every session (ticket 07 — password change, sign-out, block) has to end open streams too, so the session is re-checked before every frame. Nothing leaks in the meantime: an idle stream pushes only contentless heartbeats.
- *A disconnected client left the loop running.* `Readable.pipe` alone does not stop the source when the socket goes away, so `web/src/http-bridge.ts` now destroys the readable on `close`, which cancels the web stream and tells the route to stop rendering frames nobody will read.

**Tests.** `web/test/updates.test.ts` (the broker at its own seam), `web/test/stream.test.ts` (the swap rule as plain data, no browser), `web/test/stream-http.test.ts` (26 tests at the HTTP seam: spectator gating both at connect and mid-watch, the move form and the board's standing arriving with the turn, admin removal, ended sessions, heartbeats, list and search streams, and the region/scope ordering that keeps the click-builder safe), and `web/test/shell.test.ts` extended for the per-page scripts option. Full suite 568 passing; typecheck and lint clean.

**Docs.** ADR-0007 amended; `docs/design.md` and `AGENTS.md` no longer describe Datastar; README status updated (this was the last of the 21 tickets).

**2026-08-19 — Review.** `/code-review` on both axes. One real defect and several corrections:

- **The click-builder went inert after a live update** (spec axis, the serious one). `canMove`, `viewerSeat` and `selfPlay` sat in the `takBoard` `x-data` config — which the stream deliberately never replaces — so they froze at page load. When the opponent moved, the streamed `controls` region swapped in the move form while the board carried on refusing every click, and the click-builder is the *primary* move-entry path. The standing moved onto the streamed `.board` element (`data-can-move`/`data-viewer-seat`/`data-self-play`), read on each click; the config now holds only the board's size, so nothing mutable remains in the never-replaced scope. Pinned at both seams: `board-adapter.test.ts` drives a board that becomes playable mid-page, and `stream-http.test.ts` asserts the standing flips in the streamed region. ADR-0007 gained the general rule.
- **`streamPage` re-derived `pageAction`'s branching** (standards axis, hard). `actions.ts` says routes never re-derive forbidden → 403 / internal → 500 + log. It now *is* `pageAction` — the authorising read is its `load`, opening the stream is its `render`.
- **Two claims in the ADR amendment were false.** "The one place that names the site's Alpine components" ignored the export page's inline `takCopy`. Worse, "connecting touches no DOM at all" was wrong: Alpine rewrites the nodes it binds on init, so the board and controls regions no longer match the server string and *are* replaced on the first frame. The skip is real but only spares the directive-free regions; what protects a half-composed move is scope placement, exactly as ADR-0007 always said. Corrected in the ADR and in `stream.ts`.
- **Smaller:** `changedGame` made an exhaustive switch on the command union (ADR-0001) instead of an `'gameId' in command` test with an unreachable branch; the find-page filters read once by `proposalSearch` rather than parsed in both the page and stream routes, with `isFiltered` the single statement of "the search was narrowed" (the two had already drifted apart); `stream.ts` uses `HTMLElement`/`EventSource` like its sibling adapter rather than inventing structural types; the `myGamesRegions(...).games` middle-man replaced with a plain table builder; a note recording why `renderGameManagement` is deliberately *not* a region; account and admin pages now pinned as shipping no client runtime, rather than trusting the default.

Left as-is with reasons: the broker and its `Games` decorator share `updates.ts` (two halves of one job — how a change reaches the streams); the filter-shape data clump spans `ProposedSearch`/`SearchFilters`, which is pre-existing structure this ticket only reads.
