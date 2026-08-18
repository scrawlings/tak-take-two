# 21 — The board move builder becomes a tested client module

**What to build:** The click-to-PTN composer on the game screen moves out of a JavaScript string inside `views.ts` into a seat-agnostic state machine module (`web/src/client/move-builder.ts`), tested through its interface, with a thin Alpine adapter over it. This is the first client build seam: a vite bundle of module + adapter, inlined into the game page like `siteCss()`. The ticket-19 interaction model (lift control, drop adjustment, capstone flatten) is born in the module now, tested; the HTML controls stay in ticket 19.

**Blocked by:** 11 — Play: game view, moves, finish; 18 — Self-play in one window

**Status:** done

- [x] `web/src/client/move-builder.ts` — the state machine: interaction state (stone to place, source square, lift count, per-square drops) in; composed PTN notation, path highlights with drop counts, and validity out. Invariants: straight-line path, lift ≤ carry limit, lift ≤ stack height, every drop ≥ 1, drops sum = lift. Seat-agnostic — no seat data in the module.
- [x] Ticket-19 interaction model born here: lift-count state, per-square drop-adjustment state, capstone-flatten composition — tested now; the stepper and drop-adjuster HTML stay in ticket 19.
- [x] `web/src/client/board-adapter.ts` — thin Alpine adapter: registers `Alpine.data('takBoard', …)` (component name and `x-data` config injection preserved — `games-http.test.ts:566` pins both), reads `data-square`/`data-height`/`data-top`, applies the ownership rule (`selfPlay || top[0] === viewerSeat`) before calling the module.
- [x] First client build seam: vite bundles module + adapter to a single IIFE; a build step emits it as a TS string; `renderGamePage` inlines `<script>…</script>` on the game page only, mirroring `siteCss()`. Alpine stays on the CDN.
- [x] `TAK_BOARD_SCRIPT` deleted from `web/src/views.ts`; `renderBoard` and the board markup unchanged.
- [x] Tests (`web/test/board-builder.test.ts`): flagship round-trip — `parseMove` succeeds and `formatMove(parsed) === composed` for every composed notation; transitions (place, pick source, straight-line path, non-straight rejected, cancel, capstone flatten); the lift/drop invariants including drop-adjustment steps.
- [x] Existing tests stay green: `shell.test.ts:25` (Alpine CDN), `games-http.test.ts:564` (board markup), `:566` (`takBoard` name + config).
- [x] No CONTEXT.md change (the builder is mechanics); ADR-0006 cross-reference.

## Comments

**2026-08-18 — Design note.** From the architecture review (opportunity: give the board click-builder a real module) and the grilling rounds. Read ADR-0006 (`docs/adr/0006-board-move-builder.md`) before designing.

- **The old script was untestable text, and ticket 19 was going to grow it.** `TAK_BOARD_SCRIPT` re-implemented move-shape knowledge (carry-limit clamp, drop spread, direction) that the core validates, with zero tests reaching it; ticket 19 (interactive stack moves, ready-for-agent) planned to extend exactly that string into a lift stepper and drop adjusters.
- **The module is a state machine because 19's interaction is state.** Lift counts and per-square drops are interaction state, and the invariants they must keep (every drop ≥ 1, sum = lift, lift ≤ carry limit) are state invariants — the interface is the test surface, and the tests pin them.
- **No-drift guarantee via round-trip, not construction.** Every composed notation re-parses through core's `parseMove` and re-formats identically via `formatMove`; the server stays the single validator (players can still hand-type PTN).
- **Seat logic stays in the adapter.** CONTEXT.md's Seat is a view concern — the Game module decides `canMove`/`viewerSeat`/`selfPlay` and the view passes them as config; the adapter applies the ownership rule and keeps the module seat-free.
- **Inline bundle, not a served file.** The repo has no static serving (ADR-0002 single-process) and `/site.css` is already an inlined TS string; the bundle follows that pattern, game-page-only. Alpine stays on the CDN; the reactivity fork (which runtime owns what on the game screen) is deliberately not decided by this ticket.
- **What ticket 19 becomes:** a pure UI ticket — the stepper and drop adjusters wire to the born state machine, plus the path-square highlighting it already derives.

**2026-08-18 — Implemented.** `web/src/client/move-builder.ts` is the state machine (pure data in, composed PTN out); `web/src/client/board-adapter.ts` is the Alpine adapter that owns the DOM and the seat rule. `npm run build:client` bundles the pair to an IIFE and emits `web/src/client-script.generated.ts`, which `renderGamePage` inlines. 28 tests in `web/test/board-builder.test.ts`.

Decisions worth carrying forward:

- **The generated bundle is committed**, so tests, typecheck and `npm run dev` never need a build step. The failure mode that buys — editing `src/client/` and forgetting to rebuild, silently serving yesterday's script — is closed by a fingerprint: the build records a hash of the client sources and a test recomputes it. `AGENTS.md` names the workflow.
- **`stone` stays a plain component field**, not builder state, because `games-http.test.ts` pins `x-on:click="stone = 'flat'"` in the markup. The adapter folds it into the module at click time, so the module still owns composition.
- **Only a composition writes to the move field.** Picking up a stack composes nothing yet, and blanking the field at that moment would throw away notation the player typed by hand.
- **`source.sq` became `source.square`** in the two templates that read it, matching the module's vocabulary.
- **The path is refused, not shortened, when it is longer than the hand** — a click that cannot mean a legal shape means nothing, rather than a shape the player did not ask for.
- **Adjusting a drop moves exactly one stone**, taken from (or given back to) the last square that can spare it; an adjustment no square can pay for is refused rather than half-applied. That keeps both invariants — every square ≥ 1, drops sum to the lift — true after every step, which is what the round-trip test relies on.

**2026-08-18 — Review.** The staleness guard grew to cover `vite.client.config.ts` (changing the build target changes the bundle without touching a module), to walk subdirectories, and to delimit each entry so two different file lists cannot hash alike. `client-fingerprint.ts` moved to `web/scripts/`, beside its only other consumer. The comment claiming the bundle "travels in the HTML like `siteCss()` does" was wrong in its comparison — the stylesheet is served from `/site.css` — and now says what is actually true: it travels inside the HTML rather than as its own request.

The adapter is no longer untested: guarding the `alpine:init` registration behind a `document` check makes `boardComponent` importable, and `web/test/board-adapter.test.ts` drives it as plain data (12 tests: the seat rule, the move field, and every value the templates bind to). It is typechecked by `tsconfig.client.json`, which owns the DOM half of the app.
