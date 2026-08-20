import { CLIENT_SCRIPT_URL } from './static-urls.js';

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
      // The bundle is served as a committed file (ADR-0013), cached by the
      // browser; the stylesheet is likewise a file. Alpine stays on the CDN.
      return `\n<script defer src="${CLIENT_SCRIPT_URL}"></script>\n<script defer src="${ALPINE_URL}"></script>`;
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
