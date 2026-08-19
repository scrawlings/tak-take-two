# 06 — Removed games: hidden by default, toggle to show

**What to build:** Admin-removed games persist as tombstones so the "removed by admin" warning and exports stay reachable — but they currently sit in the viewer's list indefinitely. "Your games" gains a **"Show removed games" toggle, default off**, so tombstones are hidden by default and opt-in to view. Games deleted by double-hide are gone from the DB entirely and have nothing to show. Spec: `.scratch/ui-usability/spec.md`.

**Blocked by:** None.

**Status:** done

- [x] `listMyGames` accepts a `showRemoved` option (default false) and omits admin-removed games unless set.
- [x] The games page renders the toggle (query-param-driven like 03's controls); the stream route runs the same query.
- [x] A removed game's tombstone page stays reachable by direct link (warning + exports) regardless of the toggle.
- [x] Tests at the HTTP seam: removed games hidden by default, shown when toggled, tombstone page still reachable, stream honours the param.

## Comments

**2026-08-19 — Specified in grilling.** The user confirmed the reading: the admin tombstones are what clutters the list; filter in/out was the ask. Default off; tombstones preserved underneath (the warning page is load-bearing — tak-host ticket 13).
