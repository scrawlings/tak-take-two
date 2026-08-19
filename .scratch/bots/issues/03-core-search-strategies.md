# 03 — Core: search strategies (Casual, Standard, Strong)

**What to build:** The three named strength levels over the evaluator (02): **Casual** (greedy 1-ply — pick the move whose resulting position evaluates best), **Standard** (shallow alpha-beta), **Strong** (deeper alpha-beta, time-boxed). Deterministic and seedable: same position + same seed + same level ⇒ same move, every time. All three share the code, differing in configuration. Spec: `.scratch/bots/spec.md`.

**Blocked by:** 01 — legal-moves; 02 — evaluation.

**Status:** ready-for-agent

- [ ] `selectMove(state, config): Move` for each level via the 02 strategy seam; the search is bounded (depth for Casual/Standard; depth + wall-clock budget for Strong) so a web bot turn is fast.
- [ ] Determinism: a fixed seed yields the same move from the same position at every level; seeded PRNG is the only randomness source.
- [ ] Alpha-beta ordering uses the evaluator so Standard/Strong are strictly better than Casual in practice — verified by a match series (this is what the training harness will measure; a coarse sanity check in core tests is enough here).
- [ ] Strong's time-box degrades gracefully (returns the best move found so far) rather than failing.
- [ ] Tests: every selected move is legal (`applyMove` accepts it); determinism under a fixed seed; level configs are valid (depth ≥ 1, budget > 0); time-box smoke test.

## Comments

**2026-08-19 — Specified in grilling.** Strength = search depth/eval policy, not a different engine. Determinism + seedability was the user's requirement ("training needs this"). Difficulty levels confirmed: Casual/Standard/Strong.
