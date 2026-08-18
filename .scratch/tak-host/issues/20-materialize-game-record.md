# 20 — Materialize the playable game in one module

**What to build:** Restoring a stored Game record into a playable TakGame becomes one headless core module — a pure loader beside `fromPtn`, with the per-move TPS snapshot as the read path — replacing the web Game module's two replay implementations (`currentTakGame`, `gameAfter`). Reads trust the write seam; full replay survives only as the fallback for states no snapshot covers.

**Blocked by:** 03 — Core: PTN; 04 — Core: TPS; 05 — Core: game aggregate

**Status:** done

- [x] Core (`core/src/aggregate.ts`): `loadGame(record)` — a pure loader beside `fromPtn`: record (board size, imported PTN, the live rows' notation + playedAt + position, the stored result string) in, `TakGame` out. Raw notation parsed inside core — the web's `parseMove` call moves into core with it.
- [x] Core: snapshot-aware `stateAfter(record, n)` — the state at full-history move n: row n's stored position when n is inside live moves, the empty board at 0, and the import-prefix replay when n cuts inside imported history (the fallback path). A null snapshot falls back to replay rather than failing.
- [x] Core: `corrupt-record` joins the core `GameErrorCode` union; the loader returns code + reason and never names a game id.
- [x] Core: the loaded game's result comes from the stored result string, mapped inside the loader via the existing `endFromCode` (resign and draw cannot be derived from a position).
- [x] Web (`web/src/games.ts`): `currentTakGame` and `gameAfter` deleted; the seven call sites (playMove, resign, acceptDraw, requestTakeBack, exportGame, gameView, summarise) call the loader; `corrupt-record` is wrapped as `game ${id}` (message style preserved) and mapped 500.
- [x] Web: the export TPS branch uses `stateAfter`; the PTN prefix branch slices the loaded history (it needs no state at all).
- [x] Core tests (`core/test/load.test.ts`): the flagship invariant — *loaded state ≡ fully-replayed state* across empty / imported-only / live-only / imported+live records; result mapping for every `ResultCode`; `stateAfter` at 0 / fixedMoves / mid / total; corrupt input → `corrupt-record`.
- [x] Web tests: `games.test.ts` stays green unchanged (the module interface is the test surface); the export tests and the position-write test (`:961`) become the fast-path regression net.
- [x] No CONTEXT.md change: the loader is mechanics, and "Game record" already names the data it reconstitutes.

## Comments

**2026-08-18 — Design note.** From the architecture review (opportunity: materialize the playable game in one module) and the grilling rounds. Read ADR-0005 (`docs/adr/0005-game-materialization.md`) before designing.

- **The two replay paths were a live contradiction.** `currentTakGame` (replay every stored move) and `gameAfter` (replay to move N) did the same work, and `gameAfter`'s own comment claimed "the stored record is the moves, not a per-move snapshot of the board" — while `appendMove` writes a per-move TPS snapshot that nothing ever read. The module is the resolution: the snapshot becomes the read path, the replay becomes the fallback.
- **Reads trust the write seam.** Every snapshot was written from a validated state (`appendMove` stores only after the core accepted the move), so verification happens at the write; replay-on-read was incidental, not designed. Ticket 14 (real-time) re-renders the game view and both lists on every move — with the fast path each refresh is one snapshot read instead of an O(moves) replay.
- **Result parity matters beyond the web.** `coreResign`/`mutualDraw`/`playMove` guard on `game.result`, not the position; a loaded resigned game must know it is finished, or a batch program (ADR-0001) could resign an already-finished game. The stored string maps through the existing `endFromCode`.
- **Corruption is its own fault class.** Today a corrupt stored record surfaces as `persistence` → 500, conflating "SQL failed" with "stored data is corrupt". `corrupt-record` separates them; the web seam composes the game id into the message.
- **The take-back flow needs no special handling.** Accepting a take-back deletes the last row; the new last row's snapshot is exactly the post-undo position.

**2026-08-18 — Implemented.** `loadGame(record)` and `stateAfter(record, n)` in `core/src/aggregate.ts`, over a `StoredGame`/`StoredMove` pair the core owns. `web/src/games.ts` lost both replay implementations; `storedGame` reads the rows, `loadTakGame` hands them to the core, and `recordError` composes the game id onto the core's reason. New core suite `core/test/load.test.ts` (39 tests).

Decisions worth carrying forward:

- **A snapshot carries no verdict, so the loader recovers one.** `parseTps` returns `outcome: null` — TPS records a position, not whether it ended a game. Without recovery a road-won game would load undecided and `isBoardFinished` would lie, breaking the loaded ≡ replayed invariant. The loader calls `computeOutcome(state, opponent(playerToMove), last.type === 'place')`: `advanceTurn` always hands the turn to the mover's opponent, so the mover is exact, and `placed` gates only the reserve-exhaustion branch. `computeOutcome` is now exported from `core/src/game.ts` for this. The `placed` argument is the subtle part and has its own two tests (same snapshot, placement vs stack move → flat win vs open game); a review fuzz of 700 random games found no divergence but never generated reserve exhaustion, which is why those tests are written by hand.
- **The stored result string is authoritative, with the board as the fallback when it is silent.** `endFromCode` maps the string; where there is none, `boardEnd` of the loaded state still applies, because a won position ended the game whether or not the store got the word out — and that is what the replay path reported.
- **The imported record's own `[Result]` tag is dropped.** It ends the *original* game, not this one. Keeping it made an imported record tagged `1-0` load as already-resigned, so the first live move was refused — a latent bug the old fold carried.
- **`StoredGame`, not `GameRecord`.** The web already has a `GameRecord` (with ids, share flags, lifecycle); one name over two shapes would have forced an alias at the only file that imports both.
- **`invalid-move-number` joined the core union** beyond the ticket's `corrupt-record`: `stateAfter` must answer a move number outside the record, and that is a caller error, not corruption. The web range-checks before asking, so it does not surface.
- **`isInternal` in `web/src/actions.ts`** — "mapped 500" needed more than `statusForGameError`: the form and page adapters short-circuit on the error code, so `corrupt-record` had to join `persistence` there or a corrupt record would have re-rendered a form.
- **The wrapped message reads `game N: <reason>`** rather than the old `stored move 2 for game N no longer parses`. The reason is the core's to phrase now, and the id can only go on the front or the back of it.

Known limits:

- **Not O(1), only replay-free.** `loadGame` still parses every stored notation to build `history`, so `summarise` — which wants nothing but `playerToMove` — stays O(moves) in regex, though no longer in board replay. Giving the lists a state-only read is a follow-up, not this ticket.
- `games.test.ts` needed no edits to stay green, as the ticket predicted; it gained four tests for the new `corrupt-record` seam, including one that proves the fast path never reads an earlier snapshot.
- Reviewed via `/code-review`. Standards found no hard violations; its duplicated-numbering and dead-closure findings are fixed, and `docs/design.md`'s TPS line now says the parser is on the read path. Spec confirmed the fast path recovers reserves, `opened`, the move counter, and the outcome; its two substantive findings — every core code collapsing to `corrupt-record`, and a decided position loading as unfinished — are both fixed above.
