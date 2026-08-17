# 10 — Games: find & join

**What to build:** Search and join — browse proposed games with filters, join open/invited/own games, and invited-game privacy.

**Blocked by:** 09 — Games: propose + PTN import

**Status:** ready-for-agent

- [ ] A player can search proposed games, filtering by board size, open vs invited, and proposer display name; invited games appear only to the designated player.
- [ ] A player can join an open game; joining implies sharing (share toggles start on).
- [ ] A player can join a game that designates them; such games are hidden from everyone else.
- [ ] A player can join their own games.
- [ ] A game cannot be joined twice or after it has started; joining starts play with the correct first player.

## Comments

**2026-08-17 — Design note.** ADR-0004 (`docs/adr/0004-game-lifecycle-module.md`) fixes the web Game lifecycle seam: routes are thin adapters over a single Game module behind a command-union interface (`applyGame(gameId, actorId, command)`). Build over the Game module. Read the ADR before designing.
