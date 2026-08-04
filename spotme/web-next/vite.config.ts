import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Standalone beachhead. Not part of the Vercel project (which is rooted at
// spotme/web), not imported by spotme/web. The @spotme/contracts alias lets the
// shared domain types resolve; they are type-only, so the runtime bundle
// contains none of the contracts source.
//
// Camera Stage 2A: the camera-lab entry (lab/camera-lab.html) is added as a
// SECOND rollup input ONLY when CAMERA_LAB_ENABLED=true. In a normal/
// production build the flag is absent, so the lab HTML, its React entry, the
// four activation wirings, and the vendored engine packages are NOT rollup
// inputs and never enter the artifact. `scripts/check-camera-lab-absent.mjs`
// asserts this on the built dist/.
const CAMERA_LAB = process.env.CAMERA_LAB_ENABLED === 'true';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@spotme/contracts': fileURLToPath(new URL('../packages/contracts/src/index.ts', import.meta.url)),
    },
  },
  build: CAMERA_LAB
    ? {
        rollupOptions: {
          input: {
            main: fileURLToPath(new URL('./index.html', import.meta.url)),
            'camera-lab': fileURLToPath(new URL('./lab/camera-lab.html', import.meta.url)),
          },
        },
      }
    : {},
});
