# Stored games materialize in the headless core; reads trust the write seam

Restoring a stored Game record into a playable TakGame is a headless core concern — one module beside `fromPtn` — not a fold inside the web Game module. Reads trust the write seam: the per-move TPS snapshot in `game_records.position` is the read path (one `parseTps` for the state, parsed notations for the history), and full replay survives only as the fallback for states no snapshot covers (the post-import position, null snapshots). Corruption is its own fault class — `corrupt-record` at the core seam, wrapped with the game id at the web seam, mapped 500.

Status: accepted

## The decision

- **The materializer lives in core** (`core/src/aggregate.ts`, beside `fromPtn`, which is its sibling). It is pure: the record's rows are passed in, a TakGame comes out, no I/O. ADR-0001 promised the headless core serves the web app *and* future batch programs; loading a persisted game is exactly the kind of reuse that promise names. The web Game module's `currentTakGame` and `gameAfter` — two replay implementations that could drift — collapse into one module with one interface.
- **Reads trust the write seam.** Every snapshot is written from a validated state: `appendMove` only stores after the core accepted the move, and the snapshot is `generateTps` of that accepted state; imports are validated at propose. Replay-on-read was incidental, not designed, and it made every view and list pay O(moves) for a fact the write already proved. The fallback path stays: a record with no snapshot (imported game with zero live moves) or a null snapshot still replays.
- **The stored `games.result` string is the single source of truth** for how a loaded game ended. The loader maps it inside core via the existing `endFromCode` (resign and draw cannot be derived from a position, and CONTEXT.md's decided-position distinction exists because position and record can disagree).
- **Corruption is a distinct fault.** A stored record that no longer parses or replays is not a database failure; it returns `corrupt-record` from core, is wrapped with the game id at the web seam (message style preserved: "game N no longer replays: …"), and maps to 500.

## Considered options

- **Delete the snapshot column** — rejected: the write already happens on every move, so reading it is a read-side change with no migration; ticket 14 (real-time) re-renders the game view and lists on every move, and the snapshot makes each refresh O(1) instead of O(moves). If a future schema change makes the column a liability, the deletion remains available and this ADR would be reopened then.
- **Verify on read (replay every load)** — rejected: replay *is* the read, so the fast path would buy nothing, and the write seam already validates.
- **Materializer inside the web Game module (internal seam)** — rejected: the composition is pure and belongs in core per ADR-0001, batch programs get it too, and corruption stops masquerading as a `persistence` error.
- **Two sources of truth for the result (position when decided, string for resign/draw)** — rejected: they can disagree; the stored string is authoritative.
- **Trusting the snapshot without the equality invariant** — rejected implicitly: the loaded-state ≡ fully-replayed-state test is what makes trust safe to hold; it is part of the ticket.

## Notes for future work

- The loader's exact signature settles in ticket 20 (its first consumer), as ADR-0004's did in ticket 09.
- The web layer still owns authorization, lifecycle, and the activity trail (ADR-0004); this ADR only moves the record→TakGame fold.
