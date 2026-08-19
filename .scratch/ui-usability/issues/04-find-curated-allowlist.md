# 04 — Find a game: curated allowlist ("players I follow")

**What to build:** A per-user curated view of find-a-game: an "Only show games from players I follow" toggle (default off — everything visible) plus a follow/unfollow affordance on each proposal row. The preference persists per user; the find stream honours the current mode and list. Spec: `.scratch/ui-usability/spec.md`.

**Blocked by:** None.

**Status:** done

- [x] A `user_prefs` table (user id → JSON prefs) in persistence, additive to the schema; the allowlist (display names the user follows) is one pref.
- [x] `searchProposed` accepts the allowlist: when curated mode is on, only proposals from followed players are returned; the existing board/kind/proposer filters compose with it.
- [x] The find page renders the toggle and per-row follow/unfollow buttons (state per row: followed or not); query params carry the mode so the stream route runs the same search.
- [x] Defaults: mode off (all proposals visible), empty allowlist — no surprise filtering.
- [x] Tests at the HTTP seam: curated mode filters correctly; toggling follows/unfollows persists; the find stream respects the mode; compose with existing filters.

## Comments

**2026-08-19 — Specified in grilling.** The user chose the **allowlist** over a blocklist ("I'm more interested in finding my friends"). The empty-state edge was resolved as a curated **toggle**, default off, so an empty find page never surprises anyone and both modes are reachable without rebuilding the list.

**2026-08-19 — Implemented.** `user_prefs` (migration 7: `user_id INTEGER PRIMARY KEY, prefs TEXT NOT NULL DEFAULT '{}'`) stores one JSON blob per user; `persistence.getUserPrefs`/`setUserPrefs` decode/encode it, defaulting to `{ follows: [] }` when a user has never written a row, and tolerating an unrecognised or missing `follows` field rather than throwing (the blob is meant to grow other prefs later).

One deliberate divergence from the ticket's phrasing: the allowlist is stored as **user ids**, not display names. The ticket's parenthetical ("display names the user follows") reads as a description of what the feature does, but storing by name would go stale the moment a followed player changes theirs (`/account/display-name` already exists) — ids can't. `GameSummary` gained `followed`/`canFollow` (the latter false only for the viewer's own proposal, so the button never offers to follow yourself), both computed in `summariseAll` from one `getUserPrefs` read shared across the batch, the same pattern ticket 03's `lastActivity` established.

Follow/unfollow are two new `GameCommand` variants (`{ type: 'follow', userId }` / `unfollow`) rather than new named methods on `Games` — ADR-0004 explicitly rejects "a dozen thin methods" in favour of the one command union, and `follow`/`unfollow` having no `gameId` is no different from `propose` already not having one. `follow` refuses self-follow (`invalid-follow`) and a nonexistent user id (`not-found`, reusing the code games already use for "doesn't exist"); `unfollow` is a no-op on an id never followed, deliberately not an error.

**Curated mode itself is a query param, not a persisted setting** — only the follow list persists. This follows ticket 03's precedent (`status`/`sort`/`direction` aren't remembered across visits either) and resolves an ambiguity between the ticket checklist ("mode off... empty allowlist") and the spec's looser prose ("the preference persists... honours the current mode and list") by reading "the preference" as the follow list specifically, with "mode" tracking the same query-param idiom the rest of this UI-usability effort uses.

The route layer mirrors ticket 03/01's "read once, use twice" idiom throughout: `proposalSearch(c)` (extended with `curated`) feeds `/games/find` and `/games/find/stream` identically. The two new POST routes, `/games/find/follow` and `/games/find/unfollow`, redirect back to `/games/find` carrying the same search — the follow/unfollow `<form>` on each row carries the current filters as hidden fields (`board_size`/`join_type`/`proposer`/`curated`), and `run` maps the successful command's result to the redirect URL built from those fields via neverthrow's `.map()`, since `formAction`'s `onOk` doesn't receive the submitted fields directly (only `renderError` does) — reusing the form body would mean re-parsing it outside the one place it's read.

`GAMES_TOPIC` still wakes every open list stream on a follow/unfollow (the existing unconditional publish in `announceGameChanges`), so a curated find page open in a second tab picks it up live without `changedGame` needing a case beyond `null` (no specific game changed).

Tests: `persistence.test.ts` (`user_prefs` defaults, round-trip, isolation per user, malformed-blob tolerance), `games.test.ts` (`followed`/`canFollow` on summaries, follow/unfollow commands and their refusals, curated mode alone and composed with `boardSize`), `games-http.test.ts` (the button appears only on someone else's row, follow/unfollow round-trips through the page, curated narrows the visible rows, the stream URL carries `curated`, a refused self-follow keeps the form's filters), `db.test.ts` (migration count and the new table's columns). Full suite green (670 tests), typecheck and lint clean; no client bundle changes.

**2026-08-19 — Code review.** Spec found no issues — the two judgement calls (follow-by-id, curated-as-query-param) both held up against the actual behaviour. Standards found one real gap and two duplications, all fixed:

- `follow`/`unfollow` wrote no activity-trail entry, unlike every sibling command (`share`, `hide`) — ADR-0004 says trail writes belong inside the module's command implementations, not skipped. `editFollows` now writes `player-followed`/`player-unfollowed` inside the same transaction as the `setUserPrefs` write, carrying the followed user's id in the payload. A new test asserts both events land in order.
- `app.ts`'s `findRedirect` had hand-rolled the exact `URLSearchParams`-from-optional-fields logic `views.ts`'s `streamUrlWith` already implements — `streamUrlWith` is now exported and reused instead of reimplemented.
- `findSearchFromForm` (reading the follow form's hidden fields) and `proposalSearch` (reading the query string) built the identical `{ search, filters }` shape from different value sources — both now delegate to one module-level `searchAndFilters(boardSize, joinType, proposer, curated)` in `app.ts`, called with values from whichever source.

One flagged item was left as a judgement call rather than fixed: `requirePlayer` is still checked separately at the top of both `follow` and `unfollow` rather than folded into their shared `editFollows` helper — moving it would put user-existence/self-follow validation ahead of authorization in `follow`'s check order, which breaks the "authorize before validate" pattern every other command in this module follows. The review itself called this one low-severity. Full suite re-verified green after the fixes (671 tests), typecheck and lint clean.
