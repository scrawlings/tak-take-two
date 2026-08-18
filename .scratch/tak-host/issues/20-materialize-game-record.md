# 20 — Materialize the playable game in one module

**What to build:** Restoring a stored Game record into a playable TakGame becomes one headless core module — a pure loader beside `fromPtn`, with the per-move TPS snapshot as the read path — replacing the web Game module's two replay implementations (`currentTakGame`, `gameAfter`). Reads trust the write seam; full replay survives only as the fallback for states no snapshot covers.

**Blocked by:** 03 — Core: PTN; 04 — Core: TPS; 05 — Core: game aggregate

**Status:** ready-for-agent

- [ ] Core (`core/src/aggregate.ts`): `loadGame(record)` — a pure loader beside `fromPtn`: record (board size, imported PTN, the live rows' notation + playedAt + position, the stored result string) in, `TakGame` out. Raw notation parsed inside core — the web's `parseMove` call moves into core with it.
- [ ] Core: snapshot-aware `stateAfter(record, n)` — the state at full-history move n: row n's stored position when n is inside live moves, the empty board at 0, and the import-prefix replay when n cuts inside imported history (the fallback path). A null snapshot falls back to replay rather than failing.
- [ ] Core: `corrupt-record` joins the core `GameErrorCode` union; the loader returns code + reason and never names a game id.
- [ ] Core: the loaded game's result comes from the stored result string, mapped inside the loader via the existing `endFromCode` (resign and draw cannot be derived from a position).
- [ ] Web (`web/src/games.ts`): `currentTakGame` and `gameAfter` deleted; the seven call sites (playMove, resign, acceptDraw, requestTakeBack, exportGame, gameView, summarise) call the loader; `corrupt-record` is wrapped as `game ${id}` (message style preserved) and mapped 500.
- [ ] Web: the export TPS branch uses `stateAfter`; the PTN prefix branch slices the loaded history (it needs no state at all).
- [ ] Core tests (`core/test/load.test.ts`): the flagship invariant — *loaded state ≡ fully-replayed state* across empty / imported-only / live-only / imported+live records; result mapping for every `ResultCode`; `stateAfter` at 0 / fixedMoves / mid / total; corrupt input → `corrupt-record`.
- [ ] Web tests: `games.test.ts` stays green unchanged (the module interface is the test surface); the export tests and the position-write test (`:961`) become the fast-path regression net.
- [ ] No CONTEXT.md change: the loader is mechanics, and "Game record" already names the data it reconstitutes.

## Comments

**2026-08-18 — Design note.** From the architecture review (opportunity: materialize the playable game in one module) and the grilling rounds. Read ADR-0005 (`docs/adr/0005-game-materialization.md`) before designing.

- **The two replay paths were a live contradiction.** `currentTakGame` (replay every stored move) and `gameAfter` (replay to move N) did the same work, and `gameAfter`'s own comment claimed "the stored record is the moves, not a per-move snapshot of the board" — while `appendMove` writes a per-move TPS snapshot that nothing ever read. The module is the resolution: the snapshot becomes the read path, the replay becomes the fallback.
- **Reads trust the write seam.** Every snapshot was written from a validated state (`appendMove` stores only after the core accepted the move), so verification happens at the write; replay-on-read was incidental, not designed. Ticket 14 (real-time) re-renders the game view and both lists on every move — with the fast path each refresh is one snapshot read instead of an O(moves) replay.
- **Result parity matters beyond the web.** `coreResign`/`mutualDraw`/`playMove` guard on `game.result`, not the position; a loaded resigned game must know it is finished, or a batch program (ADR-0001) could resign an already-finished game. The stored string maps through the existing `endFromCode`.
- **Corruption is its own fault class.** Today a corrupt stored record surfaces as `persistence` → 500, conflating "SQL failed" with "stored data is corrupt". `corrupt-record` separates them; the web seam composes the game id into the message.
- **The take-back flow needs no special handling.** Accepting a take-back deletes the last row; the new last row's snapshot is exactly the post-undo position.
