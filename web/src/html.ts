const DATASTAR_URL =
  'https://cdn.jsdelivr.net/npm/@starfederation/datastar@1.0.0-beta.11/dist/datastar.js';
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

/** What the shell needs to draw navigation: who is here, and where they are. */
export interface PageContext {
  readonly user?: NavUser;
  /** Request path, used to mark the current destination. */
  readonly path?: string;
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
  // Admins administer and never play (CONTEXT.md), so Games is a player's link.
  const items: NavItem[] =
    user.role === 'admin'
      ? [{ href: '/admin/users', label: 'Users' }]
      : [{ href: '/games', label: 'Games' }];
  items.push({ href: '/account', label: 'Account' }, { href: '/status', label: 'Status' });
  return items;
}

/** A destination is current when it is the path itself or an ancestor of it. */
function isCurrent(href: string, path: string | undefined): boolean {
  if (!path) return false;
  return path === href || path.startsWith(`${href}/`);
}

function masthead(ctx: PageContext): string {
  const { user, path } = ctx;
  // A forced password change gates every other action, so offering links that
  // only bounce back here would be a dead end. Show the way out instead.
  const gated = user?.forcePasswordChange === true;

  const links = gated
    ? ''
    : navItems(user)
        .map((item) => {
          const current = isCurrent(item.href, path);
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
 * Base page shell: a shared masthead around the page body, plus the stylesheet.
 * Datastar (SSE plugin included) and Alpine load from CDN so later tickets can
 * build server-driven views on top of it.
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
</main>
<script type="module" src="${DATASTAR_URL}"></script>
<script defer src="${ALPINE_URL}"></script>
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

.field label {
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
