# 13 — Share, hide, admin delete

**What to build:** The share toggle, hide (both hidden → delete), admin deletion with a warning, and admins viewing any game.

**Blocked by:** 10 — Games: find & join; 11 — Play: game view, moves, finish

**Status:** done

- [x] Each player has a share toggle on each game; a game is viewable by non-participants iff both toggles are on; open games start shared, invited games unshared; toggles can be changed at any time.
- [x] Hiding a game removes it from your views and turns your share off; if both players hide it, the game is deleted.
- [x] Admins can delete any game; affected players see a clear "removed by an admin" warning on the game view and in their lists.
- [x] Admins can view any game regardless of share state.
- [x] Trail events are written for share changes, hides, and deletions.

## Comments

**2026-08-17 — Design note.** ADR-0004 (`docs/adr/0004-game-lifecycle-module.md`) fixes the web Game lifecycle seam: routes are thin adapters over a single Game module behind a command-union interface (`applyGame(gameId, actorId, command)`). Build over the Game module. Read the ADR before designing.

**2026-08-18 — Implemented.** Added `share`, `hide`, and `adminDelete` to the `applyGame` command union (`web/src/games.ts`), plus `viewerShared`/`canHide`/`canAdminDelete`/`adminRemoved` on `GameView`/`GameSummary` for the templates. New persistence: `proposer_hidden`/`opponent_hidden`/`admin_removed` columns (migration 5), and `setGameShare`/`hideGame`/`adminRemoveGame` on `Persistence`. `listGamesForUser` now also returns admin-removed games and excludes each side's own hidden rows.

Design notes not spelled out in the ticket:
- Hide is reversible (CONTEXT.md) via the `share` command: turning share back on clears that side's hidden flag. There is no dedicated "hidden games" list to browse back from — reversal needs the game's URL. Left as a known gap rather than adding an unrequested list page.
- A not-yet-joined invited player can pre-set their side's share/hide before joining (they already count as a participant per `isParticipant`). Joining now always clears both sides' hidden flags (`joinGame`), so a pre-join hide can't strand the game invisible in either player's list after it starts.
- Admin removal is a soft mark (`state='finished'`, `admin_removed=1`), not a row delete, so the "removed by an admin" warning has something to render; a real prior result (e.g. resignation) is preserved rather than overwritten. Mutual hide, by contrast, is a hard delete — both sides chose it, so nobody needs telling.
- Reviewed via `/code-review` against `HEAD` (uncommitted diff): Standards axis was clean; Spec axis flagged the join/hide interaction above (fixed) and an unreachable `finished` branch in `gameStatusTag` (removed) before commit.
