## Agent skills

### Issue tracker

Issues are tracked as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), plus `done` for completed tickets. See `docs/agents/triage-labels.md`.

### The client bundle

`web/src/client/` (the board move builder, its Alpine adapter, and the SSE
stream component) is bundled from `web/src/client/index.ts` by
`npm run build:client` into the committed `web/src/client-script.generated.ts`,
which `renderShell` inlines for pages that ask for `scripts: 'client'`. Rebuild
after changing anything under `web/src/client/` — a test fails when the bundle
and its sources drift. See ADR-0006 and ADR-0007.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
