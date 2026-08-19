# 05 — CLI: `train run` and `train summary`

**What to build:** The two commands wiring 01–04: `train run --games N --p1 <strategy> --p2 <strategy> --size 5|6 --seed S [--out DIR]` plays and records (alternating seats, deterministic under the seed); `train summary [--dir DIR]` aggregates a run directory. Argument parsing and wiring only — all behaviour lives in the modules. Spec: `.scratch/bot-training/spec.md`.

**Blocked by:** 04 — records and stats (the output the commands produce).

**Status:** ready-for-agent

- [ ] `train run`: validates strategies (known names), sizes, and seed; alternates seats; writes the run directory per 04; prints a short human summary (N games, wins, time).
- [ ] `train summary`: aggregates a run directory per 04; exits non-zero with a clear message on a missing/invalid directory.
- [ ] Strategy names resolve through one registry (core strategies + training-only ones) so the CLI never hardcodes a strategy.
- [ ] Determinism end to end: `train run` twice with the same arguments writes byte-identical output.
- [ ] Tests: CLI-level (argument errors, unknown strategy, invalid size) plus the determinism property; happy paths covered through the module tests of 02–04.

## Comments

**2026-08-19 — Specified in grilling.** Command surface confirmed. A terminal `play` command (human vs bot in the shell) is out of scope — the web is the human interface.
