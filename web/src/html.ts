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

// Base page shell: loads datastar (SSE plugin included) and Alpine from CDN so
// later tickets can build server-driven views on top of it.
export function renderShell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
</head>
<body>
${bodyHtml}
<script type="module" src="${DATASTAR_URL}"></script>
<script defer src="${ALPINE_URL}"></script>
</body>
</html>`;
}
