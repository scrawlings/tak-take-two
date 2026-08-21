# Domain Glossary

A glossary of Tak and this system's domain terms. Vocabulary for the game itself follows the official Tak rules as published by Cheapass Games (2016/2017) and documented by the USTak Association (ustak.org). This file is a glossary only — no implementation details.

## The Game

- **Tak** — a two-player abstract strategy game created by James Ernest and Patrick Rothfuss. Players build "roads" while blocking their opponent; stones are stacked to capture territory.
- **Board** — square playing surface of even size n×n; squares connect only orthogonally (no diagonal adjacency). This system supports **5×5** and **6×6** boards.
- **Stone** — a game piece. Each player has a fixed reserve depending on board size (5×5: 21 stones + 1 capstone; 6×6: 30 stones + 1 capstone). Three types:
  - **Flat stone** — lies flat; counts toward a road; may be stacked upon.
  - **Standing stone** — stands on edge; does not count toward a road; nothing may land on it except a capstone flattening it.
    _Avoid_: wall (informal)
  - **Capstone** — counts toward a road; may flatten a standing stone (own or opponent's) by landing on it alone; nothing may be placed on top of it.
- **Stack** — multiple stones on one square; controlled by the player who owns the top stone.
- **Carry limit** — the most stones a player may lift in one stack move; equal to the board edge length (5 or 6).
- **Place** — put a stone from your reserve onto any empty square. On each player's *first turn only*, they must place one of their **opponent's** flat stones; thereafter they place their own stones. See **Opening turn**.
- **Opening turn** — a player's first turn, on which they place one of their opponent's flat stones rather than their own (see **Place**). The seat to move and the seat whose stone is placed therefore differ on an opening turn, and coincide on every turn after it. A game imported from a record resumes past both players' opening turns.
- **Move (stack move)** — lift up to the carry limit of stones from a stack you control, move orthogonally in a straight line, and drop at least one stone on every square crossed. You may not cross standing stones or capstones; you may leave zero stones on the starting square. A capstone may be dropped alone onto a standing stone at the end of a move to flatten it.
- **Pass** — not allowed; every turn is a place or a move.
- **Road** — an orthogonal chain of a player's flat stones and capstones connecting two opposite edges of the board.
- **Road win** — completing a road wins immediately. If one move creates a road for both players, the player who made the move wins (the double road / Dragon clause).
- **Flat win** — if the board becomes completely filled, or a player places their last stone, the game ends; if no road exists, only flat stones on top of stacks (or alone on a square) count, and the player with the higher count wins; an equal count is a draw.
- **Decided position** — a position in which a road or flat win already exists; the rules engine reports an outcome. Distinct from a finished game: resign and mutual draw end the game while the position stays undecided. Only a decided position bars a PTN import — a `[Result]` tag alone never decides one.

## Notation

- **PTN (Portable Tak Notation)** — the standard text format for recording a Tak game: tags, numbered moves (`1. a6 f6` …), and a result. Move syntax: place = `(stone)(square)` (`a1`, `Sd3`, `Cb4`); stack move = `(count)(square)(direction)(drop counts)(stone)` (`5b4>212`). Flat is assumed when the stone identifier is omitted. Direction is from Player 1's perspective (`<` `>` `+` `-`).
- **TPS (Tak Positional System)** — the standard text format for describing a Tak position: board rows from the top, stacks listed bottom-to-top, `xN` for empty runs, `S`/`C` suffixes for a standing/capstone on top of a stack, then the turn (`1` or `2`) and the move counter (never `0`; a full move = both players' turns, as in chess).
- **Result** — the game outcome recorded in PTN: `R-0` / `0-R` (road win), `F-0` / `0-F` (flat win), `1-0` / `0-1` (win by resignation or time), `1/2-1/2` (draw).

## Games

- **Game** — a match of Tak between two players, from proposal to completion. A game is proposed, in play, or finished.
- **Seat** — which side of the board an account plays: Player 1 (filled, moves first) or Player 2 (open). The proposer chooses who starts when proposing: themselves, the joiner, or at random (a coin flip when the joiner claims the game). Seats are fixed once the game starts and never swap. This is load-bearing beyond turn order: PTN move direction is written from Player 1's perspective, so the seat decides how a player's moves are notated — and choosing the other seat is how a player imports a past record and replays it from the opponent's side.
- **Game proposal** — a not-yet-started game offered for others to join, as an open game or an invited game.
  _Avoid_: request (ambiguous with take-back request)
- **Open game** — a proposal any player may join; joining implies the game is shared (both players' share toggles start on).
- **Invited game** — a proposal only a designated player may join; hidden from all other players; share toggles start off.
- **Humans only** — a flag a proposer may set meaning no bot may play the game; a bot invited to a humans-only game declines, and the game waits for a human. Human proposals default to allowing bots in principle.
- **Ranked / unranked game** — a categorisation set when a game is proposed and never changed: ranked games count toward a player's standing, unranked games count for nothing. No rating is computed yet — the categorisation is recorded now so future ratings have clean data. Games against bots are always unranked; human players may propose an unranked game (coaching over the shoulder, casual exploration).
  _Avoid_: rated (there is no rating yet, only the categorisation)
- **Self-play** — a game whose proposer also joins (an open game they claim, or an invitation they make to themselves), so one account plays both seats from a single window, for study.
- **Share** — a per-player toggle on a game controlling whether non-participants can view it; a game is viewable iff both players have shared. Either player may change their share at any time.
  _Avoid_: public, make public (ambiguous in the original brief; this is the one concept)
- **Hide** — a player removes a game from their own views and stops sharing it; if both players hide a game, it is deleted.
  _Avoid_: delete (deletion is permanent; hiding is reversible)
- **Follow** — a per-player preference marking players whose games they care about: with the curated find view on, only proposals from followed players are shown. Following is one-way and silent.
  _Avoid_: friend (the site has no friendship concept; following only curates the find view)
- **Take-back request** — a request to undo the requester's last move, made before the opponent has moved. Only one may be pending; it blocks the opponent until accepted (the move is undone and the requester moves again) or rejected. Only moves played after the game started can be undone, and only while the game is in play.
  _Avoid_: undo (undo is the effect, not the mechanism)
- **Resign** — a player forfeits the game; the opponent wins (PTN result `1-0` / `0-1`).
- **Mutual draw** — both players agree to end the game as a draw (PTN result `1/2-1/2`).
- **Game record** — a game's move history and result, exportable as PTN (the full game, or a replayable prefix from any move) or TPS (the position after any move). Each move records when it was played.
- **Review mode** — viewing a game at an earlier move from the game screen: the board, reserves, and move list show the position after that move, and the move controls give way to a "viewing move N of M" bar. No move can be made while reviewing; snapping back returns to the live position. Players and spectators can review, on in-play and finished games.
  _Avoid_: scrub (scrubbing is the mechanism for entering review; review mode is the state)

## Bots & coaching

- **Bot** — a computer opponent: an account with no human behind it whose moves the server generates. Bots never propose games, join open games on their own, or play themselves; they play when a human invites them, or asks to play the computer.
  _Avoid_: AI (says nothing about how moves are chosen)
- **Strength level** — a bot's difficulty: Casual, Standard, or Strong — the same engine searching to different depths. A bot's play is deterministic: the same position and level always produce the same move (games are seeded).
- **Bot game** — a game against a bot. Always unranked, so a bot result can never affect a player's future rating.
- **Coach** — the computer as a teacher: on a player's turn, the game screen can show what the bot would play and why; the suggestion can be previewed and played. Distinct from a full human game review, which is a future feature.

## Imports

- **PTN import** — proposing a game from a PTN record: the moves are validated by replaying from an empty board, and the game continues from the resulting position with the imported history fixed. A record whose position is decided cannot be imported.
- **TPS export** — any position in a game may be exported as TPS. (Starting games from a TPS position is deferred.)

## Sessions & administration

- **Session** — a server-side record of a signed-in user; invalidated when the password changes or the account is blocked.
- **Force password change** — a state in which the user must choose a new password (entering the old one first) before any other action; applied to admin-created accounts, bootstrap accounts, and accounts whose password an admin reset.
- **Block** — an admin action that prevents an account from signing in or acting.
- **Bootstrap admin** — the separate command that creates the initial admin account when none exists and prints a one-time generated password to its own terminal; the server process never sees it.
  _Avoid_: first-run setup page (deliberately a CLI, not a web page)

## Observability

- **Activity trail** — an append-only record of user actions (sign-ins, password changes, game-lifecycle events, share toggles, take-back requests, exports, …) with timestamps. The system writes it but never uses it for its own logic; admins and downstream processes read it for security and game-integrity analysis.
- **Game stats** — derived figures stored when a game finishes (move count, duration, result, board size), kept as data for future analysis rather than an analytics pipeline.

## Users

- **Player** — a user account that can propose, join, and play games.
- **Admin** — a privileged account that administers users and games. An Admin is never a Player; a person who is both holds two separate accounts.
- **Username** — the login identifier for an account; unique and immutable.
- **Display name** — the public name shown for a user; unique and freely changeable; defaults to the username when the account is created.
- **Account permanence** — an account is never deleted; **Block** is the only way to retire one. Ranked play makes the record of who played whom permanent evidence: a rated game whose opponent had vanished could not be interpreted, so removing an account would destroy the meaning of every game it touched. This is the same reasoning that records the ranked/unranked categorisation before any rating exists — the data has to be clean before it is needed.
  _Avoid_: delete account (blocking is the mechanism; deletion is not offered)
