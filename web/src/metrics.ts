import type { Db } from './db.js';

interface CounterEntry {
  labels: Record<string, string>;
  value: number;
}

interface SummaryEntry {
  labels: Record<string, string>;
  count: number;
  sum: number;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(',')}}`;
}

export class Counter {
  private readonly entries = new Map<string, CounterEntry>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Record<string, string> = {}, by = 1): void {
    const key = JSON.stringify(labels);
    const existing = this.entries.get(key);
    if (existing) {
      existing.value += by;
    } else {
      this.entries.set(key, { labels: { ...labels }, value: by });
    }
  }

  series(): Iterable<CounterEntry> {
    return this.entries.values();
  }
}

export class Summary {
  private readonly entries = new Map<string, SummaryEntry>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  observe(labels: Record<string, string> = {}, value: number): void {
    const key = JSON.stringify(labels);
    const existing = this.entries.get(key);
    if (existing) {
      existing.count += 1;
      existing.sum += value;
    } else {
      this.entries.set(key, { labels: { ...labels }, count: 1, sum: value });
    }
  }

  series(): Iterable<SummaryEntry> {
    return this.entries.values();
  }
}

export interface MetricsSnapshot {
  httpRequestsTotal: Array<CounterEntry>;
  httpRequestDuration: Array<SummaryEntry>;
  httpErrorsTotal: number;
  activeSessions: number;
  gamesByState: Array<{ state: string; count: number }>;
  databaseSizeBytes: number;
}

function countTable(db: Db, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function gamesByState(db: Db): Array<{ state: string; count: number }> {
  try {
    const rows = db
      .prepare('SELECT state, COUNT(*) AS n FROM games GROUP BY state ORDER BY state')
      .all() as Array<{ state: string; n: number }>;
    return rows.map((row) => ({ state: row.state, count: row.n }));
  } catch {
    return [];
  }
}

function databaseSize(db: Db): number {
  try {
    const pageCount = db.pragma('page_count', { simple: true }) as number;
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    return pageCount * pageSize;
  } catch {
    return 0;
  }
}

export class Metrics {
  readonly httpRequestsTotal = new Counter('http_requests_total', 'Total HTTP requests handled.');
  readonly httpRequestDurationSeconds = new Summary(
    'http_request_duration_seconds',
    'HTTP request latency in seconds.',
  );
  private errors = 0;

  observeHttp(method: string, route: string, status: number, durationMs: number): void {
    this.httpRequestsTotal.inc({ method, route, status: String(status) });
    this.httpRequestDurationSeconds.observe({ method, route }, durationMs / 1000);
  }

  incErrors(): void {
    this.errors += 1;
  }

  collect(db: Db): MetricsSnapshot {
    return {
      httpRequestsTotal: [...this.httpRequestsTotal.series()],
      httpRequestDuration: [...this.httpRequestDurationSeconds.series()],
      httpErrorsTotal: this.errors,
      activeSessions: countTable(db, 'sessions'),
      gamesByState: gamesByState(db),
      databaseSizeBytes: databaseSize(db),
    };
  }

  render(db: Db): string {
    const snapshot = this.collect(db);
    const lines: string[] = [];

    lines.push(`# HELP ${this.httpRequestsTotal.name} ${this.httpRequestsTotal.help}`);
    lines.push(`# TYPE ${this.httpRequestsTotal.name} counter`);
    for (const entry of snapshot.httpRequestsTotal) {
      lines.push(`${this.httpRequestsTotal.name}${formatLabels(entry.labels)} ${entry.value}`);
    }

    lines.push(`# HELP ${this.httpRequestDurationSeconds.name} ${this.httpRequestDurationSeconds.help}`);
    lines.push(`# TYPE ${this.httpRequestDurationSeconds.name} summary`);
    for (const entry of snapshot.httpRequestDuration) {
      lines.push(
        `${this.httpRequestDurationSeconds.name}_count${formatLabels(entry.labels)} ${entry.count}`,
      );
      lines.push(`${this.httpRequestDurationSeconds.name}_sum${formatLabels(entry.labels)} ${entry.sum}`);
    }

    lines.push('# HELP http_errors_total Total unhandled request errors.');
    lines.push('# TYPE http_errors_total counter');
    lines.push(`http_errors_total ${snapshot.httpErrorsTotal}`);

    lines.push('# HELP tak_active_sessions Current number of active sessions.');
    lines.push('# TYPE tak_active_sessions gauge');
    lines.push(`tak_active_sessions ${snapshot.activeSessions}`);

    lines.push('# HELP tak_games_by_state Number of games by state.');
    lines.push('# TYPE tak_games_by_state gauge');
    for (const entry of snapshot.gamesByState) {
      lines.push(`tak_games_by_state${formatLabels({ state: entry.state })} ${entry.count}`);
    }

    lines.push('# HELP tak_database_size_bytes SQLite database size in bytes.');
    lines.push('# TYPE tak_database_size_bytes gauge');
    lines.push(`tak_database_size_bytes ${snapshot.databaseSizeBytes}`);

    return `${lines.join('\n')}\n`;
  }
}
