# 09 — Games: propose + PTN import

**What to build:** Propose open or invited games from scratch or from a validated PTN record; delete unjoined proposals; the "my games" list.

**Blocked by:** 05 — Core: game aggregate; 07 — Auth: accounts & sessions

**Status:** ready-for-agent

- [ ] A player can propose a game on a 5×5 or 6×6 board as open (anyone may join) or invited (one designated player).
- [ ] A player can propose a game from PTN; the record is validated by the core and only legal records are accepted; the imported history is fixed.
- [ ] The proposer can delete a proposal no one has joined; joined games cannot be deleted this way.
- [ ] "My games" shows the signed-in player's proposals and active games.
- [ ] Trail events are written for proposals and deletions.

## Comments

**2026-08-17 — Design note.** ADR-0004 (`docs/adr/0004-game-lifecycle-module.md`) fixes the web Game lifecycle seam: routes are thin adapters over a single Game module behind a command-union interface (`applyGame(gameId, actorId, command)`). This ticket gives birth to the web Game module. Read the ADR before designing.
