# The board move builder is a client state machine behind a thin Alpine adapter

The click-to-PTN composer on the game screen is a seat-agnostic state machine module (`web/src/client/move-builder.ts`), tested through its interface, producing PTN text. A thin Alpine adapter owns the DOM and seat rules and renders the result. The no-drift guarantee between builder and server parser is earned by round-trip tests — every composed notation re-parses through core's `parseMove` and re-formats identically via `formatMove` — not by constructing core's branded `Square` client-side. This is the first client build seam: a vite bundle of module + adapter, inlined into the game page like `siteCss()`, with Alpine staying on the CDN.

Status: accepted

## The decision

- **The builder is a state machine, not a script string.** The old `TAK_BOARD_SCRIPT` — a JavaScript string inside `web/src/views.ts` — re-implemented move-shape knowledge (carry-limit clamp, drop spread, direction math) that the core validates, with no test reaching it. It is replaced by a module that owns the interaction state (stone to place, source square, lift count, per-square drops) and derives from it the composed notation, the path squares to highlight with their drop counts, and validity — the invariants (straight-line path, lift ≤ carry limit, lift ≤ stack height, every drop ≥ 1, drops sum = lift) are state invariants, which is exactly what the tests pin.
- **The module is born with ticket 19's interaction model.** Lift-count state, per-square drop adjustment, and capstone-flatten composition land and are tested now, shaped by their next consumer (ticket 19 is ready-for-agent); the HTML controls — the lift stepper, the drop adjusters — remain ticket 19's job. Ticket 19 becomes a pure UI ticket over a tested state machine.
- **Output is PTN text, guaranteed by tests.** The server stays the single validator: players can still hand-type PTN into the field, so the server must remain authoritative either way. The round-trip invariant — `parseMove` succeeds and `formatMove(parsed) === composed` — gives the same no-drift guarantee as composing a core `Move` would, without pulling branded-type construction into the client.
- **The Alpine adapter is thin and owns the view concerns.** It reads `data-square`/`data-height`/`data-top`, applies the seat/ownership rule (`selfPlay || top[0] === viewerSeat` — a view concern per CONTEXT.md's Seat, decided server-side and passed down as config), and only calls the module when allowed. The component name `takBoard` and the `x-data` config injection are preserved, so existing render assertions survive.
- **The first client build seam is inline, not a served file.** The repo deliberately has no static-file serving (ADR-0002's single-process deployment); `/site.css` is an inlined TS string. The bundle follows the same pattern: vite emits a single IIFE, a build step exports it as a TS string, and the game page renders `<script>…</script>` inline. Alpine stays on the CDN.

## Considered options

- **Stateless helpers (`composePlace`, `composeStackMove`) with the state in Alpine** — rejected: ticket 19's interaction (lift stepper, drop adjusters) is a state machine; the helpers would be re-shaped the moment it lands, and the invariant logic would stay in the untestable string.
- **Compose a core `Move` and format via `formatMove`** — rejected: `square()` is exported so it is feasible, but it couples the builder to core's move model and requires branded-type construction client-side, for the same guarantee the round-trip tests provide.
- **Serve the bundle as a file** — deferred: immutable-hash caching is the only gain, and the page is server-rendered per request; the inline seam can switch to a served file later without changing the module.
- **Move all inline Alpine (board, copy button, propose form) into the bundle now** — rejected: scope creep; the copy script is tiny and stable, and the reactivity fork (which runtime owns what on the game screen) is deliberately not decided here.

## Notes for future work

- The exact state-machine surface settles in ticket 21, its first consumer.
- Ticket 19 builds the lift/drop HTML controls on the module. The reactivity fork is resolved by ADR-0007: Alpine is the single client runtime and stays on the CDN, and scripts load per page — this decision does not change that one.
