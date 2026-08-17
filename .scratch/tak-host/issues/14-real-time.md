# 14 — Real-time updates

**What to build:** datastar/SSE live updates — moves stream to participants and spectators in real time, lists refresh live, and the spectator view is gated by share.

**Blocked by:** 11 — Play: game view, moves, finish; 13 — Share, hide, admin delete

**Status:** ready-for-agent

- [ ] Participants see moves appear on the game view without a manual refresh.
- [ ] Spectators of shared games see moves live; unshared games cannot be watched.
- [ ] "My games" and search views reflect state changes without a manual refresh.
- [ ] The board and history stay consistent under near-simultaneous updates from both players.

## Comments

**2026-08-17 — Design note.** ADR-0004 (`docs/adr/0004-game-lifecycle-module.md`) fixes the web Game lifecycle seam: routes are thin adapters over a single Game module behind a command-union interface (`applyGame(gameId, actorId, command)`). Delivery concern — adapt at the routes, over the Game module. Read the ADR before designing.
