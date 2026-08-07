import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Standalone beachhead. Not part of the Vercel project (which is rooted at
// spotme/web), not imported by spotme/web. The @spotme/contracts alias lets the
// shared domain types resolve; they are type-only, so the runtime bundle
// contains none of the contracts source.
export default defineConfig({
  plugins: [react()],
  // TILES_URL (env name, owner-set at build time) is the ONLY tile source for
  // the self-hosted map (ADR-030). Empty default = map structurally inert.
  define: {
    __TILES_URL__: JSON.stringify(process.env.TILES_URL ?? ''),
  },
  resolve: {
    alias: {
      '@spotme/contracts': fileURLToPath(new URL('../packages/contracts/src/index.ts', import.meta.url)),
    },
  },
});
