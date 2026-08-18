# The web Game lifecycle lives in one module behind a command-union interface

All game-lifecycle behavior on the web layer — proposing, joining, share/hide, take-back requests, resign, mutual draw, admin delete, and the game record — sits in a single module with one command method (`applyGame(gameId, actorId, command)`) and a small query surface. Routes are thin adapters: they authenticate (session → user) and render, and never re-implement lifecycle rules or write SQL. The rules engine, PTN/TPS, and the headless game aggregate stay in the core module (ADR-0001, ticket 05). This decision fixes the seam so tickets 09–15 build into the module instead of becoming a shallow pile of route handlers.

Status: accepted

## The seam

- **Core (headless):** rules engine (`createGame`/`applyMove`), PTN/TPS, and the game aggregate — history, win detection, resign/draw endings (ADR-0001, ticket 05). PTN import hands its text to core for validation.
- **Web Game module:** the proposal lifecycle (proposed → in play → finished), authorization (who may act on a game and what a viewer may see — per ADR-0003's share toggle), the take-back protocol (one pending request blocks the opponent), persistence of the game record, and the activity trail.
- **Routes:** authenticate and adapt. They call `applyGame` and the queries, then render.

The module authorizes; routes authenticate.

## Interface shape

Commands form one exhaustive union passed to a single method, mirroring the core's `applyMove(state, move)`:

- `applyGame(actor, command): Result<GameCommandResult, GameError>` — `command` is `propose` | `deleteProposal` | `join` | `playMove` | `requestTakeBack` | `acceptTakeBack` | `rejectTakeBack` | `resign` | `mutualDraw` | `share` | `hide` | `adminDelete`.

  This ADR was first written as `applyGame(gameId, actorId, command)`. Ticket 09 built the module and settled the signature, as "Notes for future work" below anticipated: `propose` has no game to address yet, so the target id rides inside the commands that have one, and `actor` is the full `SessionUser` so authorization needs no extra lookup. This is exactly the shape of `applyAuth(actor, command)` described under "Applies to the auth module too" — one command method, an exhaustive union, the actor passed separately, authorization inside the module.
- Queries are a separate small surface (`getGame`, `searchProposed`, `listMyGames`), shaped by the tickets that name their views (09–11).
- No event system: commands return a domain-shaped result, not an event log; real-time delivery (ticket 14) adapts at the routes.

The module never touches SQL. Persistence accessors (load/save game, append record, write game stats) grow inside the persistence module (ADR-0002); the Game module composes them with core rules and authorization. Trail events are written inside the module's command implementations — routes never call `appendActivityTrail` directly.

## Applies to the auth module too

The accounts-and-sessions module (`web/src/auth.ts`, tickets 07–08) initially grew the exact named-methods shape this ADR warns against — a dozen methods each re-running authorize → load → validate → persist → trail. It was refactored onto the same seam: one `applyAuth(actor, command)` command union (`login` | `logout` | `bootstrapAdmin` | `createUser` | `changePassword` | `changeDisplayName` | `blockUser` | `unblockUser` | `forcePasswordChange` | `resetPassword`) plus a small read surface (`getSessionUser`, `listUsers`). The actor is a separate argument — `null` for the unauthenticated commands (`login`, `bootstrapAdmin`) — and authorization, trail writes, and error wrapping live inside the command implementations. Auth is a second instance of the same seam; the rationale above is what both modules share.

## Considered options

- **Named methods per operation (`propose()`, `join()`, `share()`, …)** — rejected: a dozen thin methods each re-running load → authorize → rule → persist → trail; the interface would be as wide as the implementation, relocating the shallow pile from routes into the module.
- **Lifecycle logic inline in route handlers** — rejected: the invariants (viewable iff both players share, one pending take-back, join-once, delete-only-when-unjoined) would leak across every handler and be re-implemented per route, and the trail would be written at N call sites.
- **Event sourcing / a domain event log** — rejected for now: ADR-0002 keeps state in tables, and the game record is the move log. Commands return results, not events.

## Notes for future work

- The module is born with ticket 09 (propose + PTN import), its first consumer; the command result types take their final shape there, not before. (Done: `web/src/games.ts`, carrying `propose` and `deleteProposal`. The `applyGame` signature settled there — see "Interface shape".)
- Take-back request storage (exactly one pending per game) is a ticket-12 decision; the command surface already includes the protocol.
- This ADR does not reopen ADR-0001: the game aggregate and PTN/TPS remain headless core code, serving the web layer and future batch programs alike.
