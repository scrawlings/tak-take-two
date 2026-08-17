# 06 — Web: scaffold + observability base

**What to build:** The web app boots from env config (dev machine and production), with SQLite migrations (including the activity trail and game stats tables), health endpoints, structured logging with request ids, friendly error responses, TLS via PEM env paths, /metrics, a status page, and the datastar/Alpine base.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] The server starts with default env on a dev machine and production-style env under systemd; TLS terminates when PEM cert/key paths are set, plain HTTP otherwise.
- [x] Migrations create the schema (users, sessions, games, game records, activity trail, game stats) idempotently.
- [x] `/healthz` and `/readyz` report liveness and readiness, including a database check.
- [x] Every request gets a request id; logs are structured JSON to stdout; unexpected errors log with the id and return a generic friendly response.
- [x] `/metrics` exposes Prometheus-text counters (HTTP counts/latency, active sessions, games by state, errors, DB size); a human-readable status page is served.
- [x] A base page shell renders with datastar and Alpine wired up.

## Comments

**2026-08-17 — Completed.** Scaffold shipped in commit `969039e`; this session deepened two seams in the same area:

- `web/src/persistence.ts` (new) — the typed persistence module (`ping`, `metricsSnapshot`, `appendActivityTrail`); the `Db` driver no longer appears in app/route interfaces. `/metrics`, `/readyz`, and `/status` consume it. Tests: `web/test/persistence.test.ts` (8).
- `web/src/http-bridge.ts` (new) — the node:http ↔ fetch adapter extracted from `server.ts` (pure translation kernels + composed handler, plain-data inputs). Tests: `web/test/http-bridge.test.ts` (13).
- Server boot smoke-tested against real HTTP (GET, POST body, headers, 404 fallback).

All checklist items pass. See `docs/agents/triage-labels.md` for the `done` status convention.
