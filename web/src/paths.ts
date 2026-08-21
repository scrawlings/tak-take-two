/**
 * The two families of `:id`-addressed command path this app has — a game's
 * own commands (`/games/:id/move`, `/games/:id/hide`, …) and an admin's
 * commands on a user (`/admin/users/:id/block`, …). Each path is typed on
 * both sides of the same TypeScript program: once where `app.ts` registers
 * the route, once where a view renders the form or link that submits to it.
 * There is no compile boundary here to defend the way `contract.ts` defends
 * the client bundle seam (ADR-0012) — a mismatch already fails a test loudly,
 * on both sides. This is a smaller thing: one spelling per path instead of
 * two to three, so a rename is one edit and a return to this code after a
 * long gap has one place to look, not a search.
 */

/** The concrete path a game command's form/link submits to. */
export function gamePath(id: number, suffix?: string): string {
  return suffix ? `/games/${id}/${suffix}` : `/games/${id}`;
}

/** The Hono route pattern a game command registers under. */
export function gameRoutePattern(suffix?: string): string {
  return suffix ? `/games/:id/${suffix}` : '/games/:id';
}

/** The concrete path an admin's command on a user submits to. */
export function adminUserPath(id: number, suffix: string): string {
  return `/admin/users/${id}/${suffix}`;
}

/** The Hono route pattern an admin's command on a user registers under. */
export function adminUserRoutePattern(suffix: string): string {
  return `/admin/users/:id/${suffix}`;
}
