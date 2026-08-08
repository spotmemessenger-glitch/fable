/**
 * BROWSER module resolution against the BUILT bundle.
 *
 * WHY THIS EXISTS. Every Node suite passed while all nine island surfaces were
 * dead in production: mountIsland used an assembled bare specifier
 * (`import('@spotme/ui')` left to the BROWSER to resolve), Node resolves bare
 * specifiers natively, and no test ever asked a real browser to load the real
 * build. This test closes exactly that gap and must not be skipped: it builds
 * the app, serves `dist/` over HTTP, drives a real Chromium at it, and proves
 *
 *   1. FLAG ON  → the React island mounts on #/exchange (the ui + react
 *      chunks resolve and execute in a browser), and
 *   2. FLAG OFF → no React/ui chunk is even REQUESTED (the code-split dark
 *      fence, measured on the wire rather than asserted from source).
 *
 * Chromium comes from CHROMIUM_BIN, the Playwright browsers dir, or a system
 * install. A missing browser FAILS the test — a skip would silently reopen
 * the gap this test exists to close.
 */
import { execSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

const findChromium = () => {
  if (process.env.CHROMIUM_BIN && existsSync(process.env.CHROMIUM_BIN)) return process.env.CHROMIUM_BIN
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH
  const candidates = [
    pw && join(pw, 'chromium'),
    '/opt/pw-browsers/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome'
  ].filter(Boolean)
  for (const c of candidates) {
    if (!existsSync(c)) continue
    try {
      // A Playwright browsers dir holds versioned subdirs; a file is the binary.
      const st = readdirSync(c, { withFileTypes: true })
      const sub = st.find((d) => d.isDirectory() && d.name.startsWith('chromium-'))
      if (sub) {
        const bin = join(c, sub.name, 'chrome-linux', 'chrome')
        if (existsSync(bin)) return bin
      }
    } catch {
      return c // not a directory — it is the binary
    }
  }
  return null
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' }

async function main () {
  // 1. Build the real artifact — testing a stale dist would prove nothing.
  execSync('npm run build', { cwd: root, stdio: 'pipe', env: { ...process.env, VITE_SPOTME_SERVER: 'https://api.invalid' } })
  assert.ok(existsSync(join(dist, 'index.html')), 'vite build produced no dist/index.html')

  // 2. Serve dist (SPA fallback to index.html).
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    let file = join(dist, path === '/' ? 'index.html' : path)
    if (!existsSync(file)) file = join(dist, 'index.html')
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream')
    res.end(readFileSync(file))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${server.address().port}`

  const bin = findChromium()
  assert.ok(bin, 'No Chromium found (set CHROMIUM_BIN). This test MUST run a real browser — do not skip it.')
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ executablePath: bin })
  try {
    const seed = (flagOn) => async (ctx) => {
      await ctx.addInitScript((on) => {
        localStorage.setItem('spotme:app:v1', JSON.stringify({ profile: { id: 'deadbeef', name: 'Fence Probe', username: 'fence_probe' } }))
        // INVERSION (2026-08-08): exchange defaults ON; the off state is the
        // explicit literal 'off' — the rollback a real device would use.
        localStorage.setItem('spotme.ui.exchange', on ? 'on' : 'off')
      }, flagOn)
      // Hermetic: nothing may leave this machine.
      await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort())
    }

    // ---- FLAG ON: the island must actually mount from the built bundle.
    {
      const ctx = await browser.newContext()
      await seed(true)(ctx)
      const page = await ctx.newPage()
      const requested = []
      page.on('request', (r) => requested.push(r.url()))
      const errors = []
      page.on('pageerror', (e) => errors.push(String(e)))
      await page.goto(`${origin}/#/exchange`, { waitUntil: 'load' })
      await page.waitForSelector('section.x-screen', { timeout: 15000 })
      // The bar carries the Exchange tab on an opted-in device.
      await page.waitForSelector('.nv[data-path="#/exchange"]', { timeout: 5000 })
      assert.ok(requested.some((u) => /\/assets\/ui-.*\.js/.test(u)), 'flag on: the @spotme/ui chunk was never requested')
      assert.ok(requested.some((u) => /\/assets\/(react|client)-.*\.js/.test(u)), 'flag on: no React chunk was requested')
      const fatal = errors.filter((e) => /Failed to resolve module specifier|does not provide an export/.test(e))
      assert.deepStrictEqual(fatal, [], `browser resolution errors: ${fatal.join('; ')}`)
      await ctx.close()
      console.log('ok  flag on  — island mounted from built bundle; ui + react chunks resolved in-browser')
    }

    // ---- FLAG OFF: React must not even be requested.
    {
      const ctx = await browser.newContext()
      await seed(false)(ctx)
      const page = await ctx.newPage()
      const requested = []
      page.on('request', (r) => requested.push(r.url()))
      await page.goto(`${origin}/#/exchange`, { waitUntil: 'load' })
      await page.waitForSelector('.x-note', { timeout: 15000 })
      const reactish = requested.filter((u) => /\/assets\/(ui|react|client|jsx-runtime)-.*\.js/.test(u))
      assert.deepStrictEqual(reactish, [], `flag off: React/ui chunks were requested: ${reactish.join(', ')}`)
      // ...and the bar shows no Exchange tab: dark means invisible, too.
      assert.strictEqual(await page.$('.nv[data-path="#/exchange"]'), null, 'flag off: the Exchange tab leaked into the bar')
      await ctx.close()
      console.log('ok  flag off — no React/ui chunk requested; dark stays dark on the wire')
    }
  } finally {
    await browser.close()
    server.close()
  }
  console.log('exchange-island-browser: PASS')
}

main().catch((e) => { console.error(e); process.exit(1) })
