# 02 — The schema's delete rules contradict account permanence

**What to build:** A decision on what `ON DELETE` should say now that **Account permanence** is settled (CONTEXT.md: an account is never deleted; blocking is the only way to retire one), and a migration if the answer changes anything.

**Status:** needs-triage

## The problem

There is no delete-user path anywhere in `web/src` — no `deleteUser`, no `DELETE FROM users`. CONTEXT.md offers **Block** and nothing else. But `web/src/db.ts` still describes what happens when a user is deleted, and what it describes would destroy exactly the evidence ranked play depends on:

| Column | Rule | Effect if a user were deleted |
| --- | --- | --- |
| `games.proposer_id` | `ON DELETE CASCADE` | **their games are deleted** |
| `game_records.player_id` | `ON DELETE CASCADE` | **their recorded moves are deleted** |
| `game_stats` (via `games`) | `ON DELETE CASCADE` | the derived stats go with the game |
| `games.opponent_id` | `ON DELETE SET NULL` | the game survives, the opponent becomes unknown |
| `games.invited_player_id` | `ON DELETE SET NULL` | the invitation's target becomes unknown |
| `activity_trail.user_id` | `ON DELETE SET NULL` | the trail entry loses its actor |
| `sessions.user_id` | `ON DELETE CASCADE` | correct — sessions are ephemeral |

The `CASCADE` rows are the sharp end: a rated game whose opponent had vanished could not be interpreted, and a cascade does not merely anonymise it, it removes it.

`activity_trail.game_id ON DELETE SET NULL` is a separate and *legitimate* case — games really are deleted (a proposal withdrawn, or both players hiding one, ADR-0003). `web/src/trail.ts` handles it by requiring `payload.gameId` on the two hard-delete events, so the id survives the null. Nothing to change there.

## Checklist

- [ ] Decide the intended rule per column, given accounts are permanent. Candidates: leave as-is (documented as unreachable), change the `CASCADE`s to `RESTRICT` so a delete attempt fails loudly, or drop the delete rules entirely.
- [ ] Decide whether `activity_trail.user_id` should become `NOT NULL`. Every one of the 27 write sites passes a `userId`, and `trail.ts` already requires it on `TrailEvent`; only the column is still nullable.
- [ ] If anything changes, write the migration. Note `db.ts` currently declares the schema in one place with no migration history beyond `runMigrations` — check whether a table rebuild is needed, since SQLite cannot alter a foreign key in place.
- [ ] Consider whether GDPR-style erasure would ever be required, and if so whether it is anonymisation (blank the display name, keep the id) rather than deletion. That would confirm `RESTRICT` over `CASCADE`.

## Comments

**2026-08-21 — Opened during the activity-trail work (review candidate 5).** Surfaced while justifying why `TrailEvent.userId` is required. The original reasoning was "the column is nullable because a deleted user nulls it later" — which turned out to be false: nothing deletes users, and the user confirmed deletion is unlikely ever to be allowed because rating players requires knowing who a rated game was played against. **Account permanence** was added to CONTEXT.md as a result; this ticket carries the schema half, which the trail module deliberately did not touch.
