# All persistence is in SQLite; analytics and backups are deferred

All state — users, sessions, games, game records, game stats, and the activity trail — lives in a single SQLite database (better-sqlite3 on Node). Derived game stats are written at game end so data for future ratings and analysis is not lost, but no analytics pipeline is built now. Backup and warehousing are deliberately out of scope: a future organisational-scale data-warehousing and recovery scheme will address them orthogonally.

Status: accepted

## Considered options

- **Postgres or another external datastore** — rejected: a single small self-hosted process; SQLite keeps the no-reverse-proxy, one-process deployment simple.
- **External log/analytics services** — rejected for now; the activity trail and game stats keep the data in-repo where it can be mined later.
