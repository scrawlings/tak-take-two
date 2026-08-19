# 09 — Coach slice: "What would TakBot play?"

**What to build:** On the game screen, when it is the viewer's turn, a "What would TakBot play?" affordance: asks the engine (Standard level) for its move and a one-line reason, previews the move on the board, and can apply it as the viewer's move. Players only — spectators don't get it. This is deliberately the minimal coach slice; game-explaining (natural-language review of a whole game) is a separate future spec. Spec: `.scratch/bots/spec.md`.

**Blocked by:** 03 — search strategies (and 02's reasons, which the one-line explanation draws from).

**Status:** ready-for-agent

- [ ] When the viewer may move, the game screen offers the suggestion; it is rendered from the engine (Standard), not from stored data — the suggestion is always current for the position.
- [ ] The response includes the move and a one-line reason (from 02's `Reason`s); the move previews on the board through the existing builder affordances.
- [ ] "Play it" applies the suggested move through the normal move path (the server remains the single validator — the suggestion is text in the move field, not a privileged action).
- [ ] Spectators and non-movers get nothing; the affordance is absent outside the viewer's turn.
- [ ] Tests at the HTTP seam: the suggestion endpoint returns a legal move for the position plus a reason; "play it" records the move normally; spectators are refused.

## Comments

**2026-08-19 — Specified in grilling.** Placement agreed: a minimal suggest-a-move ticket in the bots spec; the game-explaining coach deferred to its own spec. The reason-exposing eval seam (02) is load-bearing for this and for the NN era.
