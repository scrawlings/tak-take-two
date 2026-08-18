# 10 — Games: find & join

**What to build:** Search and join — browse proposed games with filters, join open/invited/own games, and invited-game privacy.

**Blocked by:** 09 — Games: propose + PTN import

**Status:** done

- [x] A player can search proposed games, filtering by board size, open vs invited, and proposer display name; invited games appear only to the designated player.
- [x] A player can join an open game; joining implies sharing (share toggles start on).
- [x] A player can join a game that designates them; such games are hidden from everyone else.
- [x] A player can join their own games.
- [x] A game cannot be joined twice or after it has started; joining starts play with the correct first player.

## Comments

**2026-08-17 — Design note.** ADR-0004 (`docs/adr/0004-game-lifecycle-module.md`) fixes the web Game lifecycle seam: routes are thin adapters over a single Game module behind a command-union interface (`applyGame(gameId, actorId, command)`). Build over the Game module. Read the ADR before designing.

**2026-08-18 — Implemented.** `applyGame` gains `join`; the module gains `searchProposed`. Routes: `GET /games/find` (filters in the query string, so a search is linkable) and `POST /games/:id/join`. The masthead gains a `Find` item beside `Games`.

Decisions worth carrying forward:

- **Share toggles are set at propose time, not join time.** Migration 3 adds `proposer_shared`/`opponent_shared`, both defaulting off. ADR-0003 says "Open games start with both toggles on (joining implies sharing); invited games start with both off" — *start*, i.e. at proposal. So an open proposal is already shared when someone joins it, which is what "joining implies sharing" means. Ticket 13 makes the toggles changeable.
- **Player 1 is the proposer, player 2 the opponent, in every game.** Nothing is stored: the seat is positional (`seatOf`). Whose turn it is comes from the core (`state.playerToMove`), so an imported record with an odd number of half-moves correctly starts on the opponent.
- **An invited proposal is visible to both its ends** — the designated player and the proposer — but joinable only by the designated player. A proposer who cannot see their own proposal could not find or delete it. The proposer is not one of the "other players" ADR-0003 hides it from.
- **An invisible game is reported as `not-found`, not `forbidden`.** Telling a stranger "that game is not for you" would confirm it exists, leaking through the search filter.
- **Double-join is guarded in SQL.** `joinGame` is a conditional `UPDATE ... WHERE state = 'proposed' AND opponent_id IS NULL` returning whether it changed a row, so two racing joins cannot both win and the loser writes no trail event.

Also: nav marking now picks the longest matching prefix, because plain prefix matching lit up both `/games` and `/games/find` on the find page.

Deferred: finished games are still not listed, and the share toggles cannot yet be changed (ticket 13). `positionOf` replays only the imported record — there are no played moves until ticket 11 extends it.

**2026-08-18 — After review.** Three changes came out of the two-axis review:

- **Visibility now reads the share toggles.** `visibleTo` was re-deriving "who may see this" from `joinType`, which agreed with the toggles only by coincidence and would have drifted the moment ticket 13 made them changeable. It is now ADR-0003 to the letter — participants always, everyone else iff both toggles are on — with a test that flips the columns directly and watches the answer change.
- **Find lists what you can join, not merely what you can see.** It previously showed proposers the invitations they had sent, which made the "invitations to me" filter label untrue and stretched the ticket's "invited games appear only to the designated player". Those proposals are already on the proposer's own games page, with a Delete button.
- **The seat convention is in CONTEXT.md**, not just a code comment. Ticket 11 writes moves in PTN, whose direction is written from Player 1's perspective, so "proposer is Player 1" is load-bearing for notation and not only for turn order.

Also replaced `referer` sniffing with a hidden `from` field on the join form, so a refused join returns to the list it was pressed on without depending on a header.
