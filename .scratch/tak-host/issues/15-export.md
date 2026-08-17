# 15 — Export PTN/TPS

**What to build:** Copy the game as PTN (full game or prefix from any move) or TPS (position after any move), with trail events.

**Blocked by:** 03 — Core: PTN; 04 — Core: TPS; 11 — Play: game view, moves, finish

**Status:** ready-for-agent

- [ ] From any move in the history, a player can copy the PTN up to and including that move, or the TPS of the position after that move.
- [ ] Exported PTN of a full game is valid and replayable (it re-validates on import); exported prefixes validate too.
- [ ] Exported TPS round-trips through the TPS parser.
- [ ] Trail events are written for exports.
