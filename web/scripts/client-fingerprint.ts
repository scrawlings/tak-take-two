/**
 * A fingerprint of everything the inlined client bundle is built from. The
 * bundle is committed so nothing needs a build step to run, which leaves one
 * failure mode: editing the sources and forgetting to rebuild, so the game page
 * silently serves yesterday's script. The build records this fingerprint and a
 * test recomputes it, which turns that silence into a failing test.
 *
 * The build config counts as a source — changing the target or the minifier
 * changes the bundle without touching a single module.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every file under `dir`, depth first, in a stable order. */
function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else found.push(path);
  }
  return found;
}

export function sourcesFingerprint(): string {
  const hash = createHash('sha256');
  // `contract.ts` is bundled too (the client imports it), so it counts as a
  // source even though it lives outside `src/client/`.
  const sources = [
    ...filesUnder(join(webRoot, 'src', 'client')),
    join(webRoot, 'src', 'contract.ts'),
    join(webRoot, 'vite.client.config.ts'),
  ];
  for (const path of sources) {
    // The separators keep two different file lists from hashing alike.
    hash.update(`\0${relative(webRoot, path)}\0`);
    hash.update(readFileSync(path));
  }
  return hash.digest('hex');
}
