import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerOptions } from 'node:https';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { loadConfig } from './config.js';
import { openDatabase, runMigrations } from './db.js';
import { createLogger } from './logging.js';
import { Metrics } from './metrics.js';
import { createApp, type App } from './app.js';

const logger = createLogger();

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

async function handleRequest(app: App, nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  try {
    const host = nodeReq.headers.host ?? 'localhost';
    const url = new URL(nodeReq.url ?? '/', `http://${host}`);
    const headers = new Headers();
    for (const [name, value] of Object.entries(nodeReq.headers)) {
      if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
      if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item);
      } else {
        headers.append(name, value);
      }
    }
    const method = nodeReq.method ?? 'GET';
    let body: Uint8Array | null = null;
    if (method !== 'GET' && method !== 'HEAD') {
      const chunks: Buffer[] = [];
      for await (const chunk of nodeReq) chunks.push(chunk as Buffer);
      body = Buffer.concat(chunks);
    }
    const request = new Request(url, { method, headers, body });
    const response = await app.fetch(request);

    nodeRes.statusCode = response.status;
    const setCookies = response.headers.getSetCookie();
    for (const [name, value] of response.headers) {
      if (name.toLowerCase() === 'set-cookie' && setCookies.length > 0) continue;
      nodeRes.setHeader(name, value);
    }
    if (setCookies.length > 0) nodeRes.setHeader('set-cookie', setCookies);

    if (response.body) {
      const stream = Readable.fromWeb(response.body as unknown as NodeWebReadableStream);
      stream.pipe(nodeRes);
    } else {
      nodeRes.end();
    }
  } catch (error) {
    logger.log('error', 'request handling failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (!nodeRes.headersSent) {
      nodeRes.statusCode = 500;
      nodeRes.setHeader('content-type', 'application/json');
      nodeRes.end('{"error":"Internal Server Error"}');
    } else {
      nodeRes.end();
    }
  }
}

function buildServer(app: App, tls: { certPath: string; keyPath: string } | null): Server {
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void handleRequest(app, req, res);
  };
  if (tls) {
    const options: ServerOptions = {
      cert: readFileSync(tls.certPath),
      key: readFileSync(tls.keyPath),
    };
    return createHttpsServer(options, handler);
  }
  return createHttpServer(handler);
}

function main(): void {
  const configResult = loadConfig(process.env);
  if (configResult.isErr()) {
    logger.log('error', 'invalid configuration', { error: configResult.error });
    process.exit(1);
  }
  const config = configResult.value;

  const dbResult = openDatabase(config.databasePath);
  if (dbResult.isErr()) {
    logger.log('error', 'failed to open database', {
      error: dbResult.error,
      databasePath: config.databasePath,
    });
    process.exit(1);
  }
  const db = dbResult.value;

  const migrationResult = runMigrations(db);
  if (migrationResult.isErr()) {
    logger.log('error', 'failed to run migrations', { error: migrationResult.error });
    process.exit(1);
  }

  const metrics = new Metrics();
  const app = createApp({ db, metrics, logger });

  let server: Server;
  try {
    server = buildServer(app, config.tls);
  } catch (error) {
    logger.log('error', 'failed to build server', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  server.listen(config.port, () => {
    logger.log('info', 'server listening', {
      port: config.port,
      tls: config.tls !== null,
      databasePath: config.databasePath,
    });
  });
}

main();
