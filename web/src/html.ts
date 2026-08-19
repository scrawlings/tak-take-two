import { CLIENT_SCRIPT } from './client-script.generated.js';

const ALPINE_URL = 'https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The masthead's view of the signed-in user. Structural, so views may pass a `SessionUser`. */
export interface NavUser {
  readonly displayName: string;
  readonly username: string;
  readonly role: 'admin' | 'player';
  readonly forcePasswordChange?: boolean;
}

/**
 * What a page needs from the browser (ADR-0007). Alpine is the one runtime;
 * `client` adds the inlined bundle — the board move builder (ADR-0006) and the
 * SSE stream component (ticket 14) — for the pages that register those
 * components. Pages that say nothing ship nothing.
 */
export type PageScripts = 'none' | 'alpine' | 'client';

/** What the shell needs to draw navigation: who is here, and where they are. */
export interface PageContext {
  readonly user?: NavUser;
  /** Request path, used to mark the current destination. */
  readonly path?: string;
  /** The client runtime this page needs. Defaults to none. */
  readonly scripts?: PageScripts;
}

interface NavItem {
  readonly href: string;
  readonly label: string;
}

function navItems(user: NavUser | undefined): NavItem[] {
  if (!user) {
    return [
      { href: '/login', label: 'Sign in' },
      { href: '/status', label: 'Status' },
    ];
  }
  // Admins administer and never play (CONTEXT.md), so Games is a player's
  // link. An admin's Games links to the whole-site list (ticket 13).
  const items: NavItem[] =
    user.role === 'admin'
      ? [
          { href: '/admin/users', label: 'Users' },
          { href: '/admin/games', label: 'Games' },
        ]
      : [
          { href: '/games', label: 'Games' },
          { href: '/games/find', label: 'Find' },
        ];
  items.push({ href: '/account', label: 'Account' }, { href: '/status', label: 'Status' });
  return items;
}

/** A destination covers a path when it is the path itself or an ancestor of it. */
function covers(href: string, path: string): boolean {
  return path === href || path.startsWith(`${href}/`);
}

/**
 * The item to mark as current: the one covering the path most closely. Plain
 * prefix matching would light up both `/games` and `/games/find` on the find
 * page; the longest match is the honest answer.
 */
function currentHref(items: readonly NavItem[], path: string | undefined): string | null {
  if (!path) return null;
  let best: string | null = null;
  for (const item of items) {
    if (covers(item.href, path) && (best === null || item.href.length > best.length)) {
      best = item.href;
    }
  }
  return best;
}

function masthead(ctx: PageContext): string {
  const { user, path } = ctx;
  // A forced password change gates every other action, so offering links that
  // only bounce back here would be a dead end. Show the way out instead.
  const gated = user?.forcePasswordChange === true;

  const items = navItems(user);
  const here = currentHref(items, path);
  const links = gated
    ? ''
    : items
        .map((item) => {
          const current = item.href === here;
          return `<a class="navlink${current ? ' is-current' : ''}" href="${item.href}"${
            current ? ' aria-current="page"' : ''
          }>${item.label}</a>`;
        })
        .join('');

  const session = user
    ? `<span class="whoami" title="${escapeHtml(user.username)}">${escapeHtml(user.displayName)}</span>
      <form method="post" action="/logout"><button type="submit" class="navlink navlink--button">Sign out</button></form>`
    : '';

  return `<header class="masthead">
  <div class="masthead-inner">
    <a class="wordmark" href="/">Tak</a>
    <nav class="nav" aria-label="Main">${links}${session}</nav>
  </div>
</header>`;
}

/**
 * The scripts a page carries, in load order. The bundle registers its
 * components on Alpine's `alpine:init`, so it must run first — it is inline
 * and synchronous, Alpine's CDN tag is deferred, which orders them.
 */
function scriptTags(scripts: PageScripts): string {
  switch (scripts) {
    case 'none':
      return '';
    case 'alpine':
      return `\n<script defer src="${ALPINE_URL}"></script>`;
    case 'client':
      // ADR-0002 serves no static files, so the bundle travels in the HTML
      // (ADR-0006), the same way `/site.css` is an inlined string.
      return `\n<script>${CLIENT_SCRIPT}</script>\n<script defer src="${ALPINE_URL}"></script>`;
  }
}

/**
 * Base page shell: a shared masthead around the page body, plus the stylesheet
 * and whatever client runtime the page asked for. Scripts load per page
 * (ADR-0007): a page that needs no client code ships none.
 */
export function renderShell(title: string, bodyHtml: string, ctx: PageContext = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/site.css">
</head>
<body>
${masthead(ctx)}
<main class="page">
${bodyHtml}
</main>${scriptTags(ctx.scripts ?? 'none')}
</body>
</html>`;
}

/** A trail back up to the parent page. Rendered above the heading. */
export function breadcrumb(parent: { href: string; label: string }, here: string): string {
  return `<nav class="crumbs" aria-label="Breadcrumb">
  <a href="${parent.href}">${escapeHtml(parent.label)}</a>
  <span aria-hidden="true">/</span>
  <span class="crumbs-here">${escapeHtml(here)}</span>
</nav>`;
}

/**
 * The design system, served at /site.css.
 *
 * Typography inverts the usual roles: monospace carries headings, notation,
 * names and data — everything that is a *record* — while system sans carries
 * prose and form chrome. Colour is a cool slate ground with a single warm
 * accent, `--stone`, the colour of a light Tak stone; it is the only warm
 * thing in the interface and marks only the current destination and the
 * notation itself.
 */
export function siteCss(): string {
  return `:root {
  --paper: #EDF0EC;
  --panel: #F8FAF7;
  --slate: #16232B;
  --slate-mid: #4E6068;
  --rule: #C8D0CC;
  --stone: #C7AE7B;
  --oxide: #96382A;
  --oxide-pale: #F5E4E0;

  --record: ui-monospace, 'SF Mono', SFMono-Regular, 'Cascadia Mono', 'JetBrains Mono',
    'Roboto Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace;
  --prose: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
}

*, *::before, *::after { box-sizing: border-box; }

[x-cloak] { display: none; }

html { color-scheme: light; }

body {
  margin: 0;
  background: var(--paper);
  color: var(--slate);
  font-family: var(--prose);
  font-size: 15px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

a { color: var(--slate); text-decoration-color: var(--rule); text-underline-offset: 3px; }
a:hover { text-decoration-color: var(--stone); }

:focus-visible { outline: 2px solid var(--slate); outline-offset: 2px; }

/* ---------- masthead ---------- */

.masthead { border-bottom: 1px solid var(--rule); background: var(--paper); }

.masthead-inner {
  max-width: 64rem;
  margin: 0 auto;
  padding: 0 1.5rem;
  display: flex;
  align-items: center;
  gap: 1.5rem;
  flex-wrap: wrap;
  min-height: 3.5rem;
}

.wordmark {
  font-family: var(--record);
  font-size: 1.0625rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-decoration: none;
  margin-right: auto;
}

.nav {
  display: flex;
  align-items: center;
  gap: 1.25rem;
  flex-wrap: wrap;
}

.nav form { margin: 0; }

.navlink {
  position: relative;
  font-family: var(--record);
  font-size: 0.8125rem;
  color: var(--slate-mid);
  text-decoration: none;
  padding: 0.25rem 0;
}

.navlink:hover { color: var(--slate); }

/* The current destination carries a stone, placed on the square you are on. */
.navlink.is-current { color: var(--slate); }
.navlink.is-current::before {
  content: '';
  position: absolute;
  left: -0.7rem;
  top: 50%;
  width: 6px;
  height: 6px;
  margin-top: -3px;
  background: var(--stone);
}

.navlink--button {
  background: none;
  border: 0;
  padding: 0.25rem 0;
  cursor: pointer;
  font-family: var(--record);
  font-size: 0.8125rem;
  line-height: inherit;
  color: var(--slate-mid);
}

.whoami {
  font-family: var(--record);
  font-size: 0.8125rem;
  color: var(--slate);
  padding-left: 1.25rem;
  border-left: 1px solid var(--rule);
}

/* ---------- page ---------- */

.page {
  max-width: 64rem;
  margin: 0 auto;
  padding: 2.5rem 1.5rem 5rem;
}

.narrow { max-width: 27rem; }

h1 {
  font-family: var(--record);
  font-size: clamp(1.5rem, 1.25rem + 1vw, 2rem);
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.2;
  margin: 0 0 0.75rem;
  max-width: 20ch;
  text-wrap: balance;
}

h2 {
  font-family: var(--record);
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--slate-mid);
  margin: 0 0 1rem;
}

p { margin: 0 0 1rem; }

.lede { color: var(--slate-mid); max-width: 34rem; }

.mono { font-family: var(--record); }

.block { margin-top: 3rem; }

.crumbs {
  font-family: var(--record);
  font-size: 0.8125rem;
  color: var(--slate-mid);
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.crumbs a { color: var(--slate-mid); }

/* ---------- the board ---------- */

.board {
  display: grid;
  gap: 2px;
  width: fit-content;
  margin: 0 0 1.5rem;
}

.cell {
  position: relative;
  width: 2.75rem;
  height: 2.75rem;
  border: 1px solid var(--rule);
  background: var(--panel);
  color: var(--slate);
  font-family: var(--record);
  font-size: 1.25rem;
  line-height: 1;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  overflow: visible;
}

.cell:hover { border-color: var(--stone); }

.cell.is-source { outline: 2px solid var(--stone); outline-offset: -2px; }

/* A square the composed move crosses, and the stones it would receive. */
.cell.is-path { border-color: var(--stone); box-shadow: inset 0 0 0 1px var(--stone); }

.cell-drops {
  position: absolute;
  bottom: 1px;
  right: 3px;
  font-family: var(--record);
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--stone);
}

.cell-height {
  position: absolute;
  top: 1px;
  right: 3px;
  font-size: 0.6rem;
  color: var(--slate-mid);
}

/* The hover stack: a vertical column of glyphs, top stone first. */
.stack-tip {
  position: absolute;
  bottom: calc(100% + 3px);
  left: 50%;
  transform: translateX(-50%);
  display: none;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 4px 6px;
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 3px;
  box-shadow: 0 1px 5px rgba(22, 35, 43, 0.25);
  font-family: var(--record);
  font-size: 0.8125rem;
  line-height: 1.15;
  z-index: 10;
}

.cell:hover .stack-tip {
  display: flex;
}

.axis {
  font-family: var(--record);
  font-size: 0.6875rem;
  color: var(--slate-mid);
  display: flex;
  align-items: center;
  justify-content: center;
}

.moves { padding-left: 1.5rem; margin: 0; }
.moves li { padding: 0.125rem 0; }

/* Export handles sit beside every move, so they must stay quiet enough to read
   past — a bordered pair of ticks, not a pair of buttons. */
.export-link {
  font-family: var(--record);
  font-size: 0.625rem;
  letter-spacing: 0.06em;
  color: var(--slate-mid);
  text-decoration: none;
  border: 1px solid var(--rule);
  padding: 0 0.25rem;
}

.export-link + .export-link { border-left: 0; }

.export-link:hover { color: var(--slate); border-color: var(--stone); }

/* The exported record, set as the artifact it is and selectable in one click. */
.export-text {
  font-family: var(--record);
  font-size: 0.875rem;
  line-height: 1.6;
  background: var(--panel);
  border: 1px solid var(--rule);
  border-left: 2px solid var(--stone);
  border-radius: 3px;
  padding: 1rem 1.25rem;
  margin: 0 0 1.25rem;
  overflow-x: auto;
  user-select: all;
}

/* ---------- the record: notation set as the artifact it is ---------- */

.record {
  border-left: 2px solid var(--stone);
  padding-left: 1.25rem;
  margin: 2rem 0;
}

.record-line {
  font-family: var(--record);
  font-size: clamp(1.75rem, 1.25rem + 2.4vw, 2.75rem);
  font-weight: 500;
  letter-spacing: 0.02em;
  margin: 0 0 0.5rem;
}

.record-gloss { color: var(--slate-mid); max-width: 32rem; margin: 0; }

/* A live page that has stopped being live. It sits above the thing it is about
   and must be noticeable without shouting: an oxide rule, not an error box. */
.stream-lapsed {
  border-left: 2px solid var(--oxide);
  padding-left: 0.75rem;
  color: var(--oxide);
  margin: 0 0 1rem;
}

/* ---------- notices ---------- */

.notice, .error {
  font-size: 0.875rem;
  padding: 0.625rem 0.875rem;
  border: 1px solid var(--rule);
  background: var(--panel);
  margin: 0 0 1.25rem;
  max-width: 34rem;
}

.error { border-color: var(--oxide); background: var(--oxide-pale); color: var(--oxide); }

/* ---------- forms ---------- */

.panel {
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 3px;
  padding: 1.5rem;
}

.field { margin-bottom: 1.125rem; }

.field label, .field .label {
  display: block;
  font-family: var(--record);
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--slate-mid);
  margin-bottom: 0.375rem;
}

.field input, .field select, .field textarea {
  width: 100%;
  font-family: var(--record);
  font-size: 0.9375rem;
  color: var(--slate);
  background: #fff;
  border: 1px solid var(--rule);
  border-radius: 2px;
  padding: 0.5rem 0.625rem;
}

/* A pasted record is read as notation: leave it monospaced and unwrapped. */
.field textarea {
  display: block;
  line-height: 1.5;
  resize: vertical;
  white-space: pre;
  overflow-wrap: normal;
  overflow-x: auto;
}

.field input:focus, .field select:focus, .field textarea:focus {
  outline: 2px solid var(--slate);
  outline-offset: 0;
  border-color: var(--slate);
}

.field-grid { display: grid; gap: 0 1.25rem; grid-template-columns: repeat(2, minmax(0, 1fr)); }

.actions { margin: 0; display: flex; gap: 0.625rem; flex-wrap: wrap; align-items: center; }

.hint { font-size: 0.8125rem; color: var(--slate-mid); margin: 0.75rem 0 0; }

/* ---------- stone picker ---------- */

/* The stone-to-place mode as buttons: the board's own glyphs (filled for P1,
   outlined for P2), each with its name, instead of a bare text select. The
   selected mode marks itself the way a board source square does — a stone
   outline. */
.stone-picker {
  display: inline-flex;
  gap: 0.375rem;
  flex-wrap: wrap;
}

.stone-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--record);
  font-size: 0.8125rem;
  color: var(--slate);
  background: #fff;
  border: 1px solid var(--rule);
  border-radius: 3px;
  padding: 0.4375rem 0.75rem;
  cursor: pointer;
}

.stone-btn:hover { border-color: var(--slate); }

.stone-btn .stone-glyph { font-size: 1.125rem; line-height: 1; }

.stone-btn.is-selected {
  border-color: var(--stone);
  outline: 2px solid var(--stone);
  outline-offset: -2px;
  background: var(--panel);
}

/* ---------- the move builder: lift stepper and drop adjusters ---------- */

.stepper, .drop-row {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  flex-wrap: wrap;
}

.step-btn {
  font-family: var(--record);
  font-size: 0.875rem;
  line-height: 1;
  color: var(--slate);
  background: #fff;
  border: 1px solid var(--rule);
  border-radius: 3px;
  width: 1.75rem;
  height: 1.75rem;
  cursor: pointer;
}

.step-btn:hover:not(:disabled) { border-color: var(--slate); }

.step-btn:disabled { color: var(--slate-mid); cursor: default; opacity: 0.45; }

.stepper-value, .drop-count {
  font-family: var(--record);
  font-size: 0.8125rem;
  color: var(--slate);
  min-width: 1.25rem;
  text-align: center;
}

.drop-step {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--rule);
  border-radius: 3px;
  background: var(--panel);
}

.drop-square { font-size: 0.75rem; color: var(--slate-mid); }

.stack-partition {
  font-size: 1.125rem;
  letter-spacing: 0.05em;
  color: var(--slate);
  margin: 0 0 0.375rem;
}

/* ---------- buttons ---------- */

.btn {
  font-family: var(--record);
  font-size: 0.8125rem;
  letter-spacing: 0.02em;
  padding: 0.5rem 0.9rem;
  border: 1px solid var(--slate);
  border-radius: 3px;
  background: var(--slate);
  color: var(--panel);
  cursor: pointer;
  text-decoration: none;
  display: inline-block;
}

.btn:hover { background: #223642; border-color: #223642; color: var(--panel); }

.btn-quiet { background: transparent; color: var(--slate); border-color: var(--rule); }
.btn-quiet:hover { background: transparent; color: var(--slate); border-color: var(--slate); }

/* Destructive actions read in oxide, but keep a neutral border: they sit four to
   a row in the user table and a red box each would drown the page. */
.btn-danger { background: transparent; color: var(--oxide); border-color: var(--rule); }
.btn-danger:hover { background: var(--oxide-pale); color: var(--oxide); border-color: var(--oxide); }

.btn-sm { font-size: 0.75rem; padding: 0.3125rem 0.5625rem; }

/* ---------- data ---------- */

.table-scroll { overflow-x: auto; }

.data { width: 100%; border-collapse: collapse; font-size: 0.875rem; }

.data th {
  text-align: left;
  font-family: var(--record);
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--slate-mid);
  padding: 0 1rem 0.625rem 0;
  border-bottom: 1px solid var(--rule);
  white-space: nowrap;
}

.data td {
  padding: 0.75rem 1rem 0.75rem 0;
  border-bottom: 1px solid var(--rule);
  vertical-align: middle;
}

.data tr:last-child td { border-bottom: 0; }

.data .key, .data .mono { font-family: var(--record); }

.data .num { font-family: var(--record); font-variant-numeric: tabular-nums; }

.dim { color: var(--slate-mid); }

.tag {
  font-family: var(--record);
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  border: 1px solid var(--rule);
  border-radius: 2px;
  padding: 0.125rem 0.375rem;
  white-space: nowrap;
}

.tag-flag { border-color: var(--oxide); color: var(--oxide); }

/* Never wrap: inside .table-scroll, wrapping inflates every row instead of
   scrolling. The container scrolls, so nothing is lost. */
.row-actions { display: flex; gap: 0.375rem; flex-wrap: nowrap; }
.row-actions form { margin: 0; }

/* ---------- secret ---------- */

.secret {
  font-family: var(--record);
  font-size: 1.25rem;
  background: var(--panel);
  border: 1px solid var(--rule);
  border-left: 2px solid var(--stone);
  border-radius: 3px;
  padding: 1rem 1.25rem;
  margin: 0 0 1.25rem;
  overflow-x: auto;
  user-select: all;
}

/* ---------- narrow screens ---------- */

@media (max-width: 34rem) {
  .masthead-inner { padding: 0.75rem 1.25rem; }
  .nav { gap: 1.125rem; width: 100%; }
  .whoami { padding-left: 0; border-left: 0; }
  .page { padding: 2rem 1.25rem 4rem; }
  .field-grid { grid-template-columns: minmax(0, 1fr); }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
`;
}
