import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('config', () => {
  it('uses defaults with no env vars set', () => {
    const result = loadConfig({});
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.port).toBe(3000);
    expect(config.databasePath).toBe('./data/tak.db');
    expect(config.tls).toBeNull();
  });

  it('TLS is off by default and on only when both PEM paths are set', () => {
    expect(loadConfig({})._unsafeUnwrap().tls).toBeNull();

    const withTls = loadConfig({ TLS_CERT_PATH: '/certs/cert.pem', TLS_KEY_PATH: '/certs/key.pem' });
    expect(withTls.isOk()).toBe(true);
    expect(withTls._unsafeUnwrap().tls).toEqual({ certPath: '/certs/cert.pem', keyPath: '/certs/key.pem' });
  });

  it('rejects when only one TLS path is set', () => {
    expect(loadConfig({ TLS_CERT_PATH: '/certs/cert.pem' }).isErr()).toBe(true);
    expect(loadConfig({ TLS_KEY_PATH: '/certs/key.pem' }).isErr()).toBe(true);
  });

  it('parses PORT and rejects an invalid port', () => {
    expect(loadConfig({ PORT: '8080' })._unsafeUnwrap().port).toBe(8080);
    expect(loadConfig({ PORT: 'abc' }).isErr()).toBe(true);
    expect(loadConfig({ PORT: '0' }).isErr()).toBe(true);
    expect(loadConfig({ PORT: '70000' }).isErr()).toBe(true);
  });
});
