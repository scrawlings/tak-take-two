# 14 — Real-time updates

**What to build:** SSE live updates, Alpine-driven — moves stream to participants and spectators in real time, lists refresh live, and the spectator view is gated by share. No datastar (ADR-0007): an SSE route re-renders the streamed regions with the existing view functions and pushes fragments; a small Alpine component on the game screen swaps them; scripts load per page.

**Blocked by:** 11 — Play: game view, moves, finish; 13 — Share, hide, admin delete

**Status:** ready-for-agent

- [ ] Participants see moves appear on the game view without a manual refresh.
- [ ] Spectators of shared games see moves live; unshared games cannot be watched.
- [ ] "My games" and search views reflect state changes without a manual refresh.
- [ ] The board and history stay consistent under near-simultaneous updates from both players.
- [ ] The shell gains a per-page scripts option; non-interactive pages (login, account, status, admin) ship no client runtime; the game page opts into Alpine.

## Comments

**2026-08-17 — Design note.** ADR-0004 (`docs/adr/0004-game-lifecycle-module.md`) fixes the web Game lifecycle seam: routes are thin adapters over a single Game module behind a command-union interface (`applyGame(gameId, actorId, command)`). Delivery concern — adapt at the routes, over the Game module. Read the ADR before designing.

**2026-08-18 — Design note (ADR-0007).** The reactivity fork is resolved: Datastar (a beta dependency, never invoked, shipped to every page) is dropped; Alpine is the single client runtime. The game screen streams three regions — status line, board, move list — re-rendered by the existing view functions (`renderGameStatus`, `renderBoard`, `renderHistory`) and pushed as SSE fragments; an Alpine component holds the EventSource (auto-reconnecting) and swaps via `x-html`. The click-builder's composition state lives on an `x-data` wrapper the stream never replaces. Spectator streaming is gated at the SSE route by the module's visibility rule (ADR-0003), same as the page. Detail design — fragment shapes, list streams, consistency under simultaneous moves — belongs to this ticket.
