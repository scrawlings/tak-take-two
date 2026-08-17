# 06 — Web: scaffold + observability base

**What to build:** The web app boots from env config (dev machine and production), with SQLite migrations (including the activity trail and game stats tables), health endpoints, structured logging with request ids, friendly error responses, TLS via PEM env paths, /metrics, a status page, and the datastar/Alpine base.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] The server starts with default env on a dev machine and production-style env under systemd; TLS terminates when PEM cert/key paths are set, plain HTTP otherwise.
- [ ] Migrations create the schema (users, sessions, games, game records, activity trail, game stats) idempotently.
- [ ] `/healthz` and `/readyz` report liveness and readiness, including a database check.
- [ ] Every request gets a request id; logs are structured JSON to stdout; unexpected errors log with the id and return a generic friendly response.
- [ ] `/metrics` exposes Prometheus-text counters (HTTP counts/latency, active sessions, games by state, errors, DB size); a human-readable status page is served.
- [ ] A base page shell renders with datastar and Alpine wired up.
