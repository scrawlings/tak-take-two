# 17 — The board-finished fact

**What to build:** The core aggregate exposes `isBoardFinished` — whether the *position* is decided by a road or flat win — so PTN import validation in the web Game module states that rule as a named fact instead of reading `state.outcome` directly. The distinction from `isFinished` (the game ended, possibly by resign or mutual draw) gets pinned by tests and a glossary entry.

**Blocked by:** 03 — Core: PTN; 09 — Games: propose + PTN import

**Status:** done

- [x] `core/src/aggregate.ts` exports `isBoardFinished(game)` (the engine's question: has an outcome been produced), reusing the private `boardEnd`; `core/src/index.ts` re-exports it.
- [x] `web/src/games.ts` import validation calls `isBoardFinished`; the five-line comment unpacking the `result` fold is gone.
- [x] Core tests pin the fact: fresh game false, road win true, resign false, and the distinction test — an `R-0` tag on an open position is `result.kind === 'board'` yet `isBoardFinished` false.
- [x] Web test pins the rule: a record whose tag claims a road on an open position still imports.
- [x] CONTEXT.md gains a "decided position" entry; the PTN import entry notes a decided position cannot be imported.

## Comments

**2026-08-18 — Design note.** From the architecture review (opportunity 4) and the grilling rounds:

- **The fold in `TakGame.result` is correct** for `resultCode`, `toPtn`, and the future finished-banner; the gap was a named way to ask "did the *position* finish". A predicate beside `isFinished` makes the two questions structurally distinct — `isFinished` = the game ended (any way); `isBoardFinished` = the position itself is decided.
- **The two signals genuinely disagree, both ways**: an `R-0` tag on an open position reads `result.kind === 'board'` (would wrongly reject), and a `1-0` tag on a won position reads `result.kind === 'resign'` (would wrongly accept). So "simplifying" the import check to `result.kind === 'board'` would be a bug — the core distinction test freezes this.
- **The import rule stays in the web module** — it is a lifecycle rule (starting a new game from a record, with web error codes). Core stays fact-based per ADR-0001: parse, replay, report the position.
- **Rollout: standalone ticket, before ticket 11**, so the play view builds on the named fact.

**2026-08-18 — Implemented.** `core/src/aggregate.ts` gains `isBoardFinished` (one line over the existing `boardEnd`); `web/src/games.ts`'s `validateImport` now names its intent. CONTEXT.md defines **decided position** and the import entry states the tag-is-metadata rule.

Decisions worth carrying forward:

- **The predicate reuses `boardEnd`, the fold's own source**, so "the board decided" has exactly one derivation in the aggregate.
- **The web comment shrank to the half that is still web knowledge** — "a resignation or agreed draw still leaves the position playable" — because the other half is now the function's name.

Deferred: none.
