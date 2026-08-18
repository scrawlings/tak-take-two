/**
 * A fingerprint of the client sources the inlined bundle is built from. The
 * bundle is committed so nothing needs a build step to run, which leaves one
 * failure mode: editing `src/client/` and forgetting to rebuild, so the page
 * silently serves yesterday's script. The build records this fingerprint and a
 * test recomputes it, which turns that silence into a failing test.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export function sourcesFingerprint(): string {
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'client');
  const hash = createHash('sha256');
  for (const name of readdirSync(dir).sort()) {
    hash.update(name);
    hash.update(readFileSync(join(dir, name)));
  }
  return hash.digest('hex');
}
