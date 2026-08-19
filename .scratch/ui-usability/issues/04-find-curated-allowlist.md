# 04 — Find a game: curated allowlist ("players I follow")

**What to build:** A per-user curated view of find-a-game: an "Only show games from players I follow" toggle (default off — everything visible) plus a follow/unfollow affordance on each proposal row. The preference persists per user; the find stream honours the current mode and list. Spec: `.scratch/ui-usability/spec.md`.

**Blocked by:** None.

**Status:** ready-for-agent

- [ ] A `user_prefs` table (user id → JSON prefs) in persistence, additive to the schema; the allowlist (display names the user follows) is one pref.
- [ ] `searchProposed` accepts the allowlist: when curated mode is on, only proposals from followed players are returned; the existing board/kind/proposer filters compose with it.
- [ ] The find page renders the toggle and per-row follow/unfollow buttons (state per row: followed or not); query params carry the mode so the stream route runs the same search.
- [ ] Defaults: mode off (all proposals visible), empty allowlist — no surprise filtering.
- [ ] Tests at the HTTP seam: curated mode filters correctly; toggling follows/unfollows persists; the find stream respects the mode; compose with existing filters.

## Comments

**2026-08-19 — Specified in grilling.** The user chose the **allowlist** over a blocklist ("I'm more interested in finding my friends"). The empty-state edge was resolved as a curated **toggle**, default off, so an empty find page never surprises anyone and both modes are reachable without rebuilding the list.
