import { randomUUID } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(): Logger {
  return {
    log(level, message, fields) {
      const line = JSON.stringify({
        time: new Date().toISOString(),
        level,
        msg: message,
        ...fields,
      });
      process.stdout.write(`${line}\n`);
    },
  };
}

export function newRequestId(): string {
  return randomUUID();
}
