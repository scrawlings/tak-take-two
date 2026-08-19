# 07 — "Humans only" proposal flag

**What to build:** A "Humans only" checkbox on the propose form (default off), recorded on the proposal. Enforcement: a bot **declines an invitation** to a humans-only game (the proposal stays waiting), and bots are barred from such games by construction — the accept step is the only place a bot ever enters a game, so that is where the flag is enforced. Today this is the flag's only teeth (bots never auto-join anything); it future-proofs open games too. Spec: `.scratch/bots/spec.md`.

**Blocked by:** 04 — bot accounts.

**Status:** ready-for-agent

- [ ] Proposals carry a `humansOnly` flag, set from a propose-form checkbox (default off); stored with the proposal.
- [ ] The bot's invitation-accept step (05) refuses humans-only games — the invitation is declined and the game stays waiting, with the human seeing why.
- [ ] The flag is part of the game record (visible on the game page and in lists) so the restriction is discoverable.
- [ ] Tests at the HTTP seam: a humans-only proposal can be invited to a human and played normally; a bot invitation to it is refused; the default (unchecked) proposal is bot-invitable.

## Comments

**2026-08-19 — Specified in grilling.** Default off, enforced at the bot's accept step, recorded on the proposal — all as recommended. The user added the flag so human-proposed games can be explicitly bot-free; since bots never auto-join, it is the invite path plus future-proofing.
