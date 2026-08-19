# 05 — Hide a game from the list row

**What to build:** A hide button in "Your games" row actions for any game the viewer participates in, so a game can be removed from their views without opening it. Reuses the existing hide action (POST `/games/:id/hide`) and mirrors the join button's `from` parameter for redirect behaviour. Spec: `.scratch/ui-usability/spec.md`.

**Blocked by:** None.

**Status:** done

- [x] Row actions gain a hide button for games the viewer can hide (the same `canHide` rule the game page uses, decided in the module not the view).
- [x] The hide POST accepts a `from` param (like join) so it redirects back to the games list instead of the game page.
- [x] The row reflects the result like other list actions (the game disappears from the list on reload; the stream region updates).
- [x] Tests at the HTTP seam: hiding from the list works, redirects correctly, and the game leaves the viewer's list; a non-participant cannot hide.

## Comments

**2026-08-19 — Specified in grilling.** The user asked for a "full hide/delete hide in that view rather than having to enter the game to hide it".
