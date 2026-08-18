# 16 — Route surface: the page adapter

**What to build:** Deepen the route adapters so tickets 11–15 build new screens onto one adapter instead of re-typing the load → branch → render diamond per page. One `pageAction` interface owns module-load → forbidden/403 · persistence/500 · render at mapped status; a `pageError` twin re-renders a refused form on its list; `paramId` replaces the hand-rolled `:id` parsing in six routes.

**Blocked by:** 10 — Games: find & join

**Status:** done

- [x] `web/src/forms.ts` becomes `web/src/actions.ts`, housing the unchanged `createFormAction`, the new `createPageAction`/`createPageError`, `paramId`, `forbiddenPage`, and the two status mappers.
- [x] The three list pages (users, my games, find) load through `pageAction`; the users route stops duplicating `adminUsersPage` inline.
- [x] `adminFormError`/`gameFormError` collapse into one `usersError`/`myGamesError` closure each, built on `pageError`; `gameJoinError` stays route-local on the same building blocks.
- [x] The six `:id` routes parse through `paramId`: `.andThen` composes the sync game commands; the async auth commands keep the original if/else shape (neverthrow's `asyncAndThen` wants a `ResultAsync` callback, and `applyAuth` returns `Promise<Result>`).
- [x] `pageAction`, `pageError`, `paramId`, and `forbiddenPage` are unit-tested in `web/test/actions.test.ts`; HTTP tests unchanged and still green.
- [x] The two status mappers keep their per-module shape (decided in review: they encode module decisions, e.g. `not-invited` → 403).

## Comments

**2026-08-18 — Design note.** From the architecture review (opportunity 1) and the grilling rounds:

- **The adapter owns repeated structure only.** `query` (one use) and `gameJoinError` (one use) stay route-local; the adapter absorbs the diamond, `idFrom`, and the forbidden page — the three families re-typed across routes.
- **`pageAction` is a plain function, not a middleware twin.** GET handlers already return Responses, and a pure function is unit-testable without a Hono `Context`, like `createFormAction`.
- **The error arm is a per-page `renderError` closure.** The find page's error state (empty list, filters kept) is genuinely its own, and the future game view (tickets 11–13) will want its own shape.
- **Status mapping stays in the two per-module mappers.** They encode module decisions (`not-invited` → 403; invisible games → `not-found`); the adapter invokes them via `statusOf`.
- **Rollout: standalone ticket, before ticket 11**, so the game view is the adapter's first real consumer rather than its last retrofit.

**2026-08-18 — Implemented.** `web/src/forms.ts` → `web/src/actions.ts`. Three list pages now load through `pageAction`; the users route's inline duplicate of `adminUsersPage` is gone; `adminFormError`/`gameFormError` became `usersError`/`myGamesError` closures over `pageError`; the six `:id` routes parse through `paramId`. `gameJoinError` still answers on whichever list offered the button — the `from` branch is a `pageError` over the find page, keeping the refused-join status (e.g. 409).

Decisions worth carrying forward:

- **A refused command re-renders a *fresh* list.** `pageError` reloads the page's data (as `adminUsersPage`/`myGamesPage` did) rather than rendering stale rows; a reload failure is forbidden → 403, anything else → 500.
- **`pageAction`'s success render is always 200.** Only the error arm takes a status, via `statusOf`; pages whose load can only fail forbidden/persistence need no `renderError` at all (an unexpected code falls back to log + 500).
- **`paramId` returns a `Result`, never null.** `not-found` is a first-class error shape, so malformed ids compose with module commands — `.andThen` for the sync game commands, and for the async auth commands the original `if (id.isErr()) return Promise.resolve(err(id.error))` shape, whose `never` ok-type unifies with the command's result. Neverthrow's `asyncAndThen` was tried and rejected: it requires the callback to return a `ResultAsync`, and `applyAuth` returns `Promise<Result>`.
- **The forbidden page renders the requester in the masthead** from the actor the adapter was given, so `forbiddenPage` no longer needs its own session lookup.

Deferred: none — the game view (ticket 11) is the adapter's first new consumer.
