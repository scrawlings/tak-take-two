# Spec — UI usability

Status: ready-for-agent

## Problem Statement

The site is functionally complete (all 21 `tak-host` tickets done), but the game screen and the lists make study and navigation laborious. The board always shows only the live position: a player who wants to review an earlier point in the game must export a TPS and read it elsewhere. The games lists are a flat dump: no way to sort by what matters, filter by state, curate who appears, or hide a game without opening it. And there is no keyboard path through the game screen at all — every action is a click or a typed PTN.

This spec fixes three clusters: a **history scrubber** that turns the existing per-move history into an in-place review tool; **keyboard shortcuts** for the game screen; and **list curation** — sorting, filtering, and hiding — on the player's game lists.

## Solution

### History scrubber (review mode)

On the game page, clicking any move in the history (or dragging the scrubber when it is added) puts the page into **review mode**:

- The board, reserves, and history highlight show the position **after that move**.
- A sticky review bar replaces the move form's place: "Viewing move N of M" with a **snap to end** button. The move form is not shown at all while scrubbed — a scrubbed player cannot make a move, and the UI says so.
- If it is the viewer's turn at the live position and they are scrubbed away, the bar says so plainly ("Your turn — they're waiting on you") so being pulled into review never hides that the game is waiting.
- When a new move streams in over SSE while the viewer is scrubbed, the viewer **stays put**; the review bar pulses "new move" and the history list updates. Snap-to-end returns to live.
- The scrubber works for **players and spectators**, on **in-play and finished** games.

Mechanism (implementation note, decided here): the game page already materialises the whole record server-side (`GameView.moves`). The server embeds the **TPS of the position after each move** (core's `stateAfter` + `generateTps`); the client bundle gains a small, tested **TPS→board renderer** that swaps the board region's cells when scrubbing. TPS blobs ride in the moves region, so a streamed new move grows the scrub set naturally. The scrub state lives in the same stream-surviving scope as the move builder (ADR-0007). Round-trip discipline from ADR-0006 applies: every TPS the server emits must re-parse to the same position.

### Keyboard shortcuts

On the game screen, active only when focus is **not** in an input/textarea/select (so typing PTN never triggers them):

| Key | Action |
| --- | --- |
| `Enter` | Play the move (the composed/typed move in the form) |
| `[` / `]` | Scrubber back / forward (no-op when not scrubbed; `[` at the start and `]` at live are no-ops) |
| `u` | Request a take-back (only when a take-back may be offered; otherwise no-op) |
| `Esc` | Cancel an in-progress board move / snap back to live |
| `?` | Toggle a one-line shortcuts help panel |

Shortcuts activate the same affordances a click would — they never open new server paths.

### List curation

**Your games** (`.scratch/ui-usability/issues/03`, `05`, `06`):

- A **status filter** — proposed / in play / finished — and **sorting**: time since last activity (default, newest first), creation date, board size. This needs a derived **last-activity** value on `GameSummary` (the last move's timestamp, else `createdAt` for not-started games).
- A **hide button in each row** — hide a game from your views without opening it (reuses the existing hide action; mirrors the join button's `from` redirect).
- A **"Show removed games" toggle, default off** — admin-removed tombstones (which persist so the "removed by admin" warning stays visible) are hidden from the list by default; toggling on shows them again, and their tombstone page (warning + exports) stays reachable either way.

**Find a game** (`.scratch/ui-usability/issues/04`):

- A per-user **curated allowlist** — a "Only show games from players I follow" toggle (default off: everything visible) plus a follow/unfollow affordance on each proposal row. The preference persists per user; the find stream honours the current mode and list. (The user's phrase: "I'm more interested in finding my friends.")

List controls are query-param-driven server-side renders, consistent with the existing find form pattern; the SSE list streams keep following the current filter/sort.

## User Stories

1. As a player, I want to click any move in the history and see the board and reserves at that point, so that I can review my game in place.
2. As a player reviewing, I want to be clearly told I am not viewing the latest move and cannot move from there, so that I never mistake review for live play.
3. As a player reviewing, I want to snap back to the live position in one action.
4. As a player reviewing while it is my turn, I want to be told the game is waiting on me.
5. As a spectator of a shared game, I want the same review, so that I can follow play move by move.
6. As a player, I want to play my move with `Enter`, request a take-back with `u`, and step the scrubber with `[` `]`, so that I can drive the game screen from the keyboard.
7. As a player, I want the shortcut help discoverable with `?`.
8. As a player, I want my games list filtered by state and sorted by most recent activity, so that the games that need me surface first.
9. As a player, I want to see only proposals from players I follow, so that find-a-game shows the people I play with.
10. As a player, I want to hide a game from my list without opening it.
11. As a player, I want removed games hidden by default, so that my list is not cluttered by tombstones.

## Implementation Decisions

- **Scrubber renders from embedded TPS, client-side.** The server already holds the whole record; emitting one TPS string per move is cheap and the client renderer is a small, round-trip-tested module in the ADR-0006 bundle. Alternative rejected: per-move server round-trips (too chatty for a drag) and pre-rendering every historical board as HTML (heavy page).
- **Scrub state survives stream swaps** (ADR-0007): the review position lives in the scope that already survives region replacement — the same pattern that keeps the move builder alive through updates.
- **Review mode replaces the move form** rather than disabling it: hiding the form is unambiguous ("you cannot move from here") and keeps the controls region simple.
- **Shortcuts are a client module** (ADR-0006), focus-guarded, and activate existing affordances: `Enter` submits the move form, `u` triggers the existing take-back POST via its button, `[` `]` drive the scrubber. No new routes.
- **Lists sort and filter server-side** in the `Games` module, driven by query params exactly like the find form today; the stream routes re-run the same query so the live lists keep matching the controls.
- **`lastActivity` is derived in `summarise`** from the record's move timestamps (or `createdAt` when there are none) — not stored, so it can never drift from the record.
- **The allowlist preference lives in a new `user_prefs` table** (user id → JSON prefs). Additive to the schema; no column surgery on `users`. The blocklist idea was considered and rejected in favour of the allowlist ("I'm more interested in finding my friends").
- **Removed games are filtered by default in `listMyGames`** with a `show_removed` opt-in, rather than deleting the tombstones: the warning page and exports must stay reachable.

## Testing Decisions

- **Core seams untouched** — this spec is all web/client.
- **Client modules tested through their interfaces** (ADR-0006 discipline): the TPS→board renderer round-trips against `core`'s `generateTps`/`parseTps`; the shortcuts module is driven as plain data (focus guard, key→action mapping, no-op cases).
- **HTTP seam tests** (`web/test/*`): scrubber page includes one TPS per move and the review state renders; list filters/sorts return the right rows in the right order; the allowlist mode filters the find stream; hide-from-row hides and redirects; `show_removed` toggles tombstone visibility.
- **Stream behaviour asserted**: a streamed update while scrubbed keeps the review position and shows the pulse.

## Out of Scope

- Notifications (browser or otherwise) — deliberately skipped in grilling; in-window behaviour has been enough, and out-of-window nagging is undesirable.
- Board visual polish (last-move highlight, orientation flip, coordinates, theming) — deferred.
- Responsive/mobile layout — deferred.
- Game clocks / time controls — deferred (a lifecycle feature, its own spec).
- Dedicated accessibility pass — deferred; minimal ARIA folds into individual tickets.
- Admin games list sorting/filtering — unchanged.

## Further Notes

- The scrubber is the per-move export links ("copy PTN through move N", "copy TPS after move N") given teeth — the exports stay, the board joins them.
- `u` for take-back: `Ctrl+Z` was rejected as the binding — it collides with the browser's undo and would be surprising.
