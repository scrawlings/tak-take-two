# 09 — Games: propose + PTN import

**What to build:** Propose open or invited games from scratch or from a validated PTN record; delete unjoined proposals; the "my games" list.

**Blocked by:** 05 — Core: game aggregate; 07 — Auth: accounts & sessions

**Status:** done

- [x] A player can propose a game on a 5×5 or 6×6 board as open (anyone may join) or invited (one designated player).
- [x] A player can propose a game from PTN; the record is validated by the core and only legal records are accepted; the imported history is fixed.
- [x] The proposer can delete a proposal no one has joined; joined games cannot be deleted this way.
- [x] "My games" shows the signed-in player's proposals and active games.
- [x] Trail events are written for proposals and deletions.

## Comments

**2026-08-17 — Design note.** ADR-0004 (`docs/adr/0004-game-lifecycle-module.md`) fixes the web Game lifecycle seam: routes are thin adapters over a single Game module behind a command-union interface (`applyGame(gameId, actorId, command)`). This ticket gives birth to the web Game module. Read the ADR before designing.

**2026-08-18 — Implemented.** The web Game module is born in `web/src/games.ts`: `applyGame(actor, command)` over a `propose | deleteProposal` union, plus a `listMyGames` read. Routes in `app.ts` (`GET/POST /games`, `POST /games/:id/delete`) only authenticate and render.

Decisions worth carrying forward:

- **Command signature.** ADR-0004 sketches `applyGame(gameId, actorId, command)`, but `propose` has no game to address yet, so the target id rides inside the commands that have one — exactly as `applyAuth(actor, command)` does, which the ADR itself names as the same seam. The actor is a full `SessionUser` (not an id) so authorization needs no extra lookup. Everything the ADR fixes is intact; the ADR says the shape settles at this ticket.
- **Where imported history lives.** New migration 2 adds `games.imported_ptn`. Imported moves cannot go in `game_records`: that table attributes every move to a user (`player_id NOT NULL`) and at proposal time the opponent has not joined. The core aggregate already draws the same line — `fromPtnText` loads the record as `fixedMoves`, and moves played here replay on top — so reconstruction in ticket 11 is `fromPtnText(imported_ptn)` then replay `game_records`.
- **The record is authoritative.** An imported PTN fixes the board size; the form's size selector is ignored when a record is pasted. A record that is already finished is rejected — there is nothing left to play.
- **Invitations name a display name**, not a username: the display name is the public name (CONTEXT.md), and usernames are not meant to be discoverable.
- **Admins are refused** both the propose command and the games page — an Admin is never a Player (CONTEXT.md).

Deferred by design: an invited player cannot yet *see* an invitation addressed to them, and finished games are not listed. Both belong to ticket 10 (find & join) and the game-view/export tickets.

Also generalized `createFormAction` over the module's error type (it was hard-wired to `AuthError`) and gave `renderError` the submitted fields, so a rejected proposal re-renders with the pasted record intact.
