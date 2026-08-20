/**
 * Emit the built client bundle as a committed static file the shell references
 * by URL. Run through `npm run build:client -w web`, which builds the IIFE
 * first; the file (and its fingerprint sidecar) is committed so tests,
 * typecheck, and `npm run dev` never need a build step — ADR-0013 keeps the
 * ADR-0006 property, the artifact's form changes from a TS string to a file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sourcesFingerprint } from './client-fingerprint.js';

const here = dirname(fileURLToPath(import.meta.url));
const built = readFileSync(join(here, '..', 'dist-client', 'client.js'), 'utf8').trim();

const staticDir = join(here, '..', 'static');
writeFileSync(join(staticDir, 'client.js'), built);

// The fingerprint sidecar: the test recomputes it and fails when the sources
// drift from the committed bundle — the same guard the inlined string had.
writeFileSync(
  join(staticDir, 'client.fingerprint.json'),
  `${JSON.stringify({ fingerprint: sourcesFingerprint() }, null, 2)}\n`,
);

console.log(`wrote ${join(staticDir, 'client.js')} (${built.length} bytes)`);
