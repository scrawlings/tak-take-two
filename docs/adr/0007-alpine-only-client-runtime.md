# The site has one client runtime: Alpine; SSE is hand-rolled

The site runs one client runtime — Alpine, from the CDN. Datastar (a beta dependency, loaded on every page, never invoked) is dropped. Real-time delivery (ticket 14) is hand-rolled SSE: a server route re-renders the streamed regions with the existing view functions and pushes fragments; a small Alpine component on the game screen listens and swaps them. Scripts load per page: the shell renders the scripts a page needs, not a global include.

Status: accepted

## The decision

- **Alpine is the single client runtime.** It already owns every interactive element — the board click-builder (ticket 21), the stone picker, the propose form, the copy button — and ADR-0006 ratified its adapter. The loaded Datastar dist was `1.0.0-beta.11`, an SSE-protocol core that no code in `web/src` ever invoked, shipped to every page.
- **Real-time delivery is hand-rolled SSE on the game screen.** The SSE route re-renders the streamed regions with the existing pure view functions and pushes them as fragments; an Alpine component (`takStream`) holds an `EventSource` (browser auto-reconnect) and swaps the regions. The collision the fork would have caused is structurally absent: the click-builder's composition state (`source`, the in-progress move) lives on an `x-data` wrapper that the stream never replaces, and Alpine re-initializes the new cells it swaps in.

  Ticket 14 built it and settled three details this ADR had sketched:

  - **Five regions, not three.** `renderGameControls` and `renderReserves` join the status line, board and move list, because a move changes them too — a fresh board beside a stone count that is a move stale, or beside a form that still says it is not your turn, is the inconsistency the stream exists to remove. `views.ts` exports them as one `gameRegions(game)` so a page and its stream cannot name different parts.
  - **`data-region` and an `innerHTML` swap, not `x-html`.** `x-ref`/`x-html` binds to the nearest `x-data` root, and the board region deliberately sits inside the nested `takBoard` scope, so the stream component could not reach it that way. It finds its regions by `data-region` under its own root instead, and **skips a region whose HTML is unchanged**. That skip spares the regions carrying no Alpine directives (status line, move list, reserves, both list tables), which stay byte-identical to what the server sent; it does *not* spare the board and the controls, because Alpine rewrites the nodes it binds on init, so their live `innerHTML` no longer matches the server string. Protecting a half-composed move is therefore what this ADR always said it was — scope placement, the `takBoard` scope wrapping regions it never replaces — and the swapped-in nodes re-bind against that surviving scope.
  - **Nothing mutable may live in the `x-data` config.** The corollary of "the stream never replaces the wrapper" is that the wrapper may hold only what cannot change. `takBoard` was first given `canMove`, `viewerSeat` and `selfPlay` as config, and all three change while the page is open — a move passes the turn, a joiner settles a random start — so a streamed update left a live move form above a board that refused every click. They moved onto the streamed `.board` element as `data-can-move`/`data-viewer-seat`/`data-self-play`, read on each click; the config keeps only the board's size.
  - **Whole regions, re-read per frame, not diffs or pushed commands.** The route re-reads through `games.getGame` after every change, so each frame is authorised afresh (a share switched off ends the stream mid-watch) and is a whole consistent position. Streams follow a revision per topic (`web/src/updates.ts`), so a stream that slept through two moves reads the position after both rather than replaying a backlog.
- **Spectator streaming is gated at the SSE route** by the Game module's visibility rule (ADR-0003's share toggles), exactly as the page itself is gated — the route is a thin adapter, per ADR-0004.
- **Scripts load per page.** The shell takes a `scripts` option — `'none' | 'alpine' | 'client'`. `client` inlines the bundle and loads Alpine; `alpine` is for the export page, which carries its own inline `takCopy` component (ADR-0006 deliberately left it there); pages that use no client code (login, account, status, admin, the landing page) ship none. Ticket 14 also merged the bundle's entry into `web/src/client/index.ts`, which registers the components the bundle carries, so the game screen and the two game lists share one script.

## Considered options

- **Two runtimes with a seam (Alpine interaction + Datastar streaming)** — rejected: two runtimes on the game page permanently, a beta dependency, and a protocol constraint — streamed fragments must never wrap or replace an `x-data` scope carrying composition state — that is a footgun for ticket 14's implementer (replace the wrong node and the player loses a half-composed move).
- **Datastar owns the game screen (signals/actions)** — rejected: the click-builder state machine fits Alpine's method/computed model far more naturally than signals; the propose form and copy button would still need Alpine, yielding two runtimes split by page; and it would amend ADR-0006's freshly recorded adapter choice.
- **Keep the global script include** — rejected: five-plus pages ship a client runtime they never use.

## Notes for future work

- Ticket 14's premise is rewritten to Alpine-driven SSE; its detail design (fragment shapes, list streams, consistency under simultaneous moves) belongs to that ticket. (Done — see the amendments under "The decision".)
- If a streaming framework is ever wanted, the seam is `streamComponent` in `web/src/client/stream.ts` on the client and `streamPage` in `web/src/app.ts` on the server — one place each to swap out.
- The lists share one change topic, so any change anywhere wakes every open list stream. That is one re-render per open list per site-wide change; if it ever matters, the topic splits without touching the routes.
- The change broker is in-memory, which ADR-0002's single process makes sufficient. A second instance would need it moved behind the database (or a bus) — the seam is `Updates` in `web/src/updates.ts`.
