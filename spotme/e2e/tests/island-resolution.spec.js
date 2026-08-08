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
import { RUN_ID } from '../lib/accounts.js'

/* A SIGNED-OUT PAGE PROVES NOTHING. Without a profile the app renders
 * onboarding and never routes to a surface at all — so "the island did not
 * report an error" would pass on a screen that never tried to mount one.
 *
 * Seeding localStorage (the foundation fixture) is not enough here: that
 * fixture asserts about the STORED profile, while the app decides what to
 * render from its own local database. So this walks the real onboarding form,
 * exactly as a person would — the only path that leaves the app in a state
 * where a route actually renders a surface. */
let seq = 0
const onboard = async (browser, flagInit) => {
  const ctx = await browser.newContext()
  if (flagInit) await ctx.addInitScript(flagInit)
  const page = await ctx.newPage()
  await page.goto(BUILT)

  const user = `isl${String(RUN_ID).replace(/[^a-z0-9]/gi, '').slice(-6)}${seq++}`.toLowerCase()
  await page.getByPlaceholder('Your name').fill('Island Probe')
  await page.getByPlaceholder('username').fill(user)
  await page.locator('input[type="month"]').fill('1995-05')
  await page.getByRole('button', { name: /^Start$/ }).click()

  // Onboarding is done when the router has taken over.
  await page.waitForFunction(() => window.location.hash.length > 1, { timeout: 20_000 })
  return { ctx, page }
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
  test('flag OFF: no React reaches the browser at all', async ({ browser }) => {
    /* Since the 2026-08-08 default flip, sweep-passed surfaces default ON —
     * "off" is now the EXPLICIT off-switch. This asserts the switch still
     * strips React from the wire entirely: with every slice set to 'off',
     * not one React-carrying chunk may be fetched. */
    const ALL = ['profile', 'inbox', 'contacts', 'notifications', 'groups',
      'stories', 'moments', 'discovery', 'verify', 'exchange', 'chat']
    const offInit = `try { ${JSON.stringify(ALL)}.forEach((s) => localStorage.setItem('spotme.ui.' + s, 'off')) } catch (e) {}`
    const { ctx, page } = await onboard(browser, offInit)

    // Visit every surface with the flags off; none may pull React.
    for (const { hash } of SURFACES) {
      await page.goto(`${BUILT}/${hash}`)
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(800)
    }

    /* THE PAGE'S OWN RESOURCE TIMELINE, not Playwright request events. The
     * events only fire for listeners attached before the load, and a
     * re-navigation is served from cache — so counting them recorded zero and
     * the assertions below became vacuous. performance entries record every
     * resource the document actually loaded, cached or not. */
    const requested = await page.evaluate(() => performance
      .getEntriesByType('resource').map((r) => r.name).filter((n) => n.endsWith('.js')))

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
    test(`flag ON (${slice}): the island mounts, nothing fails to resolve`, async ({ browser }) => {
      /* The flag is seeded BEFORE the first document runs, so it is already on
       * when onboarding finishes and the router renders the surface. */
      const { ctx, page } = await onboard(browser,
        `try { localStorage.setItem('spotme.ui.${slice}', 'on') } catch (e) {}`)
      const errs = resolutionErrors(page)

      /* A REAL navigation, not a hash assignment: `#/chat` is already the hash
       * after onboarding, so setting it fires no hashchange and nothing
       * re-renders — the inbox case silently tested an unrendered screen. */
      await page.goto(`${BUILT}/${hash}`)
      await page.waitForLoadState('networkidle')

      /* POLLED, not slept. The islands take very different times to appear —
       * inbox alone imports db/discovery/reach/rooms/ui/api and builds a port
       * before it mounts — so any single fixed wait is either flaky or slow.
       * NON-VACUOUS: React must actually own DOM here. Without this the test
       * passes on any screen that never tried to mount, which is exactly how
       * the original breakage hid. */
      const hasReact = () => Array.from(document.querySelectorAll('*'))
        .some((el) => Object.keys(el).some((k) => k.startsWith('__reactFiber')))
      await page.waitForFunction(hasReact, { timeout: 30_000 })
        .catch(() => { /* asserted below, with a message that says what failed */ })

      const resolution = errs.filter(isResolutionFailure)
      expect(resolution, `browser could not resolve the island module:\n${resolution.join('\n')}`).toEqual([])

      const mounted = await page.evaluate(hasReact)
      expect(mounted, `${slice} did not mount React into the page`).toBe(true)

      /* The host's own failure text. Its presence means the mount threw —
       * which is exactly the state that shipped undetected. */
      const body = await page.evaluate(() => document.body.innerText)
      expect(body, `the island fell back to the "could not load" state for ${slice}`)
        .not.toMatch(/could not load/i)
      await ctx.close()
    })
  }

  test('flag ON pulls extra code that flag OFF never fetches', async ({ browser }) => {
    /* Compared, not name-matched. Chunk filenames are a build detail — hashed,
     * and named after whichever module Rollup made the entry — so asserting on
     * `client-*.js` pinned a local artefact and failed in CI while the app was
     * perfectly fine. What actually matters is the SHAPE: turning a flag on
     * must fetch JavaScript that turning it off does not. */
    /* Since the 2026-08-08 default flip, other surfaces default ON — a bare
     * baseline would fetch React for the inbox before exchange is even
     * visited, and the on-run would add nothing. Both runs therefore pin
     * EVERY slice off, and the on-run turns on exchange alone: the delta is
     * exchange's lazy chunk, which is the property this test exists for. */
    const ALL_OFF = "try { ['profile','inbox','contacts','notifications','groups','stories','moments','discovery','verify','exchange','chat'].forEach((s) => localStorage.setItem('spotme.ui.' + s, 'off')) } catch (e) {}"
    const jsFor = async (flagOn) => {
      const { ctx, page } = await onboard(browser,
        flagOn
          ? ALL_OFF + "; try { localStorage.setItem('spotme.ui.exchange', 'on') } catch (e) {}"
          : ALL_OFF)
      await page.goto(`${BUILT}/#/exchange`)
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(4000)
      // See the note above: the resource timeline, not request events.
      const urls = new Set(await page.evaluate(() => performance
        .getEntriesByType('resource').map((r) => r.name).filter((n) => n.endsWith('.js'))))
      await ctx.close()
      return urls
    }

    const off = await jsFor(false)
    const on = await jsFor(true)
    const extra = [...on].filter((u) => !off.has(u))

    expect(extra.length, 'flag ON must fetch JS that flag OFF does not — the lazy chunk').toBeGreaterThan(0)
    expect([...off].length, 'the baseline load must not be empty, or this proves nothing').toBeGreaterThan(0)
  })

  /* LEAVING a mounted island, in the SAME document. Everything above proves an
   * island arrives; this proves the one after it survives.
   *
   * Two views (inbox, groups) hand the router's SHARED view container straight
   * to mountIsland, so React's root owns the very element the router reuses for
   * every screen. The router's teardown order is: currentCleanup() — which
   * defers React's unmount by a microtask — then clear(container), then the
   * next view renders synchronously into it. The deferred unmount lands LAST
   * and clears its container, so it wipes the DOM the next view just wrote:
   * a blank screen, and a NotFoundError from removeChild on nodes React no
   * longer owns. With inbox defaulting ON since 2026-08-08 that teardown is on
   * the very first tab switch of a cold open.
   *
   * The destination is deliberately a LEGACY, synchronous screen: nothing about
   * this failure needs a second island, and a second async mount would only
   * blur which teardown did the damage. */
  test('leaving a mounted island does not wipe the next screen', async ({ browser }) => {
    const { ctx, page } = await onboard(browser)
    const errs = resolutionErrors(page)

    // Land on the inbox and let it really mount — the whole point is to tear
    // down a LIVE React root, not a mount that never happened.
    await page.goto(`${BUILT}/#/chat`)
    const hasReact = () => Array.from(document.querySelectorAll('*'))
      .some((el) => Object.keys(el).some((k) => k.startsWith('__reactFiber')))
    await page.waitForFunction(hasReact, { timeout: 30_000 })

    /* A hash assignment, NOT page.goto: a real navigation would build a fresh
     * document and the shared container would never be reused — which is the
     * exact bug. This is the in-app tab switch a person performs. */
    await page.evaluate(() => { window.location.hash = '#/bluetooth' })

    /* Polled from the TEST side, with page.evaluate. Not page.waitForFunction:
     * its poll runs on requestAnimationFrame inside the page, and a wiped
     * screen never paints again — the call then hangs past its own timeout and
     * the case dies of a generic test timeout instead of reporting the blank
     * screen it was written to catch. evaluate answers on a wiped page. */
    const readView = () => {
      const v = document.querySelector('.view')
      return { children: v ? v.childElementCount : -1, text: (v ? v.innerText : '').slice(0, 120) }
    }
    let view = { children: -1, text: '' }
    for (let i = 0; i < 24 && !view.text.includes('Bluetooth'); i++) {
      await page.waitForTimeout(250)
      view = await page.evaluate(readView)
    }
    expect(view.children, `the destination screen was emptied by the island it replaced (view text: ${JSON.stringify(view.text)})`)
      .toBeGreaterThan(0)
    expect(view.text, 'the legacy Bluetooth screen did not render after leaving the inbox island').toMatch(/Bluetooth/)

    const wipe = errs.filter((e) => /removeChild|not a child of this node/i.test(e))
    expect(wipe, `React tore DOM out of a container it no longer owns:\n${wipe.join('\n')}`).toEqual([])
    await ctx.close()
  })
})
