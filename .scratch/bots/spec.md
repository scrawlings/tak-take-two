# Spec — Bots: computer opponents and a move-suggesting coach

Status: ready-for-agent

## Problem Statement

The site hosts human games only. The README names computer opponents and coaches as the intended next step, and the core was deliberately built for this ("future tournament and training programs run it headless", ADR-0001) — the legal-move generator it anticipated does not exist yet. Separately, the game record carries no notion of what a game "counts" for, which matters the moment computers play: bot games must never pollute a future human rating.

This spec delivers: a **headless computer opponent** (heuristic search, three strength levels, deterministic), played through **bot accounts** that reuse the entire game lifecycle; a **ranked/unranked categorisation** on games (bot games always unranked, humans may propose unranked games); a **humans-only** proposal flag; and a minimal **move-suggesting coach** on the game screen. A neural-network engine is a later stage: the strategy seam here is designed so a learned evaluator can replace the heuristic behind the same interface. Batch training is a separate spec (`.scratch/bot-training/spec.md`).

## Solution

### Legal-move generation (core)

`core` gains all-legal-moves generation for a position — the list-segmentation problem ADR-0001 anticipated, memoized. This is the load-bearing piece for the engine, the training harness, and the coach.

### Evaluation with reasons (core)

`core` gains a heuristic evaluation of a position from a side's perspective: a score plus **decomposable reasons** (which factors moved the score — material, road progress, mobility, …). Reasons are not decoration: the coach displays them, and a future neural evaluator implements the same interface (score + supporting evidence), so nothing downstream changes when the heuristic is swapped.

### Search strategies (core)

Three named strengths over the evaluator, deterministic and seedable:

- **Casual** — greedy 1-ply: pick the move whose resulting position evaluates best.
- **Standard** — shallow alpha-beta search.
- **Strong** — deeper alpha-beta, time-boxed.

Same position + same seed + same level ⇒ same move, every time.

### Bot accounts (web)

Bots are accounts with role `bot`, seeded by a CLI command in the bootstrap-admin style (generated identity printed to its own terminal; no password, cannot sign in, cannot be blocked meaningfully). There are **three** bot accounts — one per strength level — with distinct display names, so the existing invite-by-display-name path needs no special-casing. A bot's share toggle is always on (bots have no privacy); its games are spectatable once the human shares. Bots never propose games, never auto-join open games, and never self-play.

### The bot plays (web)

When a game is in play and it is a bot's turn, the server computes the bot's move headlessly and records it — synchronously, in the same request that recorded the human's move. Unlimited concurrency (one engine instance per game, no shared state). The bot's disposition:

- **Take-back requests: always accepted** (a courtesy feature, not a fight).
- **Draw offers: declined unless the bot is clearly losing** (evaluation below a fixed threshold), then accepted.
- **Never resigns, never offers a draw, never proposes.**

### Playing the computer (web)

A **"Play the computer"** affordance on the games page opens the propose form pre-filled as an invitation to the chosen bot (level picker; defaults 6×6, you start). The ordinary invite path also works — inviting a bot by display name is just an invitation the bot auto-accepts.

### Humans-only proposals (web)

The propose form gains a **"Humans only"** checkbox (default off), recorded on the proposal. Enforcement: a bot **declines an invitation** to a humans-only game (the proposal stays waiting), and bots are barred from such games by construction. (Today bots never auto-join anything, so this is the flag's only teeth; it future-proofs open games too.)

### Ranked / unranked (web)

Every game carries a **ranked** categorisation:

- **Bot games are always unranked** — no computer result can ever pollute a future human rating.
- **Human proposals default to ranked**, with an **unranked option** on the propose form (for over-the-shoulder coaching and casual exploration).
- The categorisation shows as a small tag in the lists.
- No rating math anywhere yet — the flag is stored data that a future ratings spec consumes (with game stats and the activity trail, per the tak-host spec's seed-data note).

### Move-suggesting coach (web)

On the game screen, when it is the viewer's turn, a **"What would TakBot play?"** affordance asks the engine (Standard) for its move and a one-line reason, previews it on the board, and can apply it as the viewer's move. Players only — spectators don't get it. Game-explaining (natural-language review of a whole game) is a separate future spec; this slice is deliberately minimal.

## User Stories

1. As a player, I want to play a computer opponent at a chosen strength, so that I can practise between human games.
2. As a player, I want the computer to take its turn without ceremony, so that a bot game advances like a human game.
3. As a player, I want to invite a bot by name like any other opponent, so that I am not learning a second mental model.
4. As a player, I want my bot games never to count as ranked, so that my record stays meaningful when ratings arrive.
5. As a player, I want to propose an unranked game against a human, so that I can coach over the shoulder or explore without stakes.
6. As a player, I want to mark a proposal humans-only, so that a bot can never join it.
7. As a player, I want the bot to accept my take-backs and to answer draws sensibly, so that a bot game feels fair.
8. As a player, I want to ask the computer what it would play and why, so that I can learn from it.
9. As an admin, I want bots seeded by command like the bootstrap admin, so that no credentials exist for them and nothing can sign in as a bot.

## Implementation Decisions

- **The strategy seam is the shape of the future.** `MoveSelector`/evaluator interfaces live in core so the web bot, the coach, and the training harness share them; a neural evaluator replaces the heuristic behind the same interface. The evaluation returns **reasons, not just a number** — that constraint is load-bearing for the coach and for NN-era analysis, and it is set now because retrofitting it later means reshaping the seam.
- **Bots are accounts, not a special game type.** Reuses the whole lifecycle — proposal, seats, visibility, take-backs, draws, resign, hide, exports — unchanged and already tested. The cost is a small seam where a bot's turn is executed.
- **Three accounts, not one with a level setting.** The invite path carries no settings, so a single account could not express strength; three accounts keep "invite by display name" uniform and give each level an identity for free.
- **The bot's move is synchronous in the human's request.** No job queue, no scheduler, no thinking-time delay — deterministic and simple. A delay or clock integration can come with the (deferred) time-controls work.
- **Ranked/unranked is stored on the proposal and decided at creation.** Bot games are forced unranked by construction; humans choose. The flag is immutable for the game's life.
- **Humans-only is enforced at the bot's accept step** — the one place a bot ever enters a game — so no other path can leak a bot into a flagged game.
- **`UserRole` grows to include `bot`**; login, blocking, and admin user management refuse bot accounts rather than half-supporting them.
- **ADR-worthy decisions are noted here, formalised during implementation:** bot-as-player, the strategy/evaluator seam, ranked/unranked as stored categorisation. (Agreed in grilling: specs now, ADRs when there is code to hang them on.)

## Testing Decisions

- **Core (new):** legal-move generation is exhaustively cross-checked against `applyMove` — the generated set equals the set of moves `applyMove` accepts on a position, plus perft-style move-count invariants on small positions; every generated move round-trips through `parseMove`/`formatMove`. The evaluator's score is monotone on simple material/road cases, and reasons decompose into the factors they claim. Strategies are deterministic under a fixed seed and always produce a legal move.
- **Web (HTTP seam):** bot game lifecycle — propose-to-bot lands, the bot moves on its turn, take-back auto-accept, draw decline/accept at the threshold, humans-only invitation refused, unranked enforcement (bot games can never be ranked), coach endpoint returns a legal suggestion. Login refuses bot role; admin user management shows bots but cannot block them.
- **Cross-spec:** the training harness (`.scratch/bot-training/spec.md`) drives the same core strategies through the same interfaces.

## Out of Scope

- Neural-network engine and dataset export — later stages behind the same seam (see `.scratch/bot-training/spec.md` for the harness; dataset export is deferred there too).
- Game-explaining coach (natural-language review) — a separate future spec.
- Ratings for humans — future; this spec only stores the ranked/unranked categorisation.
- Game clocks / thinking time — deferred.
- Opening books, endgame tables, komi, board sizes beyond 5×5/6×6.

## Further Notes

- Difficulty is a search-depth/eval policy, not a different engine — Casual, Standard, and Strong share the code, differing in configuration.
- Seed policy: web bot games seed from the game id (reproducible); training games seed from the CLI (see the training spec).
