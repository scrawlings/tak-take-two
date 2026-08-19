# 04 — Bot accounts: role, seeding, lifecycle

**What to build:** Bots as accounts with role `bot`, seeded by a CLI command in the bootstrap-admin style — generated identity printed to its own terminal, no password, cannot sign in, cannot be blocked. **Three** accounts, one per strength level, with distinct display names, so the existing invite-by-display-name path needs no special-casing. A bot's share toggle is always on. Bots never propose, never auto-join open games, never self-play. Spec: `.scratch/bots/spec.md`.

**Blocked by:** None (schema/role growth is additive; the executor that uses these accounts is 05).

**Status:** ready-for-agent

- [ ] `UserRole` grows to include `bot`; login refuses bot accounts; admin user management lists bots but cannot block them (or blocking is a clean no-op with a note); bots have no password and none can be set.
- [ ] A seed command (sibling to the bootstrap-admin command) creates the three accounts on demand — idempotent, prints their display names; display names chosen so "invite by name" is natural (e.g., "TakBot — Casual" / "Standard" / "Strong").
- [ ] Bots behave as players to the lifecycle: they can be invited (auto-accept in 05), appear as opponents, their games follow normal visibility rules with the bot's share always on.
- [ ] No path lets a bot propose, join an open game on its own, or claim a game — enforced in the module where those actions are decided, not just in the UI.
- [ ] Tests at the HTTP seam: login refuses a bot; admin users page shows bots; a bot cannot appear as a proposer; invite-by-name resolves a bot account.

## Comments

**2026-08-19 — Specified in grilling.** Presence model = **bot accounts** (reuses the whole lifecycle) over a special game type. Three accounts rather than one with a level setting — the invite path carries no settings. Seeding mirrors the bootstrap-admin convention (CONTEXT.md: Bootstrap admin).
