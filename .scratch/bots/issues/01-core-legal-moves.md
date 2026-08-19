# 01 — Core: all-legal-moves generation

**What to build:** The headless legal-move generator the core was built to host (ADR-0001 called it "a list-segmentation problem to be memoized"): for a position, all legal moves for the side to move — placements from the reserve (respecting the opponent-stone opening) and every stack move (lift counts, straight-line paths, drop distributions, capstone flatten). Memoized/composed so repeated calls on similar segments are cheap. This is the load-bearing piece for the engine (03), the web bot executor (05), the coach (09), and the training harness. Spec: `.scratch/bots/spec.md`.

**Blocked by:** None — the rules engine (`createGame`/`applyMove`/`getStack`), PTN, and TPS all exist.

**Status:** ready-for-agent

- [ ] `legalMoves(state)` returns every move `applyMove` would accept on that position — exhaustively cross-checked: the generated set equals the set of accepted moves (property test over many positions and both openings), never a superset or subset.
- [ ] Covers: placements (all stone kinds, reserve limits, opponent-stone opening on each side's first turn), stack moves (every lift count ≤ min(carry, stack height), every straight-line path that does not cross standing stones/capstones, every drop distribution with ≥ 1 per crossed square summing to the lift), capstone flattening (alone, onto own or opponent's standing stone), no pass.
- [ ] Memoization/composition per ADR-0001 — the path/drop enumeration is segmented so a position's repeated stack segments are computed once; performance is good enough for search (see 03) without being a contest entry.
- [ ] Every generated move round-trips through `parseMove`/`formatMove` identically (the existing discipline in the codebase).
- [ ] Tests in `core/test/`: the cross-check property above, perft-style move-count invariants on small positions, and the opening cases (P1 must place an opponent stone; P2's first turn too).
- [ ] Export through `core/src/index.ts`; no I/O, no exceptions — the typed-functional style holds.

## Comments

**2026-08-19 — Specified in grilling.** First ticket of the bots spec; ADR-0001 explicitly anticipated this as the memoized list-segmentation problem. Training ticket `bot-training/02` needs this for its random-legal baseline.
