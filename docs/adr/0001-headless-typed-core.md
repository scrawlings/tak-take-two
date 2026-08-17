# The game core is a headless, typed module

The Tak rules engine, PTN, and TPS live in a standalone module with no I/O and no framework dependencies, so the same code serves the web app and future batch programs (tournaments, computer-player training). It is written in a typed-functional style: compile-time-constrained domain types (board coordinates indexed by file/rank literal unions), exhaustive unions for stones/directions/outcomes, `neverthrow` `Result` for every failure path, and no exceptions.

Status: accepted

## Considered options

- **Embedding the engine in the web app** — rejected: could not run headless for tournaments/training, which the brief explicitly wants.
- **Exceptions for invalid moves/parses** — rejected: the brief requires `neverthrow`; typed Results keep every failure path explicit and match the no-exception style.

## Note for future work

Generating all legal moves (needed for computer players and training) is a list-segmentation problem: compositions of the lifted count across path lengths. Memoize or precompute the composition table — the input domain (`lift × pathLength`) is tiny on 5×5/6×6 boards. Move *validation* never enumerates alternatives and stays linear in the path length.
