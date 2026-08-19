# 02 — Keyboard shortcuts on the game screen

**What to build:** A focus-guarded shortcuts layer for the game screen: `Enter` plays the move, `[` `]` step the history scrubber, `u` requests a take-back, `Esc` cancels an in-progress board move or snaps back to live, `?` toggles a one-line help panel. Shortcuts are inert while focus is in an input/textarea/select (typing PTN never triggers them) and activate existing affordances — no new server routes. Spec: `.scratch/ui-usability/spec.md`.

**Blocked by:** 01 — History scrubber (the `[` `]` bindings and `Esc`-to-live drive its state); agree the scrubber's module interface with 01.

**Status:** ready-for-agent

- [ ] A tested shortcuts module in the client bundle (ADR-0006): key → action mapping, focus guard (active only when `document.activeElement` is not an input/textarea/select/contenteditable), no-ops where an action is unavailable (take-back when none may be offered; `[` at the start; `]` at live).
- [ ] `Enter` plays the move — the same submit the form button performs, so a composed or typed move in the field is played.
- [ ] `u` triggers the existing take-back POST via the affordance that is already rendered (only when `canOfferTakeBack`); `Esc` cancels a builder in progress or snaps to live; `[` `]` step the scrubber.
- [ ] `?` toggles a small, dismissible help panel listing the bindings (server-rendered, Alpine-shown like other islands — no new client-only text).
- [ ] Tests: module driven as plain data (mapping, guard, no-ops); HTTP seam asserts the help panel exists and the shortcuts script ships on the game page only.

## Comments

**2026-08-19 — Specified in grilling.** Bindings confirmed as proposed: Enter, `[` `]`, `u`, Esc, `?`, all inert while typing. `Ctrl+Z` was explicitly rejected for take-back (browser undo collision). "Activate the same affordances a click would" was the stated principle.
