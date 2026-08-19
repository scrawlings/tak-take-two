# 01 — `train` workspace scaffold: seams and plumbing

**What to build:** The `train` workspace package (sibling to `core`/`web`): the engine boundary (core's public API only — never internals, never web), the strategy interface `(position, side, config) → move` (the same seam the bots spec defines in core), config types, seeded-RNG plumbing, and a stub strategy. Modularisation is a first-class requirement: the seams below exist so the harness can be reshaped when the neural stage (or any better idea) arrives. Spec: `.scratch/bot-training/spec.md`.

**Blocked by:** None (the strategy interface itself lands in core with `bots/02`; this ticket wires against it and can start with a stub until then).

**Status:** ready-for-agent

- [ ] Workspace setup: `train` package in the root `package.json` workspaces, vitest configured, typecheck wired into the root `typecheck` script.
- [ ] Seams, each its own module: *strategy* (decision-maker, configurable + swappable), *driver* (one game as a loop over strategy → `applyMove` → finished?), *records* (PTN/JSONL output contract), *stats* (pure aggregation, no Tak knowledge), *cli* (argument parsing + wiring only).
- [ ] Engine boundary: imports from `core`'s public API only; a lint/typecheck rule or test asserts no deep imports.
- [ ] Config types (strategy name, level/limits, seed, board size) serialisable into the stats line so a run is a complete reproduction recipe; seeded RNG plumbing (single seed drives all randomness).
- [ ] Stub strategy wired through the whole path so a 1-game smoke run works end to end before real strategies land.

## Comments

**2026-08-19 — Specified in grilling.** The user's explicit emphasis: "focus on good modularisation because I'm not really sure what the best approach is yet so flexibility and model clarity has some value beyond functionality here."
