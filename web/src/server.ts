import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { ServerOptions } from 'node:https';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { openDatabase, runMigrations } from './db.js';
import { createPersistence } from './persistence.js';
import { createLogger } from './logging.js';
import { Metrics } from './metrics.js';
import { createApp, type App } from './app.js';
import { createHandler } from './http-bridge.js';

const logger = createLogger();

function buildServer(app: App, tls: { certPath: string; keyPath: string } | null): Server {
  const handler = createHandler({ app, logger });
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
  const persistence = createPersistence(db);
  const app = createApp({ persistence, metrics, logger });

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
