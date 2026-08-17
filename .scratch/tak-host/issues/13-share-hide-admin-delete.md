# 13 — Share, hide, admin delete

**What to build:** The share toggle, hide (both hidden → delete), admin deletion with a warning, and admins viewing any game.

**Blocked by:** 10 — Games: find & join; 11 — Play: game view, moves, finish

**Status:** ready-for-agent

- [ ] Each player has a share toggle on each game; a game is viewable by non-participants iff both toggles are on; open games start shared, invited games unshared; toggles can be changed at any time.
- [ ] Hiding a game removes it from your views and turns your share off; if both players hide it, the game is deleted.
- [ ] Admins can delete any game; affected players see a clear "removed by an admin" warning on the game view and in their lists.
- [ ] Admins can view any game regardless of share state.
- [ ] Trail events are written for share changes, hides, and deletions.
