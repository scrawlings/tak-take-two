# 11 — Play: game view, moves, finish

**What to build:** The game screen — board grid and full history, move entry (click builder and PTN text through one validator), automatic win detection, resign, mutual draw, game stats written at finish, and trail events.

**Blocked by:** 09 — Games: propose + PTN import; 10 — Games: find & join

**Status:** ready-for-agent

- [ ] The game view renders the position as a grid with the full move history.
- [ ] On your turn, a move can be entered via the click builder or PTN text; both go through the core validator and illegal moves are rejected with a clear message.
- [ ] A move can only be made by the player whose turn it is, in a game they participate in, while the game is in play.
- [ ] Road and flat wins are detected and finish the game with the correct PTN result; resign and mutual draw also finish it.
- [ ] Game stats (move count, duration, result, board size) are written when a game finishes.
- [ ] Trail events are written for moves, resignations, and draws.
