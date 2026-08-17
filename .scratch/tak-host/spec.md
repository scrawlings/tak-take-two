# Spec — Tak hosting site

Status: ready-for-agent

## Problem Statement

We play Tak on physical boards but want the convenience and honesty of a digital record. There's no lightweight place to host a game: record moves guaranteed legal under the official rules, share a game with a chosen opponent, let others watch live if both players agree, and keep the whole game persistently so it can be picked up again days later. The record must also be portable — as PTN or TPS — and the platform must be administrable by designated admins rather than open registration.

## Solution

A website for hosting games of Tak. Players propose games (open to anyone, or invited to a specific player) on 5×5 or 6×6 boards, either from scratch or from a validated PTN record. Moves are entered on a game screen — via a click builder or PTN text — and validated by a headless rules engine before anything is recorded; the system detects road and flat wins, and supports resign, mutual draw, and take-back requests. Games persist indefinitely. A game becomes viewable by others only when both players share it (open games start shared, invited games don't), and viewers get moves in real time. Any move in the record can be exported as PTN (full game or prefix) or TPS (position), and a player can resume from an earlier point by proposing a new game from that PTN. Accounts are created by admins; sessions are server-side; the first admin is bootstrapped by a separate command. All state lives in a single SQLite database, with an append-only activity trail and derived game stats kept for future security and integrity analysis.

## User Stories

1. As a player, I want to log in with my username and password, so that I can reach my games.
2. As an admin, I want to create user accounts and communicate the username and initial password outside the system, so that players can join without open registration.
3. As a user, I want to be forced to set a new password on first login (old → new), so that the password an admin chose for me is short-lived.
4. As a user, I want to change my password at any time, so that I control my account security.
5. As a user, I want a password change to invalidate all my existing sessions, so that old sessions can't be used.
6. As a user, I want a display name that is unique and freely changeable, so that I control my public identity; my username stays immutable.
7. As an admin, I want to block and unblock accounts, so that I can stop misuse.
8. As a blocked user, I want login and all actions refused until I'm unblocked.
9. As an admin, I want to reset a forgotten password (forcing a change), so that a user who lost their password can get back in.
10. As an admin, I want to force a password change for a user or another admin, so that I can enforce credential rotation.
11. As a user, I want the first admin to be bootstrappable by a separate command when none exists, so that the system can be stood up from scratch without leaking the password into server logs.
12. As an admin, I want an admin section in the web app to manage users, so that administration doesn't require external tools.
13. As a player, I want to propose a new game on a 5×5 or 6×6 board, so that I can start a match.
14. As a player, I want to propose an open game that anyone can join, so that I can find an opponent.
15. As a player, I want to propose an invited game for a specific player, so that I can play a particular opponent; it stays hidden from everyone else unless we both share it.
16. As a player, I want to propose a game from a PTN record, so that I can continue a recorded game; the record is validated as legal and the imported history is fixed.
17. As a player, I want to delete a proposal of mine that no one has joined, so that stale proposals don't accumulate.
18. As a player, I want to see my proposed and active games, so that I can return to them later.
19. As a player, I want to search currently proposed games, filtering by board size, open vs invited, and proposer, so that I can find a game to join.
20. As a player, I want to join any open game, so that I can play.
21. As a player, I want to join a game that was invited for me, so that I can play a designated opponent.
22. As a player, I want to join my own games, so that I can validate moves and keep study records.
23. As a player, I want to record my moves on my turn via a click builder or PTN text, so that the game advances.
24. As a player, I want any illegal move rejected with a clear message, so that the record contains only legal play.
25. As a player, I want the board position and full move history displayed, so that I can follow the game while playing on my physical board.
26. As a player, I want the system to recognise when the game ends by road or flat win, so that the result is recorded correctly.
27. As a player, I want to resign, so that I can concede; my opponent wins.
28. As a player, I want to agree a mutual draw, so that we can end an even game.
29. As a player, I want to request a take-back of my last move before my opponent has moved, so that I can correct a mistake; my opponent accepts or rejects.
30. As a player facing a take-back request, I want my move blocked until I accept or reject, so that the request is resolved first.
31. As a player, I want take-backs to apply only to moves played after the game started, so that imported history stays intact; and never after the game ends.
32. As a player, I want games to persist indefinitely, so that I can step away from the board and come back later.
33. As a player, I want a game viewable by others only if we both share it, so that I control who sees it; open games start shared, invited games don't.
34. As a spectator, I want to watch a shared game live with moves updating in real time, so that I can follow play.
35. As a player, I want to change my share decision at any time, so that my privacy stays in my hands.
36. As a player, I want to hide a game from my views, so that I stop seeing it; if both players hide it, the game is deleted.
37. As an admin, I want to delete any game at any time, so that I can remove problematic games; affected players see a warning that the game no longer exists.
38. As an admin, I want to view any game regardless of share state, so that I can exercise oversight.
39. As a player, I want to copy the game as PTN from any move — the full game or a prefix — so that I can share or continue it elsewhere.
40. As a player, I want to copy the position after any move as TPS, so that I can share a position for study or puzzles.
41. As an operator, I want structured logs with request ids and health endpoints, so that I can operate the server.
42. As an operator, I want /metrics and a status page, so that I can see the health of the system.
43. As a security reviewer, I want an append-only activity trail of user actions with per-move timestamps, so that unusual individual behaviour can be investigated.

## Implementation Decisions

- **Headless core module** (ADR-0001): the Tak engine — board, moves, wins, PTN, TPS, game aggregate — is a standalone module with no I/O and no framework dependencies, written in a typed-functional style: literal-union files/ranks and branded squares (out-of-range indexing is a compile-time error), exhaustive unions for stones/directions/outcomes, `neverthrow` `Result` for every failure path, no exceptions. Future tournament and training programs run it headless.
- **Rules**: official Tak per the rulebook/USTak. 5×5 and 6×6 only. Opponent-stone opening. Carry limit = board edge. Capstone crush only when landing alone. Road win with double-road (mover wins). Flat win counts top-of-stack flats; tie is a draw. No pass, no komi. Validation is linear in path length; future all-moves generation is a list-segmentation problem to be memoized (see ADR-0001).
- **Notation**: PTN parse → replay-validate → generate (full game or prefix from any move). TPS generate from any position; parse + structural/material validation; starting games from TPS is deferred.
- **Game aggregate**: history with per-move timestamps, undo (take-back support), resign, mutual draw, finished state; the web layer persists it and batch programs drive it.
- **Web**: Node + Hono + better-sqlite3. One SQLite database: users, sessions, games, game records, activity trail, game stats (ADR-0002). SQLite-backed sessions with HttpOnly cookies; argon2id password hashing; long-lived sessions; password change invalidates all sessions; force-password-change gates every other action; username unique + immutable, display name unique + mutable (defaults to username); bootstrap admin is a separate CLI printing a generated password to its own terminal; admins create users, block/unblock, force/reset passwords, delete any game, and can view any game.
- **Lifecycle & visibility** (ADR-0003): proposed → in play → finished. One per-player share toggle per game; viewable by non-participants iff both are on; open games start shared, invited games start unshared; hide turns your share off and removes the game from your views; both hidden → deleted. Proposers delete unjoined proposals; admin deletions surface a clear warning. Take-back: one pending request blocking the opponent, post-start moves only, in play only.
- **UI & real-time**: server-rendered pages; datastar over SSE for live updates (game views, lists, spectators); Alpine for local interactivity. Move entry via click builder and PTN text through one validator.
- **Deployment & TLS**: single process under systemd on a VPS; also runs on a dev machine from env defaults; TLS self-terminates when PEM cert/key paths are in env (no reverse proxy assumed).
- **Observability**: structured JSON logs to stdout with request ids; `/healthz` + `/readyz`; `/metrics` in Prometheus text format plus an in-app status page; append-only activity trail (written, never consumed by app logic; read by admins and downstream processes for security and tournament/rating integrity); derived game stats stored at game end. Passive alerting. Backups deferred (ADR-0002).

## Testing Decisions

- **Seams** (two): the core package's public API, and the Hono app's HTTP boundary against a test SQLite database. The client layer is thin and asserted via rendered HTML at the HTTP seam. Tests in vitest.
- **What makes a good test**: only external behaviour — call the public function or hit the endpoint and assert the outcome; never reach into internals. Rules tests exhaustively cover the edge cases (opponent-stone opening, carry limit, walls, capstone crush, double road, flat-count tie, reserve exhaustion). HTTP tests cover permissions (not your turn, not your game, unshared games unviewable, blocked accounts refused, forced-change gate) as much as happy paths.
- **Core** is tested at its public API; its suite doubles as the contract for future consumers (tournaments, training). **Web** is tested at the HTTP seam with a per-run test database.
- Prior art: none — greenfield; the core rules suite becomes the prior art for later work.

## Out of Scope

- Interactive in-browser board (future).
- Computer players and batch training (future; the headless core is designed for it).
- Inter-player ratings (future; game stats + activity trail are the seed data).
- Starting games from a TPS position (deferred; TPS parse/validate is built, import is not).
- Board sizes other than 5×5/6×6; komi.
- Open self-registration — admins create all accounts.
- Backups/warehousing; active alerting; multi-instance deployments.

## Further Notes

- Resuming from an earlier point is user-managed: copy the PTN prefix, then propose a new game from it (here or on another Tak server).
- The activity trail and per-move timestamps exist specifically so downstream analysis can check aggregate behaviour against statistical norms and investigate individual journeys (security; tournament and rating integrity).
- The engine's all-legal-moves generation (future) is a list-segmentation problem — memoize or precompute the composition table; it is not needed for validation (see ADR-0001).
- This is the second TypeScript implementation of this system (earlier work in Clojure and a first TS pass); the core's typed-functional style is a deliberate carry-over.
