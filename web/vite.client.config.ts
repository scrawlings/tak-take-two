import { defineConfig } from 'vite';

/**
 * The client bundle (ADR-0006): the move builder and its Alpine adapter, built
 * to one IIFE that `scripts/build-client.ts` then emits as a TS string for the
 * game page to inline. This deployment serves no static files (ADR-0002), so
 * the bundle travels inside the HTML rather than as its own request.
 */
export default defineConfig({
  build: {
    lib: {
      entry: 'src/client/board-adapter.ts',
      formats: ['iife'],
      name: 'TakBoard',
      fileName: () => 'board.js',
    },
    outDir: 'dist-client',
    emptyOutDir: true,
    target: 'es2022',
    minify: true,
  },
});
