# 07 — Auth: accounts & sessions

**What to build:** The bootstrap admin CLI, admin-created users, login/logout, SQLite sessions with an HttpOnly cookie, argon2id hashing, password changes invalidating sessions, the force-password-change gate, and activity-trail events for auth actions.

**Blocked by:** 06 — Web: scaffold + observability base

**Status:** ready-for-agent

- [ ] A bootstrap command creates the first admin when none exists, prints a generated password to its own terminal, and forces a password change on first login; it refuses when an admin already exists.
- [ ] An admin can create a user with an initial password that forces a change on first login.
- [ ] Login and logout work via a session cookie; sessions survive server restarts; a blocked user cannot log in.
- [ ] Changing your own password (including a forced change: old → new) invalidates all of that user's sessions.
- [ ] While a forced password change is pending, every action except the change itself is refused.
- [ ] Trail events are written for logins, logouts, and password changes.
