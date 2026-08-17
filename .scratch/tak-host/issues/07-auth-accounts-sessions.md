# 07 — Auth: accounts & sessions

**What to build:** The bootstrap admin CLI, admin-created users, login/logout, SQLite sessions with an HttpOnly cookie, argon2id hashing, password changes invalidating sessions, the force-password-change gate, and activity-trail events for auth actions.

**Blocked by:** 06 — Web: scaffold + observability base

**Status:** done

- [x] A bootstrap command creates the first admin when none exists, prints a generated password to its own terminal, and forces a password change on first login; it refuses when an admin already exists.
- [x] An admin can create a user with an initial password that forces a change on first login.
- [x] Login and logout work via a session cookie; sessions survive server restarts; a blocked user cannot log in.
- [x] Changing your own password (including a forced change: old → new) invalidates all of that user's sessions.
- [x] While a forced password change is pending, every action except the change itself is refused.
- [x] Trail events are written for logins, logouts, and password changes.

## Comments

**2026-08-17 — Completed.** Auth seam landed across `web/src/auth.ts` (the module), `web/src/passwords.ts` (argon2id + password generation), `web/src/persistence.ts` (user/session accessors), `web/src/views.ts` (server-rendered auth pages), and `web/src/admin-create.ts` (bootstrap CLI, wired to `npm run admin:create -w web`).

- **Bootstrap:** `auth.bootstrapAdmin()` creates `admin` when no admin exists, generates a 32-char base64url password, forces a change, and trails `admin-bootstrapped`; it refuses (`admin-exists`) otherwise. The CLI prints the password to plain stdout — never the JSON logger.
- **Admin-created users:** `auth.createUser(actor, …)` authorizes the actor as admin, defaults display name to username, forces a change, and trails `user-created`. The admin-section route/list is ticket 08; the capability is ready and tested here.
- **Sessions:** SQLite-backed (`sessions` table), `randomUUID` ids, cookie `tak_session` (HttpOnly, SameSite=Lax, Path=/, Secure when TLS terminates via `secureCookies`). Sessions survive a db close/reopen (tested).
- **Login/logout/change:** `login` verifies argon2id, refuses blocked accounts, creates a session, trails `sign-in`; `logout` trails `sign-out`; `changePassword` (old → new) verifies the old password, clears the force flag, invalidates every session, trails `password-change`.
- **Gate:** `requireUser` middleware resolves the session and redirects forced users to `/account/password` for every action except the change itself and logout; blocked sessions are refused too.
- **Trail events:** `sign-in`, `sign-out`, `password-change`, `user-created`, `admin-bootstrapped` — payloads never carry passwords.

Tests: `web/test/auth.test.ts` (18) and `web/test/auth-http.test.ts` (8); full suite 152 passing, typecheck + lint clean. End-to-end smoke-tested against the real node:http bridge (login → gate → change → relogin).
