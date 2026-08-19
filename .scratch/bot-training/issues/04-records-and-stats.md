# 04 — Records and stats: flat-file outputs

**What to build:** The output contract: one **PTN file per game** (`games/<nn>.ptn`, via core's PTN generation), one **JSONL line per game** (winner and how, seats, move count, duration, board size, seed, both configs), and an aggregate **summary** (win rates overall and per seat, result distribution, average game length, throughput). Flat files only — training games never touch the site's SQLite (no game-stats rows, no activity trail). Spec: `.scratch/bot-training/spec.md`.

**Blocked by:** 03 — driver (the per-game data it produces).

**Status:** ready-for-agent

- [ ] A run directory layout: `games/` (PTN), `games.jsonl`, `summary.json`; a run writes its configs (strategies, sizes, seed) into the summary so the whole run is reproducible from the directory alone.
- [ ] Per-game JSONL lines match the driver's stats contract (03 / 01 config).
- [ ] Summary aggregation is pure: win rates (overall and per seat), result distribution, average game length, throughput (games/sec); computed by a stats module with no Tak knowledge.
- [ ] Failure handling: a run interrupted mid-way leaves valid partial output that a later `train summary` can aggregate (skip truncated trailing lines with a warning).
- [ ] Tests: aggregation math against hand-built JSONL fixtures; a run directory with no games errors clearly; PTN files re-parse through core.

## Comments

**2026-08-19 — Specified in grilling.** Flat files agreed; database integration and dataset export are deferred until a neural stage is actually decided (noted in the spec's Out of Scope).
