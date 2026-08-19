# 06 — "Play the computer" affordance

**What to build:** A one-click way to start a bot game from the games page: a level picker (the three bot accounts from 04) that opens the propose form pre-filled as an invitation to the chosen bot — defaults 6×6, you start — while still letting the player adjust board size and seat. The ordinary invite path (inviting a bot by display name) keeps working as-is. Spec: `.scratch/bots/spec.md`.

**Blocked by:** 04 — bot accounts.

**Status:** ready-for-agent

- [ ] A "Play the computer" affordance on the games page with a level choice (Casual / Standard / Strong) mapping to the three bot accounts.
- [ ] It pre-fills the existing propose form (invitation to the chosen bot; board 6×6; you start) — the player can adjust before proposing; nothing special-cased in the propose command.
- [ ] The resulting game is unranked by construction (08) and, unless the player changes it, not humans-only (07).
- [ ] Tests at the HTTP seam: the affordance pre-fills correctly for each level; proposing through it lands as an invitation to the bot; the bot auto-accepts (via 05) and the game starts.

## Comments

**2026-08-19 — Specified in grilling.** Entry UX = both the button (convenience) and the plain invite path (uniform). Defaults 6×6 / you start agreed.
