// Bootstrap admin CLI — creates the first admin when none exists and prints a
// generated password to its own terminal. The server process never sees the
// password; it is never written to the structured logger.
import { loadConfig } from './config.js';
import { openDatabase, runMigrations } from './db.js';
import { createPersistence } from './persistence.js';
import { createAuth } from './auth.js';
import { createLogger } from './logging.js';

const logger = createLogger();

async function main(): Promise<void> {
  const configResult = loadConfig(process.env);
  if (configResult.isErr()) {
    logger.log('error', 'invalid configuration', { error: configResult.error });
    process.exit(1);
  }
  const config = configResult.value;

  const dbResult = openDatabase(config.databasePath);
  if (dbResult.isErr()) {
    logger.log('error', 'failed to open database', { error: dbResult.error, databasePath: config.databasePath });
    process.exit(1);
  }
  const db = dbResult.value;

  const migrationResult = runMigrations(db);
  if (migrationResult.isErr()) {
    logger.log('error', 'failed to run migrations', { error: migrationResult.error });
    process.exit(1);
  }

  const auth = createAuth(createPersistence(db));
  const result = await auth.bootstrapAdmin();
  db.close();

  if (result.isErr()) {
    if (result.error.code === 'admin-exists') {
      logger.log('error', 'refusing to bootstrap: an admin already exists', {});
      process.exit(1);
    }
    logger.log('error', 'failed to bootstrap admin', { error: result.error });
    process.exit(1);
  }

  const { username, password } = result.value;
  // Plain stdout on purpose — this is the operator's terminal, not the log.
  process.stdout.write(`Created admin account "${username}".\n`);
  process.stdout.write(`Initial password: ${password}\n`);
  process.stdout.write('You must change this password on first login.\n');
}

void main();
