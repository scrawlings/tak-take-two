# 03 — Core: PTN

**What to build:** Parse PTN into typed moves, validate a whole record by replaying from an empty board, and generate PTN text for the full game or a prefix from any move.

**Blocked by:** 01 — Core: board model, place moves, win detection; 02 — Core: stack moves

**Status:** ready-for-agent

- [ ] Valid PTN (tags, numbered moves, place and stack-move syntax, results) parses into typed moves; the opponent-stone opening is enforced on the first moves.
- [ ] Records containing any illegal move are rejected with an error identifying the offending move.
- [ ] PTN generation produces correct text for a full game and for any prefix (the game up to a chosen move) that replays cleanly.
- [ ] Comments, informational marks, and result codes are handled without misparsing.
- [ ] Every failure returns a typed error — nothing throws.
