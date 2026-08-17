# 02 — Core: stack moves

**What to build:** Legal stack moves — lifting up to the carry limit from a stack you control, moving orthogonally with drops per square, wall and capstone rules, and the capstone crush.

**Blocked by:** 01 — Core: board model, place moves, win detection

**Status:** done

- [x] A stack move lifts between 1 and the carry limit (board edge length) stones from the top of a stack you control; lifting more, lifting from an opponent-controlled stack, or lifting more than the stack height is rejected.
- [x] Movement is orthogonal in a straight line; at least one stone is dropped on every square crossed; drops sum to the lifted count; zero may remain on the source square.
- [x] Moves cannot cross standing stones or capstones; landing on them is rejected, except a capstone landing alone on a standing stone.
- [x] A capstone crushes only when it is the only stone dropped onto that square — whether moved alone from the start or as the final drop of a stack move.
- [x] Off-board directions, bad drop sequences, and any combination violating the above return typed errors — nothing throws.

## Comments

**2026-08-17 — Completed.** Implemented in commit `969039e` and verified this session: stack-move rules in `core/src/game.ts` (`applyStackMove`: carry limit, drops, standing/capstone crossing, capstone crush), covered by `core/test/stack.test.ts` (14 tests). All checklist items pass. See `docs/agents/triage-labels.md` for the `done` status convention.
