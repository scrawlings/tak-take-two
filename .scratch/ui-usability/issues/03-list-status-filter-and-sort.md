# 03 — Your games: status filter and sorting

**What to build:** The "Your games" list gains a status filter (proposed / in play / finished) and sorting: time since last activity (default, newest first), creation date, board size. Needs a derived **last-activity** value on `GameSummary` — the last move's timestamp, else `createdAt` for games with no moves. Controls are query-param-driven server-side renders, consistent with the find form; the SSE list stream keeps following the current filter/sort. Spec: `.scratch/ui-usability/spec.md`.

**Blocked by:** None.

**Status:** ready-for-agent

- [ ] `GameSummary` gains a derived `lastActivity` (from the record's move timestamps or `createdAt`), computed in `summarise` — not stored, so it can never drift.
- [ ] `listMyGames` accepts a `status` filter and a `sort` key + direction; ordering happens in the module, not the view.
- [ ] The games page renders the filter/sort controls (selects, consistent with the find form pattern) that re-issue the query via GET params; the stream route runs the same query so the live list matches the controls.
- [ ] Defaults: no status filter (all), sort by last activity descending.
- [ ] Tests at the HTTP seam: filter and each sort return the right rows in the right order; `lastActivity` is correct for a not-started game and a game with moves; the stream honours the current params.

## Comments

**2026-08-19 — Specified in grilling.** Split agreed with the user: "Your games" gets status filter + sorting; "Find a game" gets the allowlist (04) and no status filter (its content is all proposals). Admin games list is out of scope.
