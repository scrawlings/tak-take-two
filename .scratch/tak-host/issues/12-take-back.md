# 12 — Play: take-back

**What to build:** The take-back request flow — one pending request that blocks the opponent until accepted or rejected, applying only to post-start moves while the game is in play.

**Blocked by:** 11 — Play: game view, moves, finish

**Status:** ready-for-agent

- [ ] A player can request a take-back of their last move before the opponent has moved; only one request may be pending at a time.
- [ ] While a request is pending, the opponent cannot move until they accept (the move is undone and the requester moves again) or reject (play continues).
- [ ] Take-backs cannot target imported history and are unavailable after the game ends.
- [ ] Trail events are written for take-back requests and decisions.

## Comments

**2026-08-17 — Design note.** ADR-0004 (`docs/adr/0004-game-lifecycle-module.md`) fixes the web Game lifecycle seam: routes are thin adapters over a single Game module behind a command-union interface (`applyGame(gameId, actorId, command)`). Build over the Game module. Read the ADR before designing.
