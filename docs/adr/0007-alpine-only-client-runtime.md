# The site has one client runtime: Alpine; SSE is hand-rolled

The site runs one client runtime — Alpine, from the CDN. Datastar (a beta dependency, loaded on every page, never invoked) is dropped. Real-time delivery (ticket 14) is hand-rolled SSE: a server route re-renders the streamed regions with the existing view functions and pushes fragments; a small Alpine component on the game screen listens and swaps them. Scripts load per page: the shell renders the scripts a page needs, not a global include.

Status: accepted

## The decision

- **Alpine is the single client runtime.** It already owns every interactive element — the board click-builder (ticket 21), the stone picker, the propose form, the copy button — and ADR-0006 ratified its adapter. The loaded Datastar dist was `1.0.0-beta.11`, an SSE-protocol core that no code in `web/src` ever invoked, shipped to every page.
- **Real-time delivery is hand-rolled SSE on the game screen.** The SSE route re-renders the three streamed regions — status line, board, move list — with the existing pure view functions (`renderGameStatus`, `renderBoard`, `renderHistory`) and pushes them as fragments; an Alpine component holds an `EventSource` (browser auto-reconnect) and swaps the regions via `x-html`. The collision the fork would have caused is structurally absent: the click-builder's composition state (`source`, the in-progress move) lives on an `x-data` wrapper that the stream never replaces, and Alpine re-initializes the new cells it swaps in.
- **Spectator streaming is gated at the SSE route** by the Game module's visibility rule (ADR-0003's share toggles), exactly as the page itself is gated — the route is a thin adapter, per ADR-0004.
- **Scripts load per page.** The shell takes a scripts option; pages that use no client code (login, account, status, admin) ship none.

## Considered options

- **Two runtimes with a seam (Alpine interaction + Datastar streaming)** — rejected: two runtimes on the game page permanently, a beta dependency, and a protocol constraint — streamed fragments must never wrap or replace an `x-data` scope carrying composition state — that is a footgun for ticket 14's implementer (replace the wrong node and the player loses a half-composed move).
- **Datastar owns the game screen (signals/actions)** — rejected: the click-builder state machine fits Alpine's method/computed model far more naturally than signals; the propose form and copy button would still need Alpine, yielding two runtimes split by page; and it would amend ADR-0006's freshly recorded adapter choice.
- **Keep the global script include** — rejected: five-plus pages ship a client runtime they never use.

## Notes for future work

- Ticket 14's premise is rewritten to Alpine-driven SSE; its detail design (fragment shapes, list streams, consistency under simultaneous moves) belongs to that ticket.
- If a streaming framework is ever wanted, the seam is the game screen's EventSource component — one place to swap it out.
