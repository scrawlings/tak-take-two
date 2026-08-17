# 03 — Core: PTN

**What to build:** Parse PTN into typed moves, validate a whole record by replaying from an empty board, and generate PTN text for the full game or a prefix from any move.

**Blocked by:** 01 — Core: board model, place moves, win detection; 02 — Core: stack moves

**Status:** done

- [x] Valid PTN (tags, numbered moves, place and stack-move syntax, results) parses into typed moves; the opponent-stone opening is enforced on the first moves.
- [x] Records containing any illegal move are rejected with an error identifying the offending move.
- [x] PTN generation produces correct text for a full game and for any prefix (the game up to a chosen move) that replays cleanly.
- [x] Comments, informational marks, and result codes are handled without misparsing.
- [x] Every failure returns a typed error — nothing throws.

## Comments

**2026-08-17 — Completed.** Implemented in commit `e52a250` and verified this session: `core/src/ptn.ts` (`parsePtn`, `generatePtn`; `PtnGame`/`PtnError`/`ResultCode`/`PtnOptions` in `core/src/types.ts`), covered by `core/test/ptn.test.ts` (31 tests). Parse follows the USTak notation spec: tags (incl. `[Size]`, required for replay), numbered moves (strict numbering, `N...` rejected), all place/stack-move shorthands (omitted count/drops, `↑↓←→` arrows, `S`/`C`/`F` letters), `{}` comments, trailing informational marks (crush `*`, tak `'`, `!`/`?`), and all result codes (plus `*` for abandoned games, a pragmatic extension beyond the glossary). A record is validated by replay from an empty board; the first illegal move fails with `ptn-illegal-move` carrying the full-move number, player, and underlying `RuleError`. Generation replays first, so it only ever emits legal text, and round-trips through the parser. All 92 tests pass; lint and typecheck clean. See `docs/agents/triage-labels.md` for the `done` status convention.
