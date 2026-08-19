# 03 — Driver: one game loop, alternating seats

**What to build:** The driver plays one game between two strategies: a loop of `strategy → applyMove → finished?`, starting from an empty board of the chosen size, with seats **alternating per game** so first-move advantage never masquerades as strength. It captures the PTN record (core's `toPtn`) and per-game stats (winner and how, seats, move count, duration, board size, seed, both configs), and refuses to loop forever (a sane move cap with a clear error, since a draw by repetition is not a thing in Tak but bugs are). Spec: `.scratch/bot-training/spec.md`.

**Blocked by:** 01 — train scaffold; 02 — baseline strategies (needs at least two strategies to drive).

**Status:** ready-for-agent

- [ ] `playGame(p1, p2, size, seed)` → record + stats; both openings honoured (the core enforces the opponent-stone opening; the driver just alternates turns).
- [ ] Alternation: callers request which side starts; the run mode (04) alternates per game.
- [ ] PTN via core's `toPtn`; per-game stats line per the 01 config/records contract.
- [ ] Move cap: a game that exceeds the cap (configurable, generous) errors loudly instead of hanging.
- [ ] Tests: a short seeded game completes; the recorded PTN re-parses through core's `parsePtn` to the same final position; two runs with the same seed and configs produce byte-identical PTN; seat alternation is honoured by the caller.

## Comments

**2026-08-19 — Specified in grilling.** The runner and the evaluator are the same harness with different opponents (agreed in Q5): random-legal measures absolute competence, same-config measures consistency, variants measure relative change.
