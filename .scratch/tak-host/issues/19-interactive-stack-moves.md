# 19 — Interactive stack move creation

**What to build:** Let a player compose a stack move entirely on the board — choose which stack, how many stones to lift, the straight-line path, and how many stones drop on each square — instead of hand-typing PTN. The click builder currently auto-lifts the whole stack and auto-spreads the drops, so partial lifts, arbitrary distributions, and capstone flattens are only expressible by typing.

**Blocked by:** 11 — Play: game view, moves, finish; 18 — Self-play in one window

**Status:** ready-for-agent

- [ ] Selecting a source stack offers a **lift control** — choose how many of the stack's stones to lift (stepper), default `min(stack height, carry limit)`; the composed notation uses the chosen count.
- [ ] Clicking a destination square in a straight line sets the **path** with default drops (1 per crossed square, remainder on the last) and highlights each path square with its drop count.
- [ ] **Drop adjustment** — each path square's drop count can be raised or lowered while keeping every square ≥ 1 and the sum equal to the lift; the composed PTN updates live in the move field.
- [ ] The builder can express a **capstone flatten** (lift 1 from a stack topped by a capstone onto an adjacent square) and any legal drop distribution the engine accepts.
- [ ] Visual feedback: source highlighted, stones-in-hand count, path squares with drop counts.
- [ ] The PTN text field stays the escape hatch and the single validator (`parseMove` → engine `applyMove`); nothing changes on the move POST path.
- [ ] Tests: the engine-validation tests already cover whatever the builder emits; the HTTP seam asserts the builder's rendered state; the interaction itself is client-side and manually verified (the stance ticket 11 took for the click builder).

## Comments

**2026-08-18 — Design note.**

**Current state.** The builder (the `takBoard` Alpine component in `views.ts`) does: click a stack you control → click a square in a straight line → compose `lift + square + direction + drops`, where `lift = min(stack height, carry limit)` and `drops = 1 per crossed square, remainder on the last`. That is one legal move per source/destination pair, but not the move you may want: you cannot lift fewer stones than the stack holds, cannot distribute drops (2-1-2 vs 1-1-3), and cannot drop a lone capstone from a multi-stone stack. Everything else must be typed.

**Interaction model — lift → path → adjust → Play.** Extend, don't replace:

- Click a source stack → it is selected (as today) and a lift stepper appears (`Lift N of H`, default `min(H, carry)`).
- Click a destination square in a straight line → the path squares highlight with their default drop counts (1 per square, remainder last — the current behaviour, now as the *starting point* rather than the end).
- Click a highlighted path square (or its +/− controls) to adjust that square's drop count, clamped so every square stays ≥ 1 and the total stays equal to the lift.
- The composed PTN fills the move field live and stays editable; the player presses **Play move** as today. The source/path remain live for adjustment until the move is submitted or cleared, instead of resetting on the destination click.

**Invariants the builder guarantees** (so its output is always syntactically valid; *legality* stays the engine's job with its clear message):

- the path is an orthogonal straight line from the source;
- `1 ≤ lift ≤ min(stack height, carry limit)`;
- every crossed square receives ≥ 1 stone;
- the drops sum to the lift.

**Capstone flatten falls out naturally**: lift 1 from a stack whose top stone is a capstone, path of one square, drops `[1]` → `1b4>1`. The engine already validates the rest (only a lone capstone may land on a standing stone).

**No module or persistence change.** The move POST path, `parseMove`/`formatMove`, and `applyMove` are untouched; the builder only produces the same PTN string the field accepts. Self-play (ticket 18) needs no extra work: the builder is colour-agnostic once a source is selectable.

**Testing caveat.** The builder is client-side Alpine; vitest at the HTTP seam cannot execute it. Assert the rendered state (lift control present, path/drop data attributes) at the HTTP seam, rely on the engine tests for whatever the builder emits, and verify the interaction by hand — the same stance ticket 11 recorded for the click builder.
