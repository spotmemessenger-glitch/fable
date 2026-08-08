/**
 * THE GAP THIS SUITE EXISTS FOR.
 *
 * Every Node suite passed — flag parity, boundaries, typecheck, 60+ web tests —
 * while all nine `packages/ui` surfaces were dead in a real browser. The island
 * host imported an assembled specifier, `['@spotme','ui'].join('/')`, marked
 * `@vite-ignore` so the bundler would leave it alone. Nothing in the tree could
 * see the problem: Node never performs browser module resolution, and `vite
 * dev` resolves bare specifiers itself. The browser could not, so every flag
 * flip silently fell back to legacy.
 *
 * So this runs against the BUILT bundle (`vite preview`, the artefact Vercel
 * serves) and asserts what only a browser can answer:
 *
 *   1. flag OFF  -> the React chunk is never requested (the lazy property)
 *   2. flag ON   -> the island mounts, and no module-resolution error fires
 *
 * Any regression to a non-resolvable specifier fails (2). Any regression to a
 * static import fails (1).
 */
import { test, expect } from '@playwright/test'
import { BUILT } from '../playwright.config.js'

const SURFACES = [
  { slice: 'exchange', hash: '#/exchange' },
  { slice: 'contacts', hash: '#/contacts' },
  { slice: 'groups', hash: '#/groups' },
  { slice: 'inbox', hash: '#/chat' },
]

const resolutionErrors = (page) => {
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
  return errs
}

const isResolutionFailure = (s) =>
  /Failed to resolve module specifier|Failed to fetch dynamically imported module|Cannot find module/i.test(s)

test.describe('island module resolution — against the BUILT bundle', () => {
  test('flag OFF: the React chunk is never requested', async ({ page }) => {
    const requested = []
    page.on('request', (r) => requested.push(r.url()))

    await page.goto(BUILT)
    await page.waitForLoadState('networkidle')

    /* react-dom is ~190 kB; downloading it for a user who has every flag off
     * is the cost this architecture exists to avoid. */
    const reactChunks = requested.filter((u) => /\/assets\/(client|ui)-[A-Za-z0-9_-]+\.js/.test(u))
    expect(reactChunks, `React chunks must not load with all flags off:\n${reactChunks.join('\n')}`).toEqual([])
  })

  for (const { slice, hash } of SURFACES) {
    test(`flag ON (${slice}): the island mounts, nothing fails to resolve`, async ({ page }) => {
      const errs = resolutionErrors(page)

      /* The flag is seeded BEFORE the first document runs, so there is exactly
       * one navigation per test. Setting it via evaluate and then navigating
       * tore the execution context down mid-call — a flake in the test, not in
       * the app. Each test gets a fresh context, so no cleanup is needed. */
      await page.addInitScript((s) => {
        try { localStorage.setItem(`spotme.ui.${s}`, 'on') } catch { /* private mode: the app defaults off */ }
      }, slice)
      await page.goto(`${BUILT}/${hash}`)
      await page.waitForLoadState('networkidle')
      // The mount is async (dynamic import + createRoot); give it a beat.
      await page.waitForTimeout(1500)

      const resolution = errs.filter(isResolutionFailure)
      expect(resolution, `browser could not resolve the island module:\n${resolution.join('\n')}`).toEqual([])

      /* The host's own failure text. Its presence means the mount threw —
       * which is exactly the state that shipped undetected. */
      const body = await page.evaluate(() => document.body.innerText)
      expect(body, `the island fell back to the "could not load" state for ${slice}`)
        .not.toMatch(/could not load/i)
    })
  }

  test('flag ON pulls the React chunk (the lazy load actually happens)', async ({ page }) => {
    const requested = []
    page.on('request', (r) => requested.push(r.url()))

    await page.addInitScript(() => {
      try { localStorage.setItem('spotme.ui.exchange', 'on') } catch { /* see above */ }
    })
    await page.goto(`${BUILT}/#/exchange`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1500)

    const reactChunks = requested.filter((u) => /\/assets\/(client|ui)-[A-Za-z0-9_-]+\.js/.test(u))
    expect(reactChunks.length, 'the React chunk should load once a flag is on').toBeGreaterThan(0)
  })
})
