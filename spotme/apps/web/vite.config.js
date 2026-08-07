import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig(({ command }) => {
  /* A PRODUCTION BUILD WITHOUT A BACKEND ADDRESS IS A BROKEN APP, SILENTLY.
   *
   * `api.js` resolves `API_BASE` to `''` when VITE_SPOTME_SERVER is unset, so
   * `io(\`${SERVER}/rooms\`)` becomes `io('/rooms')` — pointed at the Vercel
   * STATIC host, which runs no Socket.IO server. Every /api call goes there
   * too. The app loads, onboarding works, and every conversation then sits
   * forever unable to connect, which is the hardest kind of broken to
   * diagnose from a bug report.
   *
   * `vercel.json` is fully configured for a cloud build, so any git-connected
   * push produced exactly this. Nothing warned: the build exited 0.
   *
   * Fail here instead, where the message can say what is missing. */
  if (command === 'build' && !process.env.VITE_SPOTME_SERVER) {
    // eslint-disable-next-line no-console
    console.warn(
      '\n  VITE_SPOTME_SERVER is not set — falling back to the hosted backend\n' +
      '  recorded in api.js (see DEPLOY.md). Set it explicitly if the API has moved,\n' +
      '  or this build will talk to the wrong server.\n'
    )
  }
  return {
    // Vercel serves `dist/` as a static site — there is no server side to this
    // app at all. Peer discovery rides public infrastructure and messages go
    // directly between browsers.
    build: {
      outDir: 'dist',
      target: 'es2020'
    },
    resolve: {
      alias: {
        // The React domain shells live in packages/ui (a library, not an
        // app); the chat island imports them through this alias so the flag
        // gate's dynamic import stays the only entry point.
        '@spotme/ui': fileURLToPath(new URL('../../packages/ui', import.meta.url))
      }
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
      // spotme-core is CommonJS. Pre-bundling is what applies Vite's CJS interop
      // so `import { transliterate } from ...` resolves — drop this and dev dies
      // with "does not provide an export named 'supportedScripts'". The
      // production build survives without it (Rollup handles CJS itself), which
      // is exactly why the breakage only showed up in dev.
      include: ['spotme-core/core/translit.js', '@trystero-p2p/torrent']
    }
  }
})
