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
import { API, BUILT } from '../playwright.config.js'
import { account, signUp, seedSession } from '../lib/accounts.js'

/* A SIGNED-OUT PAGE PROVES NOTHING. Without a profile the app renders
 * onboarding and never routes to a surface at all — so "the island did not
 * report an error" would pass on a screen that never tried to mount one.
 * Every test here seeds a real session first, exactly as foundation.spec does. */
/* A distinct role per context: account() is deterministic in the role, so
 * reusing one would try to create the same account twice and fail on the
 * second signUp. */
let seq = 0
const signedIn = async (browser, request, extraInit) => {
  const role = `island${seq++}`
  const who = await signUp(request, API, role)
  const ctx = await browser.newContext()
  await seedSession(ctx, { ...account(role), ...who })
  if (extraInit) await ctx.addInitScript(extraInit)
  return ctx
}

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
  test('flag OFF: no React reaches the browser at all', async ({ browser, request }) => {
    const ctx = await signedIn(browser, request)
    const page = await ctx.newPage()
    const requested = []
    page.on('request', (r) => { if (r.url().endsWith('.js')) requested.push(r.url()) })

    await page.goto(BUILT)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1500)

    expect(requested.length, 'nothing loaded — the assertion below would be vacuous').toBeGreaterThan(0)

    /* BY CONTENT, not by filename. Chunk names are hashed build details; an
     * earlier version of this test matched `client-*.js` and would have passed
     * happily in any build that named its chunks differently — a fence that
     * cannot fail is not a fence. react-dom is ~190 kB, and never sending it
     * to the ~100% of users who have every flag off is the entire point of
     * the island architecture. */
    const withReact = await page.evaluate(async (urls) => {
      const hits = []
      for (const u of urls) {
        try {
          const body = await (await fetch(u)).text()
          if (/useSyncExternalStore|__CLIENT_INTERNALS_DO_NOT_USE|react-dom/.test(body)) hits.push(u)
        } catch { /* a chunk that will not fetch cannot be shipping React */ }
      }
      return hits
    }, requested)

    expect(withReact, `React shipped with every flag OFF:\n${withReact.join('\n')}`).toEqual([])
    await ctx.close()
  })

  for (const { slice, hash } of SURFACES) {
    test(`flag ON (${slice}): the island mounts, nothing fails to resolve`, async ({ browser, request }) => {
      /* Signed in, and the flag seeded BEFORE the first document runs, so
       * there is exactly one navigation. (Setting it via evaluate and then
       * navigating tore the execution context down mid-call.) */
      const ctx = await signedIn(browser, request, `try { localStorage.setItem('spotme.ui.${slice}', 'on') } catch (e) {}`)
      const page = await ctx.newPage()
      const errs = resolutionErrors(page)

      await page.goto(`${BUILT}/${hash}`)
      await page.waitForLoadState('networkidle')
      // The mount is async (dynamic import + createRoot); give it a beat.
      await page.waitForTimeout(2000)

      const resolution = errs.filter(isResolutionFailure)
      expect(resolution, `browser could not resolve the island module:\n${resolution.join('\n')}`).toEqual([])

      /* NON-VACUOUS: React must actually own DOM on this screen. Without this
       * the test passes on a signed-out onboarding page that never tried to
       * mount anything — which is exactly how the original breakage hid. */
      const mounted = await page.evaluate(() =>
        Array.from(document.querySelectorAll('*'))
          .some((el) => Object.keys(el).some((k) => k.startsWith('__reactFiber'))))
      expect(mounted, `${slice} did not mount React into the page`).toBe(true)

      /* The host's own failure text. Its presence means the mount threw —
       * which is exactly the state that shipped undetected. */
      const body = await page.evaluate(() => document.body.innerText)
      expect(body, `the island fell back to the "could not load" state for ${slice}`)
        .not.toMatch(/could not load/i)
      await ctx.close()
    })
  }

  test('flag ON pulls extra code that flag OFF never fetches', async ({ browser, request }) => {
    /* Compared, not name-matched. Chunk filenames are a build detail — hashed,
     * and named after whichever module Rollup made the entry — so asserting on
     * `client-*.js` pinned a local artefact and failed in CI while the app was
     * perfectly fine. What actually matters is the SHAPE: turning a flag on
     * must fetch JavaScript that turning it off does not. */
    const jsFor = async (flagOn) => {
      const ctx = await signedIn(browser, request,
        flagOn ? "try { localStorage.setItem('spotme.ui.exchange', 'on') } catch (e) {}" : null)
      const page = await ctx.newPage()
      const urls = new Set()
      page.on('request', (r) => { if (r.url().endsWith('.js')) urls.add(r.url()) })
      await page.goto(`${BUILT}/#/exchange`)
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(1500)
      await ctx.close()
      return urls
    }

    const off = await jsFor(false)
    const on = await jsFor(true)
    const extra = [...on].filter((u) => !off.has(u))

    expect(extra.length, 'flag ON must fetch JS that flag OFF does not — the lazy chunk').toBeGreaterThan(0)
    expect([...off].length, 'the baseline load must not be empty, or this proves nothing').toBeGreaterThan(0)
  })
})
