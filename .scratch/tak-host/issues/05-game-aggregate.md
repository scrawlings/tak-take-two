# 05 — Core: game aggregate

**What to build:** A headless, playable game object — full history with per-move timestamps, undo, resign, mutual draw, finished state. This is what the web layer persists and what future batch programs will drive.

**Blocked by:** 01 — Core: board model, place moves, win detection; 02 — Core: stack moves; 03 — Core: PTN

**Status:** done

- [x] A game can be created from a board size and replayed move by move; position, turn, and reserves stay consistent throughout.
- [x] History records every move with its timestamp; undoing restores the prior state and is only possible for moves played after the game started, while the game is in play.
- [x] Resign and mutual draw end the game with the correct result; board wins (from ticket 01) also end it.
- [x] A full PTN game can be loaded and replayed headlessly with no I/O and no framework imports.
- [x] Every failure returns a typed error — nothing throws.

## Comments

**2026-08-17 — Completed.** Implemented in commit `002064f`: `core/src/aggregate.ts` (the headless game aggregate — `createTakGame`, `playMove`, `undo`, `resign`, `mutualDraw`, `fromPtn`/`fromPtnText`, `toPtn`, `resultCode`, `isFinished`; `TakGame`/`RecordedMove`/`GameEnd`/`GameError` types) plus `core/src/index.ts` exports, covered by `core/test/aggregate.test.ts` (17 tests). All checklist items pass:

- **Create + replay:** `createTakGame(size)` starts empty; every `playMove` folds the engine's `applyMove`, so `state` always matches a from-scratch replay (asserted against `applyMove` in tests), keeping position, turn, and reserves consistent.
- **History/undo:** every move is stored with an epoch-ms timestamp (injectable for tests; `null` for imported moves); `undo` replays the history minus the last live move and is rejected with `game-finished` once ended and `no-move-to-undo` at or inside the fixed (imported) prefix — imported PTN history is fixed (`fixedMoves`).
- **Endings:** `resign(player)` (opponent wins), `mutualDraw()`, and engine-detected board wins all set `result` (`GameEnd`), map to the correct PTN result code (`R-0`/`0-R`, `F-0`/`0-F`, `1-0`/`0-1`, `1/2-1/2`), and block further actions with `game-finished`.
- **PTN load:** `fromPtnText` = `parsePtn` + `fromPtn`, loading a full record headlessly with fixed history; a recorded `R/F/1-0/1/2-1/2` result is preserved even when the board does not itself end; `toPtn` round-trips.
- **Typed errors:** every failure path returns a neverthrow `Result` (`GameError` with `invalid-move` wrapping the underlying `RuleError`); nothing throws.

All 127 tests pass; lint and typecheck clean. See `docs/agents/triage-labels.md` for the `done` status convention.
