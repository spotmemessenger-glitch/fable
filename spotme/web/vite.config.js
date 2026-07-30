import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      /*
       * spotme-core used to resolve through `"spotme-core": "file:.."`, which
       * points at spotme/ — OUTSIDE this directory. Vercel uploads only the
       * directory it deploys from, so the package was simply absent there and
       * every production build died on:
       *
       *   Rolldown failed to resolve import "spotme-core/core/translit.js"
       *
       * which is why the site served a 404 for days. `npm run prebuild` copies
       * core/ in beside the source (the same trick the backend uses for
       * web/api), and this alias points at that copy. vendor/ must therefore
       * NOT be gitignored, or the upload would drop it all over again.
       */
      'spotme-core': resolve(here, 'vendor/spotme-core')
    }
  },
  // Vercel serves `dist/` as a static site — there is no server side to this
  // app at all. Peer discovery rides public infrastructure and messages go
  // directly between browsers.
  build: {
    outDir: 'dist',
    target: 'es2020'
  },
  server: {
    // Bind all interfaces so a phone on the same network (or over Tailscale)
    // can reach the dev server, not just localhost.
    host: true,
    port: 5173,
    // The Spot Me backend serves /api and the /rooms Socket.IO namespace —
    // same-origin in production, proxied here so dev matches it exactly.
    proxy: {
      '/api': 'http://localhost:4000',
      '/socket.io': { target: 'http://localhost:4000', ws: true }
    }
  },
  optimizeDeps: {
    // spotme-core is no longer a dependency — it is vendored source reached
    // through the alias above, so it needs no pre-bundling. Vite still applies
    // CJS interop to it as ordinary source.
    include: ['@trystero-p2p/torrent']
  }
})
