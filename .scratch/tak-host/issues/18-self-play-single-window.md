# 18 — Self-play in one window

**What to build:** A single account playing both seats (self-play, for study) currently breaks in the game screen: `viewerSeat` resolves to Player 1, so the move form and click builder disappear on Player 2's turn and Player 2's stacks can never be lifted. Make self-play work from the one window — both seats' moves, correct colour wording, and no self-resign/draw.

**Blocked by:** 11 — Play: game view, moves, finish

**Status:** done

- [x] `getGame` exposes `selfPlay` (derived `proposerId === opponentId`) beside `viewerSeat`; `canMove` is `in_play && viewerSeat !== null && (selfPlay || viewerSeat === toMoveSeat)`.
- [x] `canEnd` is false for self-play, so resign and draw are not offered against yourself.
- [x] The status line for self-play reads "You play both colours" and names the turn by colour — "Filled to move." / "Open to move."
- [x] The click builder treats every occupied square as a valid source in self-play (`mine = selfPlay ? top !== '' : top[0] === viewerSeat`).
- [x] CONTEXT.md gains a **Self-play** glossary entry.
- [x] Tests: a self-play game accepts both seats' moves (module); the view shows both-colours status and no resign/draw (HTTP).

## Comments

**2026-08-18 — Design note.** From the `/grill-with-docs` rounds:

- **Recognition is derived, not stored.** `isSelfPlay(game)` = `proposerId === opponentId`; join already sets both ids, and a stored flag would only duplicate that fact. It sits beside `isParticipant`/`visibleTo`/`joinableBy` as another named predicate.
- **`viewerSeat` keeps its meaning; `selfPlay` overrides turn gating.** The viewer still resolves to a seat (proposer = 1) so colour/table logic keeps an anchor, but `canMove` and the click builder use `selfPlay` to grant both seats.
- **Colour, not player, is the meaningful "who" in self-play.** The status names the colour whose turn it is; the opening hint reads "filled's opening places an open stone" rather than "your opponent's stone".
- **The move command already works** — `seatOf` maps both seats to the actor, so no command change is needed. This is a `getGame` + view + test change; the click builder config (`takBoard`) gains a `selfPlay` flag.
- **Resign and draw are hidden** in self-play: conceding to yourself, or agreeing a draw with yourself, is meaningless for study.

**2026-08-18 — Implemented.** `isSelfPlay` predicate; `GameView.selfPlay`; `canMove`/`canEnd` gated on it; the resign and mutual-draw commands refuse self-play with `forbidden` (the module states the rule its capability reports, as with `deletableBy`/`joinableBy`); the status reads "Self-play — … You play both colours. Filled/Open to move." with a colour-based opening hint; the click builder treats every occupied square as a source in self-play; the reserves table marks both rows "(you)". Four new tests (3 module, 1 HTTP).
