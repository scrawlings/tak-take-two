# Game command routes register as table rows, not per-command stanzas

`web/src/app.ts` (956 lines at the time) declared every game command as its own `app.post` stanza — `paramId` + `applyGame` + a redirect + an error adapter — even though the sixteen commands split into three shapes that differed only in what they build, where success lands, and which adapter reports a refusal. Ten game-screen commands (move, resign, draw and its accept/reject, take-back and its accept/reject, share, admin-delete) were the same route eleven times; four list commands (follow, unfollow, delete, hide) repeated the `return_to`-redirect block; three admin user commands (block, unblock, force-password-change) repeated a fourth shape. Adding the next command (the bots tickets: play-the-computer, coach-suggest) meant copying a stanza, and a reader could not see the family a new command belonged to.

Status: accepted

## The decision

- **Three registrars in `app.ts` own the shapes: `gameScreenCommand`, `listCommand`, `adminUserCommand`.** Each takes the path, the form fields, and a `build(fields, id) → Command` seam, and closes over the family's constants — `gameScreenCommand` redirects to the game and reports via `gameViewError`; `listCommand` parses `return_to` back onto the list it was drawn from (ADR-0008) and takes the adapter per row; `adminUserCommand` redirects to the users list and reports via `usersError`. A command is now one row naming its own divergence.
- **`propose`, `join`, admin user create, and reset-password stay explicit stanzas.** They carry something a row would have to smuggle into the table: propose echoes the submitted form into the error view, join lands on the game rather than a list, create/reset render a result page. The families are for the repeating shapes, not a tax on every route.
- **The seams stay put.** `formAction`/`pageError`/`paramId`/`statusForGameError` in `actions.ts` are untouched; the error adapters (`usersError`, `myGamesError`, `findGamesError`, `gameJoinError`, `gameHideError`, `gameViewError`) are unchanged and still own where a refusal is reported. The registrars are thin adapters in the ADR-0004 sense: `applyGame` still owns every rule, the routes still authenticate and render.

## Considered options

- **One generic table of `{ path, fields, build, onOk, error }` rows driving a single registration loop.** Rejected: the two genuinely-special routes would need per-row `onOk`/`error` closures, relocating their logic into the table instead of removing it; three registrars keep the family constants declared once each and the special cases visibly outside.
- **Fold `adminUserCommand` into `gameScreenCommand`.** Rejected: it calls `auth.applyAuth` rather than `games.applyGame`, uses a different `paramId` message, and targets the admin list — the shared skeleton would be two adapters pretending to be one.
- **Move the registrars to `actions.ts` or a new module.** Rejected: they are route-shape only and reference the route-scoped `app`, `requireUser`, and the adapters; `actions.ts` stays the deep machinery ("deep, keep").

## Consequences

- Adding a game-screen command is one `gameScreenCommand` row; adding a list command is one `listCommand` row. The bots tickets land as rows, not pastes.
- The route surface in `app.ts` shrank from ~950 to ~910 lines, and the sixteen stanzas to seventeen rows (the three registrars plus the four list rows are the count's bulk).
- The deletion test is the existing end-to-end suite: `games-http.test.ts` and `auth-http`/`games-http` route tests exercise every command through the registered paths unchanged.
