import { Hono } from 'hono';
import type { Persistence, PersistenceSnapshot } from './persistence.js';
import { Metrics } from './metrics.js';
import type { Logger } from './logging.js';
import { newRequestId } from './logging.js';
import { renderShell, escapeHtml } from './html.js';

export interface AppDeps {
  persistence: Persistence;
  metrics: Metrics;
  logger: Logger;
}

type Variables = {
  requestId: string;
};

export type App = Hono<{ Variables: Variables }>;

function renderStatusPage(snapshot: PersistenceSnapshot, httpErrors: number): string {
  const rows: Array<[string, string]> = [
    ['active sessions', String(snapshot.activeSessions)],
    ['http errors', String(httpErrors)],
    ['database size (bytes)', String(snapshot.databaseSizeBytes)],
  ];
  for (const entry of snapshot.gamesByState) {
    rows.push([`games in state "${entry.state}"`, String(entry.count)]);
  }
  const body = rows
    .map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`)
    .join('');
  return `<h1>Status</h1><table border="1" cellpadding="6">${body}</table>`;
}

export function createApp(deps: AppDeps): App {
  const { persistence, metrics, logger } = deps;
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? newRequestId();
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);
    const start = Date.now();
    await next();
    const durationMs = Date.now() - start;
    const status = c.res.status;
    const route = c.req.routePath ?? 'unmatched';
    metrics.observeHttp(c.req.method, route, status, durationMs);
    logger.log('info', 'request', {
      requestId,
      method: c.req.method,
      path: c.req.path,
      route,
      status,
      durationMs,
    });
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.get('/readyz', (c) => {
    const result = persistence.ping();
    if (result.isErr()) {
      return c.json({ status: 'unavailable', db: 'error' }, 503);
    }
    return c.json({ status: 'ok', db: 'ok' });
  });

  app.get('/metrics', (c) => {
    return c.text(metrics.render(persistence.metricsSnapshot()), 200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    });
  });

  app.get('/status', (c) => {
    return c.html(renderShell('Status', renderStatusPage(persistence.metricsSnapshot(), metrics.httpErrors())));
  });

  app.get('/', (c) => c.html(renderShell('Tak', '<h1>Tak</h1><p>The game hosting site.</p>')));

  app.notFound((c) => c.json({ error: 'Not Found' }, 404));

  app.onError((err, c) => {
    metrics.incErrors();
    const requestId = c.get('requestId') ?? 'unknown';
    logger.log('error', 'unhandled error', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    c.header('x-request-id', requestId);
    return c.json({ error: 'Internal Server Error' }, 500);
  });

  return app;
}
