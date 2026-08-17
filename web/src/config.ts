import { ok, err, type Result } from 'neverthrow';

export interface TlsConfig {
  certPath: string;
  keyPath: string;
}

export interface Config {
  port: number;
  databasePath: string;
  tls: TlsConfig | null;
}

const DEFAULT_PORT = 3000;
const DEFAULT_DATABASE_PATH = './data/tak.db';

function present(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Result<Config, string> {
  let port = DEFAULT_PORT;
  const rawPort = env.PORT;
  if (present(rawPort)) {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return err(`PORT must be an integer between 1 and 65535, got ${JSON.stringify(rawPort)}`);
    }
    port = parsed;
  }

  const databasePath = present(env.DATABASE_PATH) ? (env.DATABASE_PATH as string) : DEFAULT_DATABASE_PATH;

  const certPath = env.TLS_CERT_PATH;
  const keyPath = env.TLS_KEY_PATH;
  const hasCert = present(certPath);
  const hasKey = present(keyPath);

  let tls: TlsConfig | null = null;
  if (hasCert && hasKey) {
    tls = { certPath: certPath as string, keyPath: keyPath as string };
  } else if (hasCert !== hasKey) {
    return err('TLS_CERT_PATH and TLS_KEY_PATH must both be set (or both unset)');
  }

  return ok({ port, databasePath, tls });
}
