/**
 * "Clear all data" has to actually clear all data.
 *
 * It did not. The filter matched `spotme:` — a COLON — and the server transport
 * names its keys with a DOT: `spotme.server.tokens` and
 * `spotme.cursor.<profileId>.<roomId>` (socket-transport.js:37,43). So after a
 * wipe the device still held a working access token AND refresh token: it could
 * authenticate to the backend as the identity the user had just erased. It also
 * kept the replay cursors, which name every room the user took part in and how
 * far they had read — a map of the conversations, surviving the erase of the
 * conversations.
 *
 * Also asserted here, because it is the same promise: the translation cache is
 * keyed BY the original message text, so it is message content and it goes too.
 *
 * The multi-identity property is asserted in both directions. A wipe that also
 * clears the OTHER `?id=` slot breaks two-identity testing; a wipe that spares
 * the current slot's own keys is not a wipe.
 *
 *   node test/wipe-device.test.js
 */

/* --------------------------------------------------------- browser shim */
globalThis.location = { hostname: 'localhost', href: 'http://localhost/?id=wipetest' }
globalThis.window = { location: globalThis.location }
const mem = new Map()
globalThis.localStorage = {
  get length () { return mem.size },
  key: (i) => Array.from(mem.keys())[i] ?? null,
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
}

const { db, wipeDevice } = await import('../src/lib/db.js')

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} — threw ${e.message}`] = false }
}

/* This slot is `?id=wipetest`, so its own keys carry that suffix. */
const ME = 'aabbccdd11223344'
db.setProfile({ id: ME, name: 'Test', lang: 'en' })

function seed () {
  mem.clear()
  db.setProfile({ id: ME, name: 'Test', lang: 'en' })   // rewrites spotme:app:v1:wipetest
  const rows = {
    'spotme:me': ME,
    'spotme:demo-seeded': '1',
    'spotme:room:wipetest:deadbeef': '{"messages":[]}',
    'spotme:tcache:v3': '[["auto|ta|meet me at 9 behind the old bank",{"text":"…"}]]',
    'spotme.server.tokens': '{"accessToken":"eyJ...","refreshToken":"r_...","userId":"u1"}',
    [`spotme.cursor.${ME}.deadbeef`]: '412',
    [`spotme.cursor.${ME}.cafebabe`]: '7',
    'spotme.transport': 'p2p',
    // Another browser tab's identity — `?id=other`. Must survive.
    'spotme:app:v1:other': '{"profile":{"id":"9999"}}',
    'spotme:room:other:deadbeef': '{"messages":[]}',
    'spotme.cursor.9999.deadbeef': '55',
    // Nothing to do with us.
    'theme': 'dark'
  }
  for (const [k, v] of Object.entries(rows)) localStorage.setItem(k, v)
}

const gone = (k) => localStorage.getItem(k) === null
const kept = (k) => localStorage.getItem(k) !== null

/* 1 — the finding. */
seed(); wipeDevice()

check('THE BUG: server auth tokens no longer survive a wipe', () =>
  gone('spotme.server.tokens'))

check('THE BUG: this identity\'s replay cursors are erased', () =>
  gone(`spotme.cursor.${ME}.deadbeef`) && gone(`spotme.cursor.${ME}.cafebabe`))

check('translated message text is erased with the messages', () =>
  gone('spotme:tcache:v3'))

/* 2 — what it always did right, and must keep doing. */
check('the app record, profile and room store still go', () =>
  gone('spotme:app:v1:wipetest') && gone('spotme:me') &&
  gone('spotme:demo-seeded') && gone('spotme:room:wipetest:deadbeef'))

check('THE REGRESSION GUARD: the other ?id= slot is untouched', () =>
  kept('spotme:app:v1:other') && kept('spotme:room:other:deadbeef') &&
  kept('spotme.cursor.9999.deadbeef'))

check('keys belonging to other apps are left alone', () => kept('theme'))

check('the transport opt-out is a setting, not data, and stays', () =>
  kept('spotme.transport'))

/* 3 — a wipe with no identity must delete more, not less: without a profile id
 *     there is no way to tell this slot's cursors from anyone else's, and
 *     leaving them all behind is the failure this test exists to prevent. */
mem.clear()
localStorage.setItem('spotme.server.tokens', '{"accessToken":"eyJ..."}')
localStorage.setItem('spotme.cursor.someoneelse.deadbeef', '9')
const { wipeDevice: wipeAgain } = await import('../src/lib/db.js')
db.setProfile({ id: ME, name: 'Test', lang: 'en' })
localStorage.removeItem('spotme:app:v1:wipetest')
wipeAgain()
check('tokens go even when the profile record is already gone', () =>
  gone('spotme.server.tokens'))

/* 4 — idempotent: running it twice must not throw on an empty store. */
check('wiping an already-empty store is a no-op, not an error', () => {
  mem.clear(); wipeDevice(); wipeDevice()
  return mem.size === 0
})

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  wipeDevice — clear all data')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
