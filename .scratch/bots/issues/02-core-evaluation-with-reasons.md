# 02 — Core: evaluation with reasons + the strategy seam

**What to build:** A heuristic evaluation of a position from a side's perspective that returns a **score plus decomposable reasons**, and the strategy interface both the web bot and the training harness consume. Reasons are load-bearing: the coach (09) displays them, and a future neural evaluator must implement the same interface (score + supporting evidence) so nothing downstream changes when the heuristic is swapped. Spec: `.scratch/bots/spec.md`.

**Blocked by:** 01 — Core: legal-moves (evaluation is exercised over legal moves; the seam's move-selection half needs the generator).

**Status:** ready-for-agent

- [ ] `evaluate(state, side): Evaluation` where `Evaluation = { score, reasons: readonly Reason[] }`; `Reason` names a factor (material, road progress, mobility, …) and its contribution, so a one-line human summary can be drawn without reading the score.
- [ ] The heuristic is a real Tak heuristic, not a token: material, road progress toward both edges, stack control, mobility — at least enough that Casual (03) is visibly better than random play (verify via the training harness once it exists).
- [ ] The strategy interface lives in core: `(position, side, config) → move` (config carries level/limits/seed), so web (bot executor, coach) and `train` share one vocabulary.
- [ ] Determinism: evaluation is pure; any randomness enters only through the strategy's seeded RNG.
- [ ] Tests: score monotone on simple material/road cases; reasons decompose into the factors they claim; interface is exercised by a stub strategy that always picks a legal move.

## Comments

**2026-08-19 — Specified in grilling.** The "reasons, not just a number" constraint was set now because retrofitting it later would reshape the seam; it was the user's stated coach intent ("a next move suggesting coach or a game explaining coach") plus the future NN stage.
