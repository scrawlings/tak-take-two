import { defineConfig } from 'vite';

/**
 * The client bundle (ADR-0006): every Alpine component the site has — the move
 * builder and its adapter, and the SSE stream component (ticket 14) — built to
 * one IIFE that `scripts/build-client.ts` then emits as a TS string for the
 * shell to inline. This deployment serves no static files (ADR-0002), so the
 * bundle travels inside the HTML rather than as its own request.
 */
export default defineConfig({
  build: {
    lib: {
      entry: 'src/client/index.ts',
      formats: ['iife'],
      name: 'TakClient',
      fileName: () => 'client.js',
    },
    outDir: 'dist-client',
    emptyOutDir: true,
    target: 'es2022',
    minify: true,
  },
});
