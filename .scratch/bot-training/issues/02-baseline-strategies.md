# 02 — Baseline strategies: random-legal and greedy variants

**What to build:** The *training-only* strategies in `train` against the shared strategy seam: **random-legal** (the evaluation opponent — any move uniformly at random from `legalMoves`, seeded) and a **greedy variant** (1-ply best-by-evaluation). The bots spec's Casual/Standard/Strong strategies live in core and plug in unchanged; these live in `train` because only the harness needs them. Spec: `.scratch/bot-training/spec.md`.

**Blocked by:** 01 — train scaffold; `bots/01` — core legal-moves (random-legal needs the generator).

**Status:** ready-for-agent

- [ ] `random-legal`: uniform over `legalMoves(state)`, seeded; every chosen move applies cleanly.
- [ ] `greedy`: 1-ply best-by-evaluation (via the core evaluator, `bots/02`); deterministic under a fixed seed.
- [ ] Both expose the same config shape as core strategies, so the driver (03) treats all strategies identically.
- [ ] Tests: legality of every chosen move across varied positions; determinism under a fixed seed; random-legal actually varies (two seeds differ); greedy beats random-legal in a smoke match series (a real comparison comes from `train run` + the harness).

## Comments

**2026-08-19 — Specified in grilling.** These are the harness's yardsticks; the strength levels come from core (bots spec), proving the seam works for real strategies, not just training-only ones.
