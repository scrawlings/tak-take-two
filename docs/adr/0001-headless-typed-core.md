# The game core is a headless, typed module

The Tak rules engine, PTN, and TPS live in a standalone module with no I/O and no framework dependencies, so the same code serves the web app and future batch programs (tournaments, computer-player training). It is written in a typed-functional style: compile-time-constrained domain types (board coordinates indexed by file/rank literal unions), exhaustive unions for stones/directions/outcomes, `neverthrow` `Result` for every failure path, and no exceptions.

Status: accepted

## Considered options

- **Embedding the engine in the web app** — rejected: could not run headless for tournaments/training, which the brief explicitly wants.
- **Exceptions for invalid moves/parses** — rejected: the brief requires `neverthrow`; typed Results keep every failure path explicit and match the no-exception style.

## Note for future work

Generating all legal moves (needed for computer players and training) is a list-segmentation problem: compositions of the lifted count across path lengths. Memoize or precompute the composition table — the input domain (`lift × pathLength`) is tiny on 5×5/6×6 boards. Move *validation* never enumerates alternatives and stays linear in the path length.

## Note on coordinate types

Files and ranks are literal unions, so an invalid letter or number is a compile-time error. Per-board-size bounds (e.g. `f6` on a 5×5 board) are validated at the API boundary as a typed `Result` — TypeScript has no dependent types, and moves parsed from PTN text must be runtime-validated regardless.
