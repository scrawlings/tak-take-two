# Render functions are tested directly, and split one module per screen family

`web/src/views.ts` (1,270 lines) was the repo's top-churn file — 30 of the last 40 commits touched it — and no test imported it. Its 25 exported render functions are pure `GameView -> string` and `GameSummary -> string`, yet the only way to assert on their output was `games-http.test.ts` (1,488 lines, 199 `toContain` assertions), so asserting that a board renders 5×5 cost an in-memory SQLite database, a migration run, two created users, two sign-ins, a proposed game and a join. The rendering seam existed; nothing reached it.

Status: accepted

## The decision

- **The render functions get their own tests, called with hand-built views.** `web/test/game-screen.test.ts` and `web/test/game-lists.test.ts` construct a `GameView`/`GameSummary` literal (one builder each, overridden per test) and call `gameRegions`, `renderGamePage`, `myGamesRegions`, `findGamesRegions` and the two page functions directly. No database, no HTTP, no fixtures with a lifecycle.
- **`views.ts` splits by screen family, along the seam that was already there.** Each screen was already a page function plus a regions function over shared row/section helpers; the split follows that boundary rather than a line count:
  - `web/src/game-screen.ts` — the game screen (board, status, controls, review bar, reserves, history, visibility) plus the export and not-found pages it links to.
  - `web/src/game-lists.ts` — "Your games" and "Find a game", which share their row markup (one status tag, one opponent cell, one action group) and differ only in the search around it.
  - `web/src/views.ts` — the front page, the sign-in and account screens, and the two admin screens: the pages that barely change.
- **The page furniture moves to `html.ts`.** `Regions`, `region` and `streamed` are what every streamed screen needs and no screen family owns, so they join `escapeHtml`, `renderShell` and `breadcrumb` — the module that was already the shared markup vocabulary. `html.ts` gains one import (`contract.js`, for the stream component's name); no new file exists to hold three functions.
- **HTTP keeps the route, not the markup.** `games-http.test.ts` still proves a page is reachable, addressed to the right game, and drawn for the right viewer — status codes, redirects, refusals, and the share-then-spectate path that only a real database produces. Assertions that only restated what a render function does with a decided view (the stack-move builder's controls, the review bar's markup, the shortcuts panel, the stone picker's glyphs, the board's axes) moved down. Where a value is genuinely produced end-to-end — the per-move TPS the scrubber embeds, which comes from replaying real moves — the HTTP assertion stays.
- **`games.test.ts` keeps its shape.** It is organised by command (propose, join, play, resign, take-back, share, hide, export, …), which is exactly the module's interface, and ADR-0011 already trimmed its duplicated shape assertions and added the four read-delegation pins. Riding the command union is the right shape for a command module; nothing about the view split changes that.
- **`persistence.ts` translates driver exceptions in one place.** Thirty-eight repetitions of `catch (e) { return err(e instanceof Error ? e.message : String(e)) }` — about 115 of 954 lines — became `attempt(statement, fn)`, which names the failing call: `createGame: UNIQUE constraint failed: …` instead of a bare driver message. A method that must fail on its own terms (an insert whose row does not read back) throws inside `fn` and is reported the same way. `transaction` is deliberately not wrapped: the error it reports is usually the closure's own, already-named failure travelling back out through the rollback, and a prefix would bury the caller's message.

## Considered options

- **Leave the render functions to HTTP and keep `views.ts` whole.** Rejected: it is the status quo the evidence indicts. Thirty of forty commits touched a file with no direct test, so every rendering change was verified through a stack that has nothing to do with rendering — and the cost of that made assertions sparse where the churn was highest.
- **One `views.test.ts` against an unsplit `views.ts`.** Rejected, but only just: the test seam is the urgent half and could have landed alone. The split earned its place on churn — a 1,270-line file every ticket edits is where the conflicts and the wayfinding cost accumulate — and it is a pure move, so the existing HTTP suite is its deletion test.
- **Split by line count into `views-1`/`views-2`, or one file per page.** Rejected: the first cuts across the page/regions pair, the second scatters the row helpers the two games lists share and turns "what does a games list row show" into a two-file question.
- **A new `page-parts.ts` for `Regions`/`region`/`streamed`.** Rejected: `html.ts` is already the module for markup every page shares, and a fourth file holding two functions and a type is a home for nothing.
- **Move every HTTP markup assertion down.** Rejected: some of them are end-to-end statements wearing markup's clothes — the scrubber's TPS values, the seat a random start resolves to, the imported record's board size. Those need the real stack, and a `toContain` is how they read it.
- **A `Result`-returning `attempt` for the four methods that refuse on their own terms.** Rejected: a second helper to spare four call sites a `throw`, when a row that does not read back after its own insert is exactly the exceptional case `attempt` exists to report.

## Consequences

- `views.ts` is 316 lines, `game-screen.ts` 526, `game-lists.ts` 421; `persistence.ts` fell from 954 to 882.
- A rendering change is now verified in milliseconds against a literal, and a ticket that touches the game screen no longer edits the same file as one that touches the sign-in page.
- `game-screen.test.ts` (41 tests) and `game-lists.test.ts` (21) are the place new markup assertions go; `games-http.test.ts` fell from 199 `toContain` to 163 and should keep falling as new screens follow this seam rather than the old one.
- The three-way split is a load-bearing distinction for future screens: a bot game screen or a coach panel belongs in `game-screen.ts`, a new list in `game-lists.ts`, and `views.ts` stays the quiet remainder.
