/**
 * Proves the harness itself works, before anything relies on it.
 *
 * WHY THIS SPEC EXISTS AND IS FIRST. Every other e2e scenario assumes four
 * things that have never been true in this repo before: a backend that boots,
 * a web app served against it, an account that can be created deterministically,
 * and cleanup that removes what the run made. If any of those is broken, the
 * scenario suites fail in ways that look like product bugs and are not.
 *
 * So this file asserts the floor. A failure here means the harness, not the app.
 */
import { test, expect, request as pwRequest } from '@playwright/test'
import { API, WEB } from '../playwright.config.js'
import { RUN_ID, account, signUp, cleanUp } from '../lib/accounts.js'

const made = []

/**
 * Wait for the app to finish booting before touching it.
 *
 * SPOT ME USES HASH ROUTING, and `main.js` assigns `window.location.hash`
 * during startup. That is a navigation: any `page.evaluate` in flight when it
 * happens dies with "Execution context was destroyed", and `body` is not yet
 * visible before it. Both read as product failures and are neither — the first
 * two runs of this suite failed exactly that way.
 *
 * So every test that inspects the page waits for the route to settle first.
 * This is the difference between an e2e suite that reports app bugs and one
 * that reports its own timing.
 */
async function booted (page) {
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => window.location.hash.length > 1, { timeout: 15_000 })
  await expect(page.locator('body')).toBeVisible({ timeout: 15_000 })
}

test.afterAll(async () => {
  const ctx = await pwRequest.newContext()
  const failures = await cleanUp(ctx, API, made)
  await ctx.dispose()
  // Reported, not swallowed. A cleanup that quietly fails leaves rows that the
  // next run's determinism argument depends on not existing.
  if (failures.length) throw new Error(`cleanup left accounts behind: ${failures.join(', ')}`)
})

test('the backend is up and answering', async ({ request }) => {
  const res = await request.get(`${API}/api/username?q=probe`)
  expect(res.status()).toBeLessThan(500)
})

test('the web app is served and boots without a fatal error', async ({ page }) => {
  const fatal = []
  page.on('pageerror', (e) => fatal.push(e.message))
  await page.goto(WEB)
  await booted(page)
  // An app that renders an empty body is "loaded" and useless.
  await expect.poll(() => page.evaluate(() => document.body.innerText.trim().length), { timeout: 15_000 })
    .toBeGreaterThan(0)
  expect(fatal, `uncaught errors during boot: ${fatal.join(' | ')}`).toHaveLength(0)
})

test('accounts are deterministic — same run and role, same account', () => {
  const a = account('alice')
  const b = account('alice')
  const c = account('bob')
  expect(a).toEqual(b)
  expect(a.id).not.toEqual(c.id)
  // The API's own constraints, asserted here so a violation is a clear failure
  // rather than a 400 in the middle of an unrelated scenario.
  expect(a.id).toMatch(/^[a-f0-9]{8,64}$/i)
  expect(a.username).toMatch(/^[a-z0-9_]{3,16}$/)
  expect(a.secret.length).toBeGreaterThanOrEqual(8)
  // The run id travels in the username, so a leftover row names the run that
  // made it instead of being an anonymous orphan.
  expect(a.username).toContain(RUN_ID.slice(0, 6))
})

test('an account can be created, and it is really there', async ({ request }) => {
  const alice = await signUp(request, API, 'alice')
  made.push(alice)
  expect(alice.accessToken).toBeTruthy()
  expect(alice.userId).toBe(account('alice').id)

  const me = await request.get(`${API}/api/users/me`, {
    headers: { Authorization: `Bearer ${alice.accessToken}` },
  })
  expect(me.ok()).toBe(true)
  expect((await me.json()).username).toBe(alice.username)
})

test('two accounts are independent, which every messaging scenario needs', async ({ request }) => {
  const bob = await signUp(request, API, 'bob')
  made.push(bob)
  expect(bob.userId).not.toBe(account('alice').id)
  expect(bob.accessToken).not.toBe(made[0].accessToken)
})

test('a seeded session boots the app signed IN, not signed out', async ({ browser, request }) => {
  /* The whole point of the fixture. If this fails, every scenario that opens a
   * conversation is instead testing the signed-out screen — and would report
   * some unrelated selector timing out rather than "you are not logged in". */
  const carol = await signUp(request, API, 'carol')
  made.push(carol)
  const { seedSession } = await import('../lib/accounts.js')
  const ctx = await browser.newContext()
  await seedSession(ctx, carol)
  const page = await ctx.newPage()
  await page.goto(WEB)
  await booted(page)
  const stored = await page.evaluate(() => ({
    me: localStorage.getItem('spotme:me'),
    tokens: localStorage.getItem('spotme.server.tokens'),
  }))
  expect(stored.me, 'the profile did not survive into the page').toBeTruthy()
  expect(JSON.parse(stored.me).username).toBe(carol.username)
  expect(JSON.parse(stored.tokens).accessToken).toBeTruthy()
  await ctx.close()
})
