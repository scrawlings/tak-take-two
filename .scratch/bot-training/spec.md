# Spec — Bot training: a headless harness

Status: ready-for-agent

## Problem Statement

The bots spec (`.scratch/bots/spec.md`) builds a computer opponent. Before trusting its strength — and before any future neural stage — we need to *measure* it: play it against itself, against random play, against its own variants, and capture the games and the numbers. This needs a headless harness: no web, no humans, just strategies, a driver, and records. The approach is not settled (a neural stage may or may not follow, and if it does its shape is unknown), so **modularisation is a first-class requirement**: clear seams and a minimal surface, so the harness can be reshaped without rework.

## Solution

A new **`train` workspace package** (sibling to `core` and `web`) that imports only `core`'s public API. It consists of:

- **Strategy interface** — the same seam the bots spec defines: `(position, side, config) → move`. `train` implements *training-only* strategies (random-legal baseline, a greedy variant) against it; the bots spec's Casual/Standard/Strong strategies (in core) plug in unchanged. The interface lives in core so web and train share it.
- **Driver** — plays N games between two strategies, alternating seats, feeding each move through `core`'s `applyMove` until the game finishes; captures the PTN record and per-game stats.
- **Records & stats** — flat files: one PTN per game, one JSONL line per game, and an aggregate summary.
- **CLI** — `train run` and `train summary`.

Seeded, deterministic: same seed + same configs ⇒ identical games, byte-for-byte.

### What a run produces

- `games/<nn>.ptn` — the record (via core's PTN generation), human-readable and portable.
- `games.jsonl` — one line per game: winner (and how), seats, move count, duration, board size, seed, both strategy configs.
- `summary.json` — aggregate win rates (and per-seat), result distribution, average game length, throughput (games/sec).

### Commands

- `train run --games N --p1 <strategy> --p2 <strategy> --size 5|6 --seed S [--out DIR]` — play and record.
- `train summary [--dir DIR]` — aggregate a run directory.

## User Stories

1. As an engine developer, I want to measure the bot against random play, so that I know it is doing something.
2. As an engine developer, I want to measure the bot against itself and its variants, so that I can compare strength changes.
3. As an engine developer, I want alternating seats in every match, so that first-move advantage does not masquerade as strength.
4. As an engine developer, I want reproducible runs, so that a claimed result can be replayed exactly.
5. As an engine developer, I want the games as PTN, so that I can read, share, and import what the engines played.
6. As an engine developer, I want per-game and aggregate numbers, so that I can judge progress without reading games.
7. As an engine developer, I want to plug a new strategy in behind the same interface, so that the harness does not need to change for the next idea.

## Implementation Decisions

- **`train` is a consumer of core's public API** — it never imports core internals, and never touches web. The core package stays the single source of rules; the harness is pure orchestration and I/O.
- **The strategy interface is defined in core** (with the bots spec), so the web bot, the coach, and the harness all speak one vocabulary. `train` implements only *training-only* strategies (random-legal, greedy variants); the strength levels come from core.
- **Seams, and why they are where they are** (modularisation is the point — see Problem Statement):
  - *Strategy* — the decision-maker, configurable and swappable. A neural strategy replaces the heuristic here, behind the same signature.
  - *Driver* — one game as a loop over `strategy → applyMove → finish?`. It knows nothing about how moves are chosen.
  - *Records* — PTN/JSONL writing, owned by the driver's output contract, not by strategies.
  - *Stats* — pure aggregation over the JSONL lines; no knowledge of Tak.
  - *CLI* — argument parsing and wiring only.
- **Flat files, not the database.** Training games do not touch the site's SQLite (no game stats rows, no activity trail). Database integration and dataset export (positions→moves for an external trainer) are deferred until a neural stage is actually decided.
- **Seeding:** a single seed parameter drives all randomness; configs record the seed so a summary line is a complete reproduction recipe.
- **Node, vitest, zero new dependencies** unless forced; the package mirrors the workspace conventions of `core`/`web`.

## Testing Decisions

- **Driver:** short seeded games complete; the recorded PTN re-parses through core's `parsePtn` to the same final position; seats alternate correctly; two runs with the same seed and configs produce byte-identical PTN.
- **Strategies:** every chosen move applies cleanly (`applyMove` succeeds); random-legal covers varied positions (not just the opening).
- **Stats:** aggregation math asserted against hand-built JSONL fixtures; a run directory with no games errors clearly.
- **Cross-spec:** the harness is run against core's Casual/Standard/Strong strategies (from the bots spec) in an integration test — proving the seam works for real strategies, not just training-only ones.

## Out of Scope

- Neural-network training and dataset export (deferred; the seams above are where it would slot in).
- Writing training results into the site's game-stats or activity trail.
- Opening books, endgame tables, move-time limits.
- A terminal `play` command (human vs bot in the shell) — the web is the human interface.
- Anything in the web layer.

## Further Notes

- The batch runner and the evaluation runner are the same harness with different opponents: `--p2 random-legal` measures absolute competence; `--p2 <same config>` measures consistency; `--p2 <new variant>` measures relative change.
- The "how many games is enough" question is deliberately not answered here — the summary's per-seat breakdown exists so that question can be *asked* with data.
