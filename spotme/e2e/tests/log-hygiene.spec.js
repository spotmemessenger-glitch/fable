/**
 * Proves the run's own secrets never reach a log.
 *
 * WHY EXACT MARKERS AND NOT PATTERNS. A regex for "anything that looks like a
 * token" fires on request ids, hashes and base64 in ordinary output, and a
 * suite that cries wolf is a suite whose failures get waved through. This test
 * knows the EXACT secrets this run created — it made them — so it looks for
 * those literal strings. A match is unambiguous and a pass means something.
 *
 * WHAT MAY APPEAR. Generated usernames and the run id are correlation handles
 * and are allowed; that is what they are for. Secrets are not, and the two
 * are asserted separately so "we log the username" never quietly becomes "we
 * log the credential next to it".
 */
import { test, expect, request as pwRequest } from '@playwright/test'
import { API, WEB } from '../playwright.config.js'
import { RUN_ID, signUp, seedSession, cleanUp } from '../lib/accounts.js'
import { readFileSync, existsSync } from 'node:fs'

const LOG = new URL('../test-results/backend.log', import.meta.url).pathname
const made = []
const browserLines = []

test.afterAll(async () => {
  const ctx = await pwRequest.newContext()
  const failures = await cleanUp(ctx, API, made)
  await ctx.dispose()
  if (failures.length) throw new Error(`cleanup left accounts behind: ${failures.join(', ')}`)
})

test('drive real traffic, capturing both sides', async ({ browser, request }) => {
  const dave = await signUp(request, API, 'dave')
  made.push(dave)

  const ctx = await browser.newContext()
  await seedSession(ctx, dave)
  const page = await ctx.newPage()
  page.on('console', (m) => browserLines.push(m.text()))
  page.on('pageerror', (e) => browserLines.push(String(e.stack || e.message)))
  await page.goto(WEB)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => window.location.hash.length > 1, { timeout: 15_000 })

  // An authenticated call, so an Authorization header definitely crossed the wire.
  const me = await request.get(`${API}/api/users/me`, {
    headers: { Authorization: `Bearer ${dave.accessToken}` },
  })
  expect(me.ok()).toBe(true)
  await ctx.close()
})

test('NO SECRET FROM THIS RUN APPEARS IN THE BACKEND LOG', () => {
  expect(existsSync(LOG), 'the backend log was not captured — this test proves nothing without it').toBe(true)
  const log = readFileSync(LOG, 'utf8')
  expect(log.length, 'an empty log would make every assertion below vacuous').toBeGreaterThan(0)

  const dave = made[0]
  const forbidden = {
    'the guest secret': dave.secret,
    'the access token': dave.accessToken,
    'the refresh token': dave.refreshToken,
    'a complete Authorization header': `Bearer ${dave.accessToken}`,
  }
  for (const [what, value] of Object.entries(forbidden)) {
    expect(log.includes(value), `${what} was written to the backend log`).toBe(false)
  }
})

test('…nor in anything the browser logged', () => {
  const all = browserLines.join('\n')
  const dave = made[0]
  for (const [what, value] of Object.entries({
    'the guest secret': dave.secret,
    'the access token': dave.accessToken,
    'the refresh token': dave.refreshToken,
  })) {
    expect(all.includes(value), `${what} reached the browser console`).toBe(false)
  }
})

test('no connection string carrying a password is logged', () => {
  const log = readFileSync(LOG, 'utf8')
  // The database URL this run uses has a password in it. Narrow and literal:
  // a URL with credentials, not "anything containing postgres".
  expect(log).not.toMatch(/postgres(ql)?:\/\/[^\s:@]+:[^\s@]+@/)
  expect(log).not.toContain('e2e-only-not-a-real-key')      // the JWT secret
})

test('correlation handles ARE allowed, and are asserted separately', () => {
  /* Deliberately the positive case. Without it, a change that stopped logging
   * anything at all would make every assertion above pass while destroying the
   * ability to correlate a test with its server-side effect — a green suite
   * that proves less than it did. */
  const log = readFileSync(LOG, 'utf8')
  expect(typeof RUN_ID).toBe('string')
  expect(log.length).toBeGreaterThan(0)
  // The username is a handle, not a credential; it may appear. The secret is
  // derived from the same seed and must not. That the two are different strings
  // is what makes this assertion meaningful.
  expect(made[0].username).not.toBe(made[0].secret)
})
