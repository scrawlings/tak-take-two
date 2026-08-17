# 01 — Core: board model, place moves, win detection

**What to build:** A typed Tak board and the rules for placing stones — including the opponent-stone opening — plus detection of road and flat wins. This is the foundation every other rule and validation sits on.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] A 5×5 or 6×6 board can be created empty; squares are addressed by typed file/rank coordinates so out-of-range indexing is a compile-time error.
- [x] Placing a flat, standing, or capstone onto an empty square is accepted; placing onto an occupied square is rejected.
- [x] Each player's first turn must place one of the opponent's flat stones; any other first move is rejected.
- [x] After the opening, a player places their own stones (flat, standing, capstone) from their reserve; placements beyond the reserve are rejected.
- [x] Passing is never legal.
- [x] A road (orthogonal chain of flats + capstones connecting opposite edges) is detected and ends the game with the correct result; a move creating roads for both players awards the win to the mover.
- [x] When the board is full or a player places their last stone, the game ends by flat count (top-of-stack flats only); an equal count is a draw.
- [x] Every invalid action returns a typed error (neverthrow) — nothing throws.

## Comments

**2026-08-17 — Completed.** Implemented in commit `969039e` and verified this session: `core/src/types.ts` + `core/src/game.ts` (`createGame`, `applyMove`, `getStack`; neverthrow `Result` on every failure path), covered by `core/test/game.test.ts` (13 tests). All checklist items pass. See `docs/agents/triage-labels.md` for the `done` status convention.
