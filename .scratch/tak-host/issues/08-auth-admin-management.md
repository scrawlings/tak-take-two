# 08 — Auth: admin management

**What to build:** The admin section of the web app — create users, block/unblock, force and reset passwords, and display-name management.

**Blocked by:** 07 — Auth: accounts & sessions

**Status:** done

- [x] Admins can create users and see the user list.
- [x] Blocking prevents login and all actions; unblocking restores access.
- [x] Forcing a password change and resetting a forgotten password (which forces a change) both work; the reset password is communicated outside the system.
- [x] Display names are unique and changeable by their owner; usernames are immutable.
- [x] Admins and users can change their own password at any time, with session invalidation.

## Comments

**2026-08-17 — Completed.** Admin management landed on the auth module from ticket 07, plus an admin section and owner-facing display-name routes.

- **Module (`web/src/auth.ts`):** `listUsers`, `blockUser`, `unblockUser`, `forcePasswordChange`, `resetPassword`, `changeDisplayName`. Each admin method authorizes the actor (`requireAdmin`), and blocking refuses self-block (`cannot-block-self`). `resetPassword` returns the generated plaintext once to the admin and clears the user's sessions; `changeDisplayName` enforces uniqueness (self-rename allowed) and length 1–64.
- **Persistence (`web/src/persistence.ts`):** `listUsers`, `findUserByDisplayName`, `updateUserDisplayName`, `setUserBlocked`, `setUserForcePasswordChange`.
- **Routes (`web/src/app.ts`):** `GET /admin` → `/admin/users`; `GET/POST /admin/users` (list + create); `POST /admin/users/:id/{block,unblock,force-password-change,reset-password}`; `GET/POST /account/display-name`. The reset result page shows the password once in a `<code id="reset-password">` element for the admin to hand off out of band — never logged.
- **Block semantics:** block sets the flag *and* deletes the user's sessions, so access stops immediately (CONTEXT.md: sessions invalidated on block); unblock just clears the flag. The ticket-07 `requireUser` middleware already refuses blocked sessions as a backstop.
- **Own-password change** was delivered in ticket 07 (`POST /account/password`, works for any authenticated user including admins); this ticket only adds the admin *reset/force* paths.
- **Trail events:** `user-blocked`, `user-unblocked`, `password-change-forced`, `password-reset`, `display-name-change`, `user-created` — payloads carry the acting admin, never a password.

Tests: `web/test/admin.test.ts` (13) and `web/test/admin-http.test.ts` (7); full suite 172 passing, typecheck + lint clean. Smoke-tested the admin flow end-to-end against the real node:http bridge (bootstrap → forced change → list → create → block/unblock → reset).
