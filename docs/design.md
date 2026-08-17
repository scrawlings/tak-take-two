# Design — Tak hosting site

A website for hosting games of the board game **Tak**. Players reproduce the game on physical boards; the site records, validates, and shares their moves. This is the consolidated design from the design session. The domain vocabulary lives in [`CONTEXT.md`](../CONTEXT.md); load-bearing decisions are recorded as [ADRs](./adr/).

## Goals & non-goals

**Goals.** Record and share Tak games with full rules validation; propose games (open or invited) and join them; import/export PTN and TPS; real-time viewing for spectators; persistent games; accounts and admins.

**Non-goals for this version.** Interactive in-browser board (future); computer players (future); ratings (future); games started from a TPS position (deferred); a backup/warehousing scheme (deferred — see ADR-0002).

## Architecture

Three layers:

1. **Core** (`core/`) — the headless Tak engine: rules validation, PTN/TPS parsing and generation, game-state transitions. Pure TypeScript, no I/O, no framework dependencies, `neverthrow` `Result` everywhere, no exceptions (ADR-0001).
2. **Server** (`web/`) — Hono on Node; better-sqlite3 persistence; auth; SSE; renders pages and serves datastar signals.
3. **Client** — server-rendered HTML, **datastar** for live updates over SSE, **Alpine.js** for local interactivity.

## Tech stack

- TypeScript; **Node** runtime (not Bun); **Hono**; **better-sqlite3**; **datastar**; **Alpine.js**; **neverthrow**; vitest for tests.
- Deployment: a single Node process under **systemd** on a VPS; must also run on a dev machine — everything (DB path, TLS PEM paths, port) configured via env vars with sane defaults.
- **TLS**: self-termination when PEM cert/key paths are in env; plain HTTP otherwise. No reverse proxy is assumed.

## Repository layout (proposed)

```
tak-take-two/
├── core/                  # headless engine (own package; consumable by other programs)
│   ├── src/
│   └── test/
├── web/                   # Hono app
│   ├── src/
│   └── test/
├── scripts/               # bootstrap admin CLI, DB migrations
├── CONTEXT.md
├── docs/
│   ├── adr/
│   ├── agents/
│   └── design.md
└── README.md
```

## Core engine

**Rules.** Official Tak, per the rulebook and USTak: 5×5 and 6×6 boards; the opponent-stone opening (each player's first turn places one of the opponent's flat stones); place or move per turn, no pass; carry limit = board edge; walls block stacking; a capstone flattens a standing stone only by landing on it alone; road win with the double-road rule (mover wins); flat win counts only top-of-stack flats; equal counts are a draw. No komi.

**Types.** Compile-time-constrained domain types: files/ranks as literal unions, squares as branded `[File, Rank]`, board size in the type; exhaustive unions for stone type, direction, and outcome; invalid states unrepresentable rather than guarded at runtime.

**PTN.** Parse → validate by full replay from an empty board → typed move list; generate the full game or a replayable prefix from any move.

**TPS.** Generate from any position; parse/validate structurally and by material consistency. The parser is kept (it seeds future puzzle/training work) but *starting games from TPS is deferred*.

**Failure.** `Result` for every failure path; no exceptions.

**Performance.** Validation is linear in path length. Future move *generation* (bots/training) is a list-segmentation problem — memoize or precompute the composition table (see ADR-0001).

## Game lifecycle

States: **Proposed → In play → Finished.**

- **Propose** — open (anyone may join) or invited (one designated player); from scratch or from a validated **PTN import** (history is fixed thereafter).
- **Join** — open games: any player; invited games: the designated player only. Players may join their own games (study/validation).
- **Move** — via click-builder or PTN text entry; both validated by the core before anything is recorded.
- **Take-back request** — undo the requester's last move, before the opponent has moved. One pending at a time; it blocks the opponent until accepted (move undone) or rejected. Post-start moves only; in-play only.
- **End** — road win or flat win (auto-detected by the core), **resign**, or **mutual draw**. Abandoned games persist indefinitely.
- **Share / view** — per-player share toggle; a game is viewable by non-participants iff both toggles are on. Open games start shared; invited games start unshared (ADR-0003).
- **Hide** — a player removes a game from their own views and stops sharing it; if both hide it, it is deleted.
- **Delete** — the proposer may delete an unjoined proposal; admins may delete any game (players see a "removed by an admin" banner).
- **Export** — PTN (full game or prefix from any move) or TPS (position after any move), copied by the player; resuming from an earlier point is user-managed (copy → propose a new game from that PTN, even on another server).

## Users & auth

- **Accounts** — username (unique, immutable login id), display name (unique, freely changeable, defaults to username), password (argon2id, minimum 8 characters).
- **Sessions** — SQLite-backed, HttpOnly cookie, long-lived; end only via logout, password change, or block. Password change invalidates all sessions.
- **Force password change** — gates every action except the change itself (old password → new); applied to admin-created and bootstrap accounts and after admin password resets.
- **Admins** — a separate account class (never a Player in the same account): create users, block/unblock, force password changes, reset forgotten passwords, delete games, and view any game regardless of share state.
- **Bootstrap** — a separate CLI (`scripts/admin-create.ts`) that runs only when no admin exists, generates a strong password, and prints it to its own terminal; the server process never logs it.

## UI & real-time

- **Views** — sign-in; my games (proposed / in play / finished); search for proposed games (filters: board size, open vs invited, proposer display name); game view (board grid, full move history, export from any move, live updates); admin section. All views require login.
- **Real-time** — datastar over SSE; spectators and participants receive move updates live.
- **Move entry** — click-to-enter builder (primary) and PTN text with inline validation (power users); one validator underneath.

## Observability

- **Logs** — structured JSON to stdout (journald/Docker); a request id per request; full error + stack logged with the id; generic friendly errors to users.
- **Metrics** — `/metrics` in Prometheus text format (HTTP counts/latency, active sessions, games by state, error counts, DB size) plus an in-app status page.
- **Health** — `/healthz` (liveness) and `/readyz` (readiness, DB ping).
- **Activity trail** — append-only per-user event log (sign-ins, password changes, game-lifecycle events, share toggles, take-back requests, exports) with timestamps; per-move timestamps in the game record. Written, never consumed by app logic; read by admins and downstream processes for security and game-integrity analysis.
- **Game stats** — derived figures stored at game end (move count, duration, result, board size); the seed corpus for future ratings/training.
- **Alerting** — passive for now. **Backups** — deferred to a future organisational warehousing/recovery scheme (ADR-0002).

## Future work

- **Interactive board** in the browser.
- **Computer players** — run the headless core in batch mode to train and test; memoized legal-move generation.
- **Ratings** — inter-player ratings computed from game stats and the activity trail.
