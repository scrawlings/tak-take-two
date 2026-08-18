# 11 — Play: game view, moves, finish

**What to build:** The game screen — board grid and full history, move entry (click builder and PTN text through one validator), automatic win detection, resign, mutual draw, game stats written at finish, and trail events.

**Blocked by:** 09 — Games: propose + PTN import; 10 — Games: find & join

**Status:** done

- [x] The game view renders the position as a grid with the full move history.
- [x] On your turn, a move can be entered via the click builder or PTN text; both go through the core validator and illegal moves are rejected with a clear message.
- [x] A move can only be made by the player whose turn it is, in a game they participate in, while the game is in play.
- [x] Road and flat wins are detected and finish the game with the correct PTN result; resign and mutual draw also finish it.
- [x] Game stats (move count, duration, result, board size) are written when a game finishes.
- [x] Trail events are written for moves, resignations, and draws.

## Comments

**2026-08-17 — Design note.** ADR-0004 (`docs/adr/0004-game-lifecycle-module.md`) fixes the web Game lifecycle seam: routes are thin adapters over a single Game module behind a command-union interface (`applyGame(gameId, actorId, command)`). Build over the Game module. Read the ADR before designing.

**2026-08-18 — Implemented.** The Game module gains `playMove`, `resign`, and `mutualDraw` commands plus a `getGame` query; routes `GET /games/:id`, `POST /games/:id/move|resign|draw`. The core gains `parseMove` (single-move PTN entry validator) and `formatMove` (canonical single-move formatter), so the click builder and PTN text funnel through one validator — `parseMove` → engine `applyMove`.

Decisions worth carrying forward:

- **One load path (architecture-review candidate 2).** `currentTakGame(game)` replays the imported record plus every `game_records` row from its canonical notation, so the board view, the move command, and the list's `toMove` all derive the position the same way. A stored row that no longer parses or replays is corruption, not input.
- **`game_records` stores canonical notation and a TPS snapshot** (`position`), so ticket 15 can export from any move without replay; `move_number` is the 1-based index in the *full* history (imported moves first).
- **Either participant may declare a mutual draw.** The ticket names no agreement protocol (unlike take-back); as on a physical board, agreement is out-of-band and one player records it. Trail event `game-finished` carries `how: resign | mutual-draw | road | flat` for uniform analysis.
- **Every finish writes one `game-finished` trail event plus one `game_stats` row**; every move writes a `move-played` event whose payload carries the result when the move ended the board.
- **The click builder is Alpine, the PTN field is the escape hatch.** Clicking an empty square places the chosen stone; clicking your stack then a straight-line square composes a stack move with 1-per-crossed-square drops and the remainder on the destination — always a syntactically valid move that the engine still validates (it can be illegal, e.g. crossing a wall). The PTN input works with scripting off.

Deferred: take-back (ticket 12), share/hide and admin viewing (13), real-time (14), export (15). The click builder's Alpine logic is covered by rendered-HTML assertions, not browser tests.

**2026-08-18 — After review (UI additions).** The game screen gained, on request:

- **Axes** — files (`a`–`f`) across the top, ranks down the side.
- **Stack tooltips** — hovering a square names its full stack bottom-to-top (`flat (filled) → wall (open) → …`).
- **Distinct glyphs** with a legend — ●/○ flat, ▲/△ wall, ■/□ capstone.
- **Your colour** — the status line names the viewer's seat, using **filled/open**, not black/white (the preferred aesthetic of the offline community): "You play ● (filled)".
- **Opening-turn colour** — on a player's first turn the status says the move places the *opponent's* stone: "your opening move places your opponent's stone (open)".
- **Stones left** — a table of remaining flats and capstones per player.
- **Move-syntax summary** at the bottom of the page.
- **PTN turn numbering** — the history groups both half-moves of a full move behind one `N.` marker, so moves 1 and 2 are both turn 1.
