import { defineConfig } from 'vite'

export default defineConfig({
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
    // spotme-core is CommonJS and lives outside the web root. Pre-bundling it
    // lets Vite apply its CJS interop so `transliterate` imports cleanly.
    include: ['spotme-core/core/translit.js', '@trystero-p2p/torrent']
  }
})
