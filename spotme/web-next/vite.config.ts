import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Standalone beachhead. Not part of the Vercel project (which is rooted at
// spotme/web), not imported by spotme/web. The @spotme/contracts alias lets the
// shared domain types resolve; they are type-only, so the runtime bundle
// contains none of the contracts source.
export default defineConfig({
  plugins: [react()],
  // Analytics env names (ADR-031), build-time only. Empty POSTHOG_KEY (plus
  // the compile-time flag) keeps analytics NOOP; the owner is on PostHog US
  // Cloud, hence the default host.
  define: {
    __POSTHOG_KEY__: JSON.stringify(process.env.POSTHOG_KEY ?? ''),
    __POSTHOG_HOST__: JSON.stringify(process.env.POSTHOG_HOST ?? ''),
  },
  resolve: {
    alias: {
      '@spotme/contracts': fileURLToPath(new URL('../packages/contracts/src/index.ts', import.meta.url)),
    },
  },
});
