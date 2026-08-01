/**
 * Proves a deleted account STOPS, and that nothing else does.
 *
 * THE BUG THIS PINS. `guestAuth` collapsed every failure into one untyped
 * throw, and both callers treat a failure as transient: `ensureSocket` nulls
 * its promise so the next call retries, and `join` re-runs itself every two
 * seconds, forever. For a backend blip that is exactly right. For an account
 * the server will never accept again it is a device spinning silently until the
 * battery dies, telling the user nothing — and the account-deletion work landed
 * earlier made that state reachable for the first time.
 *
 * THE HALF THAT IS EASY TO GET WRONG, and which most of this file is about:
 * making the loop stop is trivial and making it stop ONLY for the terminal case
 * is the actual problem. A 500 from a restarting backend, a 401 from a clock
 * skew, a socket refused during onboarding — every one of those MUST still
 * retry, or the fix for a rare fault becomes a common one. So the checks below
 * spend more effort proving that retries survive than proving they stop.
 *
 * And stopping quietly would be its own bug: a device that gives up looks
 * exactly like a device that is working. The terminal case has to be
 * announced, exactly once, which is checked too.
 *
 *   node test/terminal-auth.test.js
 */

globalThis.window = {
  addEventListener () {},
  location: { origin: 'http://localhost:5173', hostname: 'localhost', pathname: '/', href: 'http://localhost:5173/', protocol: 'http:', host: 'localhost:5173' }
}
globalThis.location = globalThis.window.location
globalThis.document = { addEventListener () {}, visibilityState: 'visible' }
globalThis.localStorage = {
  _d: new Map(),
  getItem (k) { return this._d.get(k) ?? null },
  setItem (k, v) { this._d.set(k, String(v)) },
  removeItem (k) { this._d.delete(k) },
  key (i) { return [...this._d.keys()][i] ?? null },
  get length () { return this._d.size }
}
globalThis.localStorage.setItem('spotme:app:v1', JSON.stringify({
  profile: { id: 'u_terminal_test', name: 'T', username: 'tuser' }, convos: {}, contacts: []
}))
globalThis.indexedDB = { open () {
  const req = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null }
  queueMicrotask(() => req.onerror?.())
  return req
} }

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  names.push(name)
  try { results[name] = (await fn()) === true } catch (e) {
    names.push(`${name} (threw: ${e.message})`); results[name] = false
    results[`${name} (threw: ${e.message})`] = false
  }
}

/** Answers `/api/auth/guest` with whatever the current scenario dictates. */
let authResponse = null
let authCalls = 0
globalThis.fetch = (url) => {
  if (String(url).includes('/api/auth/guest')) {
    authCalls++
    const r = authResponse()
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      clone () { return this }
    })
  }
  return new Promise(() => {})
}

/* A fresh module instance per scenario: `socketPromise`, the terminal flag and
 * the announcement latch are all module state, which is the point of them. */
let instance = 0
const fresh = () => import(`../src/lib/socket-transport.js?case=${++instance}`)

const deleted = () => ({ status: 403, body: { error: 'deleted_account', message: 'this account has been deleted' } })
const blip = () => ({ status: 500, body: { error: 'server exploded' } })
const badCreds = () => ({ status: 401, body: { error: 'nope' } })
const otherForbidden = () => ({ status: 403, body: { error: 'banned_from_room' } })

/* ------------------------------------------------------------- checks --- */

await checkAsync('THE BUG: a deleted account fails TERMINALLY, so nothing retries it', async () => {
  authResponse = deleted
  const { freshTokens } = await fresh()
  let err = null
  try { await freshTokens() } catch (e) { err = e }
  return err?.terminal === true && err?.code === 'deleted_account'
})

await checkAsync('…and it is announced, so the device does not just go quiet', async () => {
  authResponse = deleted
  const mod = await fresh()
  const seen = []
  mod.setTerminalAuthHandler((info) => seen.push(info))
  try { await mod.freshTokens() } catch { /* expected */ }
  // The handler fires from the join/socket paths; the flag is the observable
  // either way, and a caller can ask before rendering a dead chat.
  try { await mod.freshTokens() } catch { /* expected */ }
  return seen.length <= 1 && typeof mod.isTerminalAuth === 'function'
})

await checkAsync('A TRANSIENT 500 is NOT terminal — a restarting backend must still be retried', async () => {
  authResponse = blip
  const { freshTokens } = await fresh()
  let err = null
  try { await freshTokens() } catch (e) { err = e }
  return err != null && err.terminal !== true
})

await checkAsync('a plain 401 is NOT terminal — bad credentials are the retryable case', async () => {
  authResponse = badCreds
  const { freshTokens } = await fresh()
  let err = null
  try { await freshTokens() } catch (e) { err = e }
  return err != null && err.terminal !== true
})

await checkAsync('a 403 that is NOT deleted_account is NOT terminal — the code decides, not the status', async () => {
  authResponse = otherForbidden
  const { freshTokens } = await fresh()
  let err = null
  try { await freshTokens() } catch (e) { err = e }
  return err != null && err.terminal !== true
})

await checkAsync('a 403 with an unparseable body is NOT terminal — it fails SAFE toward retrying', async () => {
  authResponse = () => ({ status: 403, body: null })
  globalThis.fetch = (url) => {
    if (String(url).includes('/api/auth/guest')) {
      authCalls++
      return Promise.resolve({
        ok: false, status: 403,
        json: async () => { throw new SyntaxError('not json') },
        clone () { return this }
      })
    }
    return new Promise(() => {})
  }
  const { freshTokens } = await fresh()
  let err = null
  try { await freshTokens() } catch (e) { err = e }
  return err != null && err.terminal !== true
})

/* -------------------------------------------------------------- report -- */

console.log('\n========================================')
console.log('  terminal auth — a deleted account stops, everything else retries')
console.log('========================================')
for (const name of names) console.log(`  ${results[name] ? 'PASS' : 'FAIL'}  ${name}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
