# 08 — Ranked / unranked categorisation

**What to build:** Every game carries a **ranked** categorisation, decided at proposal and immutable: **bot games are always unranked** (no computer result can pollute a future human rating); **human proposals default to ranked** with an **unranked option** on the propose form (for over-the-shoulder coaching and casual exploration); the categorisation shows as a small tag in the lists. No rating math anywhere yet — the flag is stored data a future ratings spec consumes, alongside game stats and the activity trail (the tak-host spec's declared seed data). Spec: `.scratch/bots/spec.md`.

**Blocked by:** None (the propose command and lists exist; the bots of 04/05 simply always create unranked games).

**Status:** ready-for-agent

- [ ] The proposal carries a `ranked` flag; the propose form offers ranked (default) / unranked for human games; bot games are forced unranked by construction (the executor's proposal path sets it).
- [ ] The flag is immutable for the game's life and recorded with the game record.
- [ ] Ranked games should not be deleted even if hidden by both players. Include a show all ranked games even if hidden option in the games filters.
- [ ] A small tag in the lists ("ranked" / "unranked") and on the game page; hidden or shown per the list's existing density (match the "imported" tag pattern).
- [ ] Tests at the HTTP seam: human proposal defaults ranked; unranked option persists; a bot game is never ranked; the tag renders.

## Comments

**2026-08-19 — Specified in grilling.** The user's addition: humans can also propose **unranked** games ("useful for human over-the-shoulder coaching, and exploring in a non-competitive way"). Bot games always unranked; categorisation/ranking may later extend to human players (future ratings spec).
