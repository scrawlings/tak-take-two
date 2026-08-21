# 02 — The schema's delete rules contradict account permanence

**What to build:** A decision on what `ON DELETE` should say now that **Account permanence** is settled (CONTEXT.md: an account is never deleted; blocking is the only way to retire one), and a migration if the answer changes anything.

**Status:** done

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

- [x] Decide the intended rule per column, given accounts are permanent. Candidates: leave as-is (documented as unreachable), change the `CASCADE`s to `RESTRICT` so a delete attempt fails loudly, or drop the delete rules entirely.
- [x] Decide whether `activity_trail.user_id` should become `NOT NULL`. Every one of the 27 write sites passes a `userId`, and `trail.ts` already requires it on `TrailEvent`; only the column is still nullable.
- [x] If anything changes, write the migration. Note `db.ts` currently declares the schema in one place with no migration history beyond `runMigrations` — check whether a table rebuild is needed, since SQLite cannot alter a foreign key in place.
- [x] Consider whether GDPR-style erasure would ever be required, and if so whether it is anonymisation (blank the display name, keep the id) rather than deletion. That would confirm `RESTRICT` over `CASCADE`.

## Comments

**2026-08-21 — Opened during the activity-trail work (review candidate 5).** Surfaced while justifying why `TrailEvent.userId` is required. The original reasoning was "the column is nullable because a deleted user nulls it later" — which turned out to be false: nothing deletes users, and the user confirmed deletion is unlikely ever to be allowed because rating players requires knowing who a rated game was played against. **Account permanence** was added to CONTEXT.md as a result; this ticket carries the schema half, which the trail module deliberately did not touch.

**2026-08-21 — Decided and implemented. Recorded as ADR-0017.**

*The rule per column — `RESTRICT` for evidence, `CASCADE` for the rest.* `games.proposer_id`, `games.opponent_id`, `games.invited_player_id`, `game_records.player_id` and `activity_trail.user_id` all became `ON DELETE RESTRICT`, so a `DELETE FROM users` fails loudly at the first row it would damage. `sessions.user_id` and `user_prefs.user_id` keep `CASCADE` — neither is evidence. References to `games` are untouched, because games really are deleted (ADR-0003) and `trail.ts` already covers that null. Not "leave it documented as unreachable": the rules are instructions waiting for someone to run the delete, not comments. Not "drop them entirely" either, though the default `NO ACTION` behaves almost identically — `RESTRICT` names the intent where the next reader of `db.ts` is.

*`activity_trail.user_id` — `NOT NULL`, and `TrailEntry.userId` with it.* The column was nullable only to receive a `SET NULL` from the deletion path that turned out not to exist. `trail.ts`'s `TrailEvent` already required an actor; now the column and the persistence interface agree with it.

*The migration — one migration, three table rebuilds.* SQLite cannot alter a foreign key in place, so `games`, `game_records` and `activity_trail` are create-copy-drop-rename. That forced a change to `runMigrations`: it now disables foreign keys for the duration and runs `PRAGMA foreign_key_check` inside each migration's transaction, restoring the pragma to whatever the caller had. With keys enforced, `DROP TABLE games` would have cascaded into `game_records` and `game_stats` before the new table existed. The check is the better guarantee in exchange — a migration that leaves a dangling reference rolls back, unapplied.

*GDPR — anonymisation, not deletion.* Blank the display name, keep the id and every row referencing it. The schema already permits it (`display_name` is UNIQUE and freely changeable), and it is the only erasure shape compatible with a permanent record of who played whom. That is what settles `RESTRICT` over `CASCADE`: no future requirement wants the cascade. Nothing implemented — no erasure feature was asked for.

*One thing the ticket got wrong.* It says `db.ts` has "no migration history beyond `runMigrations`"; it has an append-only `MIGRATIONS` array with seven entries, so this landed as entry eight rather than needing history invented for it.

*Fixtures worth knowing about.* `web/test/db.test.ts` grew `databaseAtMigration7` alongside the existing `databaseAtMigration1`, both frozen hand-written schemas rather than slices of `MIGRATIONS` — a fixture derived from the array would follow it forward and stop describing the old database a migration has to cope with. `databaseAtMigration1` was also incomplete (it created only `games`, which was harmless while every later migration was an `ALTER TABLE games`); migration 8 touches three tables, so it is now the full migration-1 schema.
