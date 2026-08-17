# 08 — Auth: admin management

**What to build:** The admin section of the web app — create users, block/unblock, force and reset passwords, and display-name management.

**Blocked by:** 07 — Auth: accounts & sessions

**Status:** ready-for-agent

- [ ] Admins can create users and see the user list.
- [ ] Blocking prevents login and all actions; unblocking restores access.
- [ ] Forcing a password change and resetting a forgotten password (which forces a change) both work; the reset password is communicated outside the system.
- [ ] Display names are unique and changeable by their owner; usernames are immutable.
- [ ] Admins and users can change their own password at any time, with session invalidation.
