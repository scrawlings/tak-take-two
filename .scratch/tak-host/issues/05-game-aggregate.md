# 05 — Core: game aggregate

**What to build:** A headless, playable game object — full history with per-move timestamps, undo, resign, mutual draw, finished state. This is what the web layer persists and what future batch programs will drive.

**Blocked by:** 01 — Core: board model, place moves, win detection; 02 — Core: stack moves; 03 — Core: PTN

**Status:** ready-for-agent

- [ ] A game can be created from a board size and replayed move by move; position, turn, and reserves stay consistent throughout.
- [ ] History records every move with its timestamp; undoing restores the prior state and is only possible for moves played after the game started, while the game is in play.
- [ ] Resign and mutual draw end the game with the correct result; board wins (from ticket 01) also end it.
- [ ] A full PTN game can be loaded and replayed headlessly with no I/O and no framework imports.
- [ ] Every failure returns a typed error — nothing throws.
