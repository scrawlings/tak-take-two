# 05 — Bot move executor and disposition

**What to build:** When a game is in play and it is a bot's turn, the server computes the bot's move headlessly and records it — synchronously, in the same request that recorded the human's move. Unlimited concurrency (one engine instance per game, no shared state). Disposition: take-back requests **always accepted**; draw offers **declined unless clearly losing** (evaluation below a fixed threshold), then accepted; **never resigns, never offers a draw, never proposes**. Auto-accepts invitations except to humans-only games (the 07 flag). Spec: `.scratch/bots/spec.md`.

**Blocked by:** 03 — search strategies; 04 — bot accounts.

**Status:** ready-for-agent

- [ ] The turn-execution seam: after any move is recorded, if the game is in play and the side to move is a bot, generate and record its move in the same request (no job queue, no delay); repeated until it is a human's turn or the game finishes.
- [ ] Seed policy: seed from the game id so a bot game is reproducible.
- [ ] Invitation handling: a bot auto-accepts an invitation **unless** the proposal is humans-only (07), in which case it declines and the game stays waiting.
- [ ] Disposition: take-back requests from the human are auto-accepted; draw offers are declined unless the bot's evaluation is below the fixed "clearly losing" threshold, then accepted; the bot never resigns, offers a draw, or proposes.
- [ ] Concurrency: no global bot lock — each game owns its engine instance; a bot can play any number of games at once.
- [ ] Tests at the HTTP seam: bot moves on its turn after a human move (and the game advances to the human again); take-back auto-accept; draw decline/accept at the threshold; humans-only invitation declined; bot never resigns; two simultaneous bot games both progress.

## Comments

**2026-08-19 — Specified in grilling.** Disposition per the user: accept take-backs always (courtesy, not a fight), decline draws unless clearly losing, never resign/offer/propose. Synchronous execution was an implementation decision in the spec (deterministic, no infrastructure).
