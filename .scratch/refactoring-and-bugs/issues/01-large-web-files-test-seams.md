# 01 — Structure and test seams for the large web-tier files

**What to build:** A decision (and the follow-on work) on how the four large `web/src` modules are structured and, more urgently, where their **test seams** sit. The immediate problem is not file length on its own — it is that the biggest, fastest-churning module in the repo has no interface a test can reach except HTTP.

**Status:** needs-triage

## The evidence

Measured 2026-08-21, over the last 40 commits:

| Module | Lines | Commits touching it | Direct tests |
| --- | --- | --- | --- |
| `web/src/views.ts` | 1,270 | **30 / 40** | **none** |
| `web/src/games.ts` | 1,417 | 22 / 40 | `games.test.ts` (2,344 lines) |
| `web/src/app.ts` | 913 | 24 / 40 | via HTTP only |
| `web/src/persistence.ts` | 954 | 12 / 40 | `persistence.test.ts` (423 lines) |

`views.ts` is the repo's top churn file and no test imports it. Its 25 exported render functions are exercised only through `games-http.test.ts` (1,488 lines, **199** `toContain` assertions), so asserting that a board renders 5×5 currently costs an in-memory SQLite database, a migration run, a created user, a sign-in, and a proposed game. The render functions are pure `GameView → string` and need none of that.

`persistence.ts` separately repeats `catch (e) { return err(e instanceof Error ? e.message : String(e)) }` 38 times — roughly 115 of its 954 lines.

## Checklist

- [ ] Decide whether `views.ts` gets a direct test surface (`views.test.ts` calling the render functions with hand-built `GameView`/`GameSummary` values), and whether the existing HTTP assertions move down to it or stay as end-to-end cover.
- [ ] Decide what, if anything, `views.ts` splits into. Note it is already internally factored — the page/regions pair per screen share one table builder, so a split should follow a seam that exists rather than cut by line count.
- [ ] Decide whether `games.test.ts` (2,344 lines, riding the command union) is still the right shape after ADR-0011 moved view assembly out.
- [ ] Consider an internal `attempt(fn)` in `persistence.ts` to concentrate the driver-exception → `Result` translation, with room to name the failing statement.
- [ ] Record whatever is decided — as an ADR if it changes a seam, otherwise as comments here.

## Comments

**2026-08-21 — Opened during the architecture review.** Raised while implementing the `stoneSeat`/`isOpeningTurn` deepening (review candidate 3), which touched two `views.ts` render functions and could only be verified there through HTTP. The candidate itself was kept scoped — its tests went to `game-views.test.ts`, where the decided fields live — and this ticket carries the broader structural question rather than letting it expand that change.

The architecture review raised four other candidates against these same files, none of them accepted yet, listed here only so this ticket knows they exist:

- **1** — a Screen module: page, stream, and error adapter for each screen are restated three times in `app.ts`.
- **2** — a live-page module owning ADR-0007's region-nesting invariant, currently held by comments and tested with `indexOf` arithmetic.
- **4** — an addressed-game loader in `games.ts`: nine commands hand-write the same authorise ladder, and ADR-0003's `visibleTo` is invoked at six call sites.
- **6** — a command-path contract, so form actions and field names stop being literals on both sides of the POST seam.

The full review is not committed to the repo; regenerate it with `/improve-codebase-architecture` if the detail is wanted.
