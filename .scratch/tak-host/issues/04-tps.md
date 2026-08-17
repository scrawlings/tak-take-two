# 04 — Core: TPS

**What to build:** Generate a TPS string for any position, and parse/validate TPS positions structurally and by material consistency. Starting games from a TPS position remains deferred.

**Blocked by:** 01 — Core: board model, place moves, win detection; 02 — Core: stack moves

**Status:** done

- [x] Any position generates a TPS string conforming to the spec (rows top-down, stacks bottom-to-top, x-runs, S/C suffixes, turn, move counter).
- [x] A well-formed TPS string parses back to the same position.
- [x] Structural validation rejects malformed input; material validation rejects impossible positions (stone counts beyond reserves, walls/capstones not on top, too many capstones, etc.).
- [x] Every failure returns a typed error — nothing throws.

## Comments

**2026-08-17 — Completed.** Implemented in commit `72bebaa` and verified this session: `core/src/tps.ts` (`generateTps`, `parseTps`; `TpsError`/`TpsErrorCode` in `core/src/types.ts`), covered by `core/test/tps.test.ts` (18 tests). Generation is total (a typed `GameState` is always a well-formed position) and emits rows top-down with comma-separated cells, `x`/`xN` empty runs, stacks bottom-to-top with a trailing `S`/`C` that modifies the top stone (not a stone itself), then turn and move counter (the move due — matching `GameState.moveNumber`). Parsing derives the board size from the row count, rebuilds a full `GameState` (reserves and opening flags derived from the position), and validates structurally (field count, turn, counter ≥ 1, row count/width, cell grammar — which also forbids standing/capstone not on top) and materially (capstones ≤ 1 per player, stones within each player's reserve, and stone counts the move counter can account for — every move adds at most one stone and the openings always place). The USTak spec's own full example parses, round-trips exactly, and yields the correct reserves. All 112 tests pass; lint and typecheck clean. See `docs/agents/triage-labels.md` for the `done` status convention.
