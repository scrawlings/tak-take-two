# 15 — Export PTN/TPS

**What to build:** Copy the game as PTN (full game or prefix from any move) or TPS (position after any move), with trail events.

**Blocked by:** 03 — Core: PTN; 04 — Core: TPS; 11 — Play: game view, moves, finish

**Status:** done

- [x] From any move in the history, a player can copy the PTN up to and including that move, or the TPS of the position after that move.
- [x] Exported PTN of a full game is valid and replayable (it re-validates on import); exported prefixes validate too.
- [x] Exported TPS round-trips through the TPS parser.
- [x] Trail events are written for exports.

## Comments

**2026-08-17 — Design note.** ADR-0004 (`docs/adr/0004-game-lifecycle-module.md`) fixes the web Game lifecycle seam: routes are thin adapters over a single Game module behind a command-union interface (`applyGame(gameId, actorId, command)`). Build over the Game module. Read the ADR before designing.

**2026-08-18 — Implemented.** An `export` command on `applyGame` (`web/src/games.ts`) taking a format and an optional `throughMove` (1-based over the full history; `0` is the starting position, absent is the whole game), returning `{ format, text, throughMove, totalMoves }`. `GET /games/:id/export` renders it on a copy-out page; every move in the history carries a PTN/TPS link pair.

Design notes not spelled out in the ticket:
- Export is a **command**, not a query, purely because CONTEXT.md lists exports in the activity trail and ADR-0004 requires trail writes to live inside command implementations. It is still a GET, so a record stays linkable; the links carry `rel="nofollow"` so crawlers don't fill the trail.
- It does **not** reuse core's `toPtn`. The aggregate only knows endings the board shows, but resignations and agreed draws live in the games table — so the result code comes from the record, and a prefix deliberately omits it rather than claiming a finish those moves never reached.
- The PTN names both seats (`[Player1]`/`[Player2]`); a record that doesn't name its players is a move list, not a game record. That forced a **core fix**: `generatePtn` wrote tag values unescaped while `parsePtn` unescapes them, so a display name containing `"` or `\` (both reachable — names are only length-checked) produced a record that would not re-import. `isResultCode` is now exported from core rather than restated in the web layer.
- No `[Date]` tag: for a PTN-imported game the only date to hand is the *proposal's*, which would misattribute the imported moves.
- Visibility reuses one `loadVisibleGame` shared with the game view, so exporting can never read a game you couldn't already open; admins may export any game.
- Known limit: a full export of a game won on the board re-validates through the parser but the site's own import refuses it ("ends in a won position"). That is CONTEXT.md's decided-position rule, not an export defect.
- Reviewed via `/code-review`. Standards flagged the duplicated result-code list (fixed by exporting core's `isResultCode`), a duplicated view type (fixed with `GameExport`), and a clipboard call that fails silently off HTTPS (fixed — the Copy button now only appears where the API exists). Spec found no logic bugs and flagged the tags as scope creep; `[Date]` was dropped, the player names kept for the reason above.
