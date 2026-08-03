import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Standalone beachhead. Not part of the Vercel project (which is rooted at
// spotme/web), not imported by spotme/web. The @spotme/contracts alias lets the
// shared domain types resolve; they are type-only, so the runtime bundle
// contains none of the contracts source.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@spotme/contracts': fileURLToPath(new URL('../packages/contracts/src/index.ts', import.meta.url)),
    },
  },
});
