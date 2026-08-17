const DATASTAR_URL =
  'https://cdn.jsdelivr.net/npm/@starfederation/datastar@1.0.0-beta.11/dist/datastar.js';
const ALPINE_URL = 'https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js';
const FONTS_URL =
  'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=IBM+Plex+Mono:wght@400;500&display=swap';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface ShellUser {
  displayName: string;
  username: string;
  role: 'admin' | 'player';
}

/**
 * The board mark — a 5×5 Tak board in miniature: a road of light stones in
 * column c, one dark stone at a2. `hero` renders the larger, animated
 * landing mark; decorative instances are hidden from assistive tech.
 */
export function boardMark(opts: { hero?: boolean; hidden?: boolean } = {}): string {
  const cells: string[] = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      const isRoad = x === 2; // column c — a complete road
      const isDark = x === 0 && y === 1; // a2
      const cls = isRoad ? 'bm-l' : isDark ? 'bm-d' : '';
      cells.push(`<i${cls ? ` class="${cls}"` : ''}></i>`);
    }
  }
  const cls = ['board-mark', opts.hero ? 'board-mark--hero' : ''].filter(Boolean).join(' ');
  const label = opts.hero
    ? ' role="img" aria-label="A Tak board: a road of light stones in column c, one dark stone at a2"'
    : ' aria-hidden="true"';
  return `<span class="${cls}"${label}>${cells.join('')}</span>`;
}

function masthead(user?: ShellUser): string {
  const nav = user
    ? `<nav class="nav" aria-label="Account">
        <a href="/account">account</a>
        ${user.role === 'admin' ? '<a href="/admin/users">admin</a>' : ''}
        <a href="/status">status</a>
        <span class="who"><i class="stone stone--light" aria-hidden="true"></i>${escapeHtml(user.displayName)}</span>
        <form method="post" action="/logout"><button type="submit" class="nav-btn">sign out</button></form>
      </nav>`
    : `<nav class="nav" aria-label="Site">
        <a href="/login">sign in</a>
        <a href="/status">status</a>
      </nav>`;
  return `<header class="site-head"><div class="head-inner">
  <a class="brand" href="/"><span class="brand-mark">${boardMark({ hidden: true })}</span><span class="brand-name">Tak</span></a>
  ${nav}
</div></header>`;
}

// Base page shell: a shared masthead and footer around the page body, plus the
// design system stylesheet. Datastar (SSE plugin included) and Alpine load from
// CDN so later tickets can build server-driven views on top of it.
export function renderShell(title: string, bodyHtml: string, user?: ShellUser): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="${FONTS_URL}" rel="stylesheet">
  <link rel="stylesheet" href="/site.css">
</head>
<body>
${masthead(user)}
<main>${bodyHtml}</main>
<footer class="site-foot">
  <p>Tak — the game of the road and the stone. <a href="/status">status</a></p>
</footer>
<script type="module" src="${DATASTAR_URL}"></script>
<script defer src="${ALPINE_URL}"></script>
</body>
</html>`;
}

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="4" fill="#231E16"/>
  <g stroke="#3C6150" stroke-width="1" fill="none">
    <path d="M6.5 1v30 M13.5 1v30 M20.5 1v30 M27.5 1v30 M1 6.5h30 M1 13.5h30 M1 20.5h30 M1 27.5h30"/>
  </g>
  <circle cx="17" cy="4" r="2.7" fill="#E7D5A8"/>
  <circle cx="17" cy="11" r="2.7" fill="#E7D5A8"/>
  <circle cx="17" cy="18" r="2.7" fill="#E7D5A8"/>
  <circle cx="17" cy="25" r="2.7" fill="#E7D5A8"/>
  <circle cx="4" cy="11" r="2.7" fill="#382C21" stroke="#E7D5A8" stroke-width="1"/>
</svg>`;

export function siteCss(): string {
  return `:root {
  --paper: #F2EEE3;
  --panel: #FBF8F0;
  --ink: #231E16;
  --ink-soft: #5B5443;
  --ink-faint: #6E6655;
  --felt: #2F4D3D;
  --felt-bright: #3C6150;
  --felt-pale: #E7EDE4;
  --stone-light: #E7D5A8;
  --stone-dark: #382C21;
  --line: #DCD4C0;
  --flag: #9C3B26;
  --flag-pale: #F6E5DE;
  --on-ink: #CFC7B5;
  --on-ink-strong: #F0E7CE;
  --dot-on-ink: rgba(231, 213, 168, 0.14);
  --dot-on-paper: #E1D9C4;
  --font-display: 'Fraunces', Georgia, 'Times New Roman', serif;
  --font-mono: 'IBM Plex Mono', 'SFMono-Regular', Menlo, Consolas, monospace;
}

* { box-sizing: border-box; }

html { color-scheme: light; }

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 15px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}

::selection { background: var(--felt); color: var(--panel); }

a { color: var(--felt); text-underline-offset: 3px; }
a:hover { color: var(--felt-bright); }

:focus-visible { outline: 2px solid var(--felt-bright); outline-offset: 2px; border-radius: 2px; }

/* ---------- masthead ---------- */

.site-head { background: var(--ink); }
.head-inner {
  max-width: 64rem;
  margin: 0 auto;
  padding: 0.65rem 1.25rem;
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}
.brand { display: inline-flex; align-items: center; gap: 0.65rem; text-decoration: none; color: var(--on-ink-strong); }
.brand:hover { color: #ffffff; }
.brand-name { font-family: var(--font-display); font-size: 1.4rem; font-weight: 600; letter-spacing: 0.01em; line-height: 1; }

.nav { margin-left: auto; display: flex; align-items: center; gap: 1.1rem; flex-wrap: wrap; font-size: 0.8rem; }
.nav a { color: var(--on-ink); text-decoration: none; transition: color 0.12s ease; }
.nav a:hover { color: var(--on-ink-strong); text-decoration: underline; text-underline-offset: 4px; }
.who { display: inline-flex; align-items: center; gap: 0.45rem; color: var(--on-ink-strong); font-size: 0.78rem; }
.nav-btn {
  background: none; border: 0; padding: 0; font: inherit;
  color: var(--on-ink); cursor: pointer; text-decoration: underline; text-underline-offset: 4px;
}
.nav-btn:hover { color: var(--on-ink-strong); }

/* ---------- board mark ---------- */

.board-mark { display: inline-grid; grid-template-columns: repeat(5, 4px); gap: 2px; width: 28px; height: 28px; }
.board-mark i { border-radius: 50%; }
.site-head .board-mark i { background: var(--dot-on-ink); }
.site-head .board-mark i.bm-l { background: var(--stone-light); box-shadow: inset 0 0 0 1px rgba(56, 44, 33, 0.4); }
.site-head .board-mark i.bm-d { background: var(--stone-dark); box-shadow: inset 0 0 0 1px rgba(231, 213, 168, 0.4); }
main .board-mark i { background: var(--dot-on-paper); }
main .board-mark i.bm-l { background: var(--stone-light); box-shadow: inset 0 0 0 1px rgba(56, 44, 33, 0.25); }
main .board-mark i.bm-d { background: var(--stone-dark); box-shadow: inset 0 0 0 1px rgba(231, 213, 168, 0.3); }

.board-mark--hero { grid-template-columns: repeat(5, 10px); gap: 3px; width: 62px; height: 62px; }
main .board-mark--hero i.bm-l { animation: stone-in 0.5s ease backwards; }
main .board-mark--hero i.bm-l:nth-child(3) { animation-delay: 0.15s; }
main .board-mark--hero i.bm-l:nth-child(8) { animation-delay: 0.35s; }
main .board-mark--hero i.bm-l:nth-child(13) { animation-delay: 0.55s; }
main .board-mark--hero i.bm-l:nth-child(18) { animation-delay: 0.75s; }
main .board-mark--hero i.bm-l:nth-child(23) { animation-delay: 0.95s; }
main .board-mark--hero i.bm-d { animation: stone-in 0.4s ease 1.15s backwards; }

@keyframes stone-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ---------- page frame ---------- */

main { max-width: 64rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
main > .narrow { max-width: 26rem; margin: 0 auto; }

.eyebrow { font-size: 0.74rem; color: var(--ink-faint); margin: 0 0 0.4rem; }

h1 {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: clamp(2.1rem, 6vw, 2.9rem);
  line-height: 1.05;
  letter-spacing: -0.01em;
  margin: 0 0 0.55rem;
}
h2 { font-family: var(--font-display); font-weight: 600; font-size: 1.5rem; line-height: 1.15; margin: 0 0 0.9rem; }

.lede { color: var(--ink-soft); max-width: 38rem; margin: 0 0 1.6rem; }

.section { border-top: 1px solid var(--line); margin-top: 2.6rem; padding-top: 1.8rem; }

.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 1.5rem 1.6rem; }

/* ---------- notices ---------- */

.notice, .ok {
  background: var(--felt-pale); border-left: 3px solid var(--felt); color: var(--ink-soft);
  border-radius: 3px; padding: 0.65rem 0.9rem; margin: 0 0 1.4rem; font-size: 0.85rem;
}
.error {
  background: var(--flag-pale); border-left: 3px solid var(--flag); color: var(--flag);
  border-radius: 3px; padding: 0.65rem 0.9rem; margin: 0 0 1.4rem; font-size: 0.85rem;
}

/* ---------- forms ---------- */

.field { margin: 0 0 1.05rem; }
.field label {
  display: block; font-size: 0.7rem; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--ink-soft); margin: 0 0 0.35rem;
}
.field input, .field select {
  width: 100%; font: inherit; font-size: 0.92rem; color: var(--ink);
  background: var(--panel); border: 1px solid var(--line); border-radius: 3px;
  padding: 0.55rem 0.6rem;
}
.field input:focus, .field select:focus {
  border-color: var(--felt); outline: 2px solid rgba(47, 77, 61, 0.22); outline-offset: 0;
}
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 1.3rem; }
.field--wide { grid-column: 1 / -1; }
.form-actions { display: flex; gap: 0.7rem; align-items: center; margin-top: 0.4rem; }
.form-note { font-size: 0.74rem; color: var(--ink-faint); margin: 0.7rem 0 0; }

/* ---------- buttons ---------- */

.btn {
  font: inherit; font-size: 0.84rem; letter-spacing: 0.02em; padding: 0.55rem 1rem;
  border-radius: 3px; border: 1px solid transparent; cursor: pointer; text-decoration: none;
  display: inline-block; transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}
.btn--primary { background: var(--felt); color: var(--panel); }
.btn--primary:hover { background: var(--felt-bright); color: var(--panel); }
.btn--ghost { background: transparent; border-color: var(--line); color: var(--ink-soft); }
.btn--ghost:hover { border-color: var(--ink-soft); color: var(--ink); }
.btn--danger { background: transparent; border-color: var(--line); color: var(--ink-soft); }
.btn--danger:hover { border-color: var(--flag); color: var(--flag); }
.btn--sm { padding: 0.3rem 0.6rem; font-size: 0.72rem; }

/* ---------- tables (the board grid) ---------- */

.table-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 4px; background: var(--panel); }
table.data { width: 100%; border-collapse: collapse; font-size: 0.8rem; min-width: 46rem; }
.data th {
  background: var(--ink); color: var(--stone-light); font-weight: 500; text-align: left;
  font-size: 0.66rem; letter-spacing: 0.09em; text-transform: uppercase;
  padding: 0.55rem 0.8rem; white-space: nowrap;
}
.data td { padding: 0.55rem 0.8rem; border-top: 1px solid var(--line); vertical-align: middle; }
.data td + td, .data th + th { border-left: 1px solid var(--line); }
.data tbody tr:hover { background: rgba(47, 77, 61, 0.05); }
.data .u { font-weight: 500; }
.data .dim { color: var(--ink-faint); }

.actions { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.actions form { margin: 0; }

/* ---------- chips & stones ---------- */

.chip {
  display: inline-block; padding: 0.12rem 0.5rem; border-radius: 999px;
  border: 1px solid var(--line); font-size: 0.66rem; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--ink-soft); white-space: nowrap;
}
.chip--blocked { background: var(--ink); border-color: var(--ink); color: var(--stone-light); }
.chip--warn { background: var(--flag-pale); border-color: var(--flag-pale); color: var(--flag); }

.stone { display: inline-block; width: 0.55rem; height: 0.55rem; border-radius: 50%; vertical-align: -1px; }
.stone--light { background: var(--stone-light); border: 1px solid var(--stone-dark); }
.stone--off { border: 1px solid var(--line); background: transparent; }

/* ---------- account ---------- */

.who-iam { display: flex; align-items: center; gap: 0.8rem; margin: 0 0 1.8rem; }
.who-iam .stone { width: 0.8rem; height: 0.8rem; }
.who-iam .name { font-family: var(--font-display); font-size: 1.3rem; font-weight: 600; line-height: 1.1; }
.who-iam .handle { color: var(--ink-faint); font-size: 0.78rem; }

.link-tile {
  display: flex; align-items: baseline; gap: 0.9rem; justify-content: space-between;
  border: 1px solid var(--line); border-radius: 4px; background: var(--panel);
  padding: 0.85rem 1.1rem; text-decoration: none; color: var(--ink); margin-bottom: 0.7rem;
  transition: border-color 0.12s ease;
}
.link-tile:hover { border-color: var(--felt); color: var(--ink); }
.link-tile .t { font-family: var(--font-display); font-weight: 500; font-size: 1.02rem; }
.link-tile .d { color: var(--ink-faint); font-size: 0.78rem; }
.link-tile .go { color: var(--felt); }

/* ---------- hero / landing ---------- */

.hero { text-align: center; padding: 1.2rem 0 1rem; }
.hero .board-mark { margin-bottom: 1.5rem; }
.hero h1 { max-width: 22ch; margin: 0 auto 0.6rem; }
.hero .lede { margin-left: auto; margin-right: auto; }
.hero-actions { display: flex; gap: 0.8rem; justify-content: center; margin-top: 1.5rem; }

/* ---------- secret / password reveal ---------- */

.secret {
  background: var(--ink); color: var(--stone-light); border-radius: 4px;
  padding: 1rem 1.2rem; margin: 0 0 1rem;
}
.secret code { font-family: var(--font-mono); font-size: 1.05rem; word-break: break-all; }

/* ---------- footer ---------- */

.site-foot {
  border-top: 1px solid var(--line); color: var(--ink-faint);
  font-size: 0.72rem; text-align: center; padding: 1.3rem 1.25rem 1.6rem;
}
.site-foot p { margin: 0; }

/* ---------- responsive ---------- */

@media (max-width: 640px) {
  main { padding-top: 1.8rem; }
  .form-grid { grid-template-columns: 1fr; }
  .link-tile { flex-wrap: wrap; }
}

@media (prefers-reduced-motion: reduce) {
  .board-mark--hero i { animation: none !important; }
  .btn, .nav a, .link-tile { transition: none !important; }
}`;
}
