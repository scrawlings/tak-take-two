# 12 — Offer and accept: take-back and draw

**What to build:** The offer-and-accept protocol, shared by two scenarios: **take-back requests** and **draw offers**. One kinded pending request per game — requested by a player, it blocks play until the other player accepts (the request resolves) or rejects (play continues). Both are refused in self-play.

**Blocked by:** 11 — Play: game view, moves, finish; 18 — Self-play in one window

**Status:** done

- [x] One pending request/offer per game (`pending_kind` `take-back` | `draw` + `pending_by`), cleared on accept, reject, resign, or any finish.
- [x] While a request is pending, moves and further requests are refused with a clear message (`request-pending`); the respondent sees Accept/Reject, the requester sees "waiting".
- [x] **Take-back**: a player may request one only of their own last live move, before the opponent moves, while in play; accept deletes the move (the requester moves again), reject leaves it; imported history is never touchable.
- [x] **Draw**: a player may offer a draw while in play; accept finishes the game as `1/2-1/2` (stats + `game-finished`), reject lets play continue.
- [x] Resign stays available while a request is pending and clears it.
- [x] Both are refused in self-play (can't request against yourself).
- [x] Trail events: `take-back-requested` / `-accepted` / `-rejected`; `draw-offered` / `-accepted` / `-rejected`.
- [x] Tests: the full protocol at the module seam (offer → pending → accept/reject, blocking, no-live-move refusal, wrong-respondent, self-play) and the game screen at the HTTP seam (notification, accept/reject routes, take-back undo).

## Comments

**2026-08-17 — Design note.** ADR-0004 (`docs/adr/0004-game-lifecycle-module.md`) fixes the web Game lifecycle seam: routes are thin adapters over a single Game module behind a command-union interface (`applyGame(gameId, actorId, command)`). Build over the Game module. Read the ADR before designing.

**2026-08-18 — Merged scope.** This ticket originally covered take-back alone. The draw-by-agreement button was found to finish the game unilaterally — contradicting CONTEXT.md's "Mutual draw — both players agree" — and the fix is the same lifecycle take-back needs. Merged into one **offer-and-accept** ticket: both are one kinded pending request per game (requested → pending → accepted/rejected → resolve), so they share one mechanism rather than two hand-rolled copies ("two instances make the seam real"). The draw half fixes the unilateral-draw bug; the red regression test for it is the module test "does not finish the game when only one player asks for a draw".

**2026-08-18 — Implemented.** Migration 4 adds `pending_kind` / `pending_by` to games. The Game module's command union gains `requestTakeBack` / `acceptTakeBack` / `rejectTakeBack` and `offerDraw` / `acceptDraw` / `rejectDraw`, replacing the old `mutualDraw` (now `offerDraw`). `playMove` refuses while pending; `finishGameTransaction` clears the pending (so resign clears it too). `getGame` exposes `pending` (kind + requester), `canRespond`, `canResign`, `canOfferDraw`, `canOfferTakeBack`. The game screen shows the pending request with Accept/Reject for the respondent and "waiting" for the requester; the action row is Request take-back / Offer draw / Resign. Routes: `/games/:id/take-back[/accept|/reject]` and `/games/:id/draw[/accept|/reject]`.

Decisions worth carrying forward:

- **One kinded pending request per game** (`pending_kind` + `pending_by`), not per kind — a second request while one is pending is refused (`request-pending`), and the kind dispatches accept/reject.
- **Take-back accept deletes the last `game_records` row.** The board cannot have changed since the request (moves are blocked while pending), so deleting the requester's move restores the prior position; the next `currentTakGame` replay derives it. The core aggregate's `undo` stays the headless construct; the web protocol operates on the record.
- **Resign is always available and clears the pending** — a pending offer must not trap a player who wants out.
- **Self-play refuses both** (already true for draw from ticket 18; now also for take-back).

Deferred: cancelling an offer (the offerer must wait for accept/reject, mirroring take-back); no protocol for "resume" or other future request kinds — the kinded column grows to admit them.
