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
// The three identity stores, so NEW-4 can open a live connection to each BEFORE
// the wipe — the precondition that made the app block its own delete.
const { allRecords, _resetForTests: _resetPinStore } = await import('../src/lib/crypto/identity-pin-store.js')
const { loadIdentity, forgetIdentity } = await import('../src/lib/crypto/identity-store.js')
const { loadSigningIdentity, forgetSigningIdentity } = await import('../src/lib/crypto/signing-key-store.js')

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} — threw ${e.message}`] = false }
}
/** The async sibling. `wipeDevice` now answers whether the wipe actually
 *  worked, and that answer can only arrive after the IndexedDB deletes do. */
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[`${name} — threw ${e.message}`] = false }
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

/* ============ a wipe that did NOT work must not claim it did ============== */

await checkAsync('a wipe reports ok when every store WAS actually cleared', async () => {
  // The fake has to serve `open` too, or the media store genuinely cannot be
  // cleared and is correctly reported as a failure — which would make this
  // assertion pass for the wrong reason if it only looked at the databases.
  globalThis.indexedDB = {
    deleteDatabase: () => { const req = {}; queueMicrotask(() => req.onsuccess?.()); return req },
    open: () => {
      const req = { result: {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({}),
        transaction: () => {
          const t = { objectStore: () => ({ clear: () => ({}) }) }
          queueMicrotask(() => t.oncomplete?.())
          return t
        }
      } }
      queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.() })
      return req
    }
  }
  const out = await wipeDevice()
  return out.ok === true && out.failures.length === 0
})

await checkAsync('ALL THREE identity databases are deleted — e2e, pins, and SIGNING (ADR-008 §5)', async () => {
  const deleted = []
  globalThis.indexedDB = {
    deleteDatabase: (name) => { deleted.push(name); const req = {}; queueMicrotask(() => req.onsuccess?.()); return req },
    open: () => {
      const req = { result: {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({}),
        transaction: () => {
          const t = { objectStore: () => ({ clear: () => ({}) }) }
          queueMicrotask(() => t.oncomplete?.())
          return t
        }
      } }
      queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.() })
      return req
    }
  }
  await wipeDevice()
  return ['spotme-e2e', 'spotme-identity-pins', 'spotme-signing'].every((d) => deleted.includes(d))
})

await checkAsync('…and a signing database that cannot be deleted is a reported failure', async () => {
  globalThis.indexedDB = {
    deleteDatabase: (name) => {
      const req = {}
      queueMicrotask(() => (name === 'spotme-signing' ? req.onblocked?.() : req.onsuccess?.()))
      return req
    },
    open: () => {
      const req = { result: {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({}),
        transaction: () => {
          const t = { objectStore: () => ({ clear: () => ({}) }) }
          queueMicrotask(() => t.oncomplete?.())
          return t
        }
      } }
      queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.() })
      return req
    }
  }
  const out = await wipeDevice()
  return out.ok === false && out.failures.includes('spotme-signing')
})

await checkAsync('THE POINT: a BLOCKED database delete is reported, not swallowed', async () => {
  /* The realistic failure, and the one a synchronous try/catch cannot see:
   * `deleteDatabase` returns a REQUEST. Another tab still holding the database
   * open fires `onblocked` and the delete simply never happens. Before this,
   * "Clear all data" reloaded into a screen claiming the device was clean while
   * the data was still on disk — telling someone their data is gone when it is
   * not is the one outcome this button must never produce. */
  globalThis.indexedDB = {
    deleteDatabase: (name) => {
      const req = {}
      queueMicrotask(() => (name === 'spotme-identity-pins' ? req.onblocked?.() : req.onsuccess?.()))
      return req
    }
  }
  const out = await wipeDevice()
  return out.ok === false && out.failures.includes('spotme-identity-pins')
})

await checkAsync('an ERRORING database delete is reported too', async () => {
  globalThis.indexedDB = {
    deleteDatabase: (name) => {
      const req = {}
      queueMicrotask(() => (name === 'spotme-e2e' ? req.onerror?.() : req.onsuccess?.()))
      return req
    }
  }
  const out = await wipeDevice()
  return out.ok === false && out.failures.includes('spotme-e2e')
})

await checkAsync('one failing store does not hide the others — all failures are listed', async () => {
  globalThis.indexedDB = {
    deleteDatabase: () => { const req = {}; queueMicrotask(() => req.onerror?.()); return req }
  }
  const out = await wipeDevice()
  return out.ok === false &&
    out.failures.includes('spotme-e2e') && out.failures.includes('spotme-identity-pins')
})

await checkAsync('no IndexedDB at all is a reported failure, not a silent success', async () => {
  globalThis.indexedDB = { deleteDatabase: () => { throw new Error('private mode') } }
  const out = await wipeDevice()
  return out.ok === false && out.failures.length >= 2
})

/* ====== NEW-4: a live store connection must not block its own wipe ======== */

await checkAsync('NEW-4: still-open store connections close on versionchange, so wipeDevice is not self-blocked', async () => {
  /* IndexedDB `deleteDatabase` fires `versionchange` at EVERY open connection
   * and blocks until they close. The three identity stores each hold a live
   * connection (identity-pin-store caches its at module level for the module's
   * lifetime); before the fix none set `db.onversionchange`, so the app blocked
   * its OWN deletes and db.js reported the block (`onblocked`) as a wipe failure.
   *
   * helpers/fake-idb.js deliberately does NOT model version-change blocking, so
   * this mock does it explicitly: a connection that IGNORES `versionchange`
   * stays in `live`, and its database's delete fires `onblocked` (a failure); a
   * connection that closes on notice drops out of `live` and the delete
   * succeeds. So this passes ONLY because the fix closes each connection. */
  const live = new Set()
  const deleted = []
  const mkReq = (result) => { const r = {}; queueMicrotask(() => { r.result = result; r.onsuccess?.() }); return r }
  // A readable record so identity-store / signing-key-store take their "found"
  // branch and do NOT generate a key — the test is about the OPEN handle only.
  const readable = { algo: 'X25519', privateKey: {}, publicKey: {}, publicKeyB64: 'AA', schemaVersion: 1 }
  globalThis.indexedDB = {
    open: (name) => {
      const conn = {
        name,
        onversionchange: null,
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({}),
        close () { live.delete(conn) },
        transaction: () => {
          const store = {
            get: () => mkReq(readable),
            getAll: () => mkReq([]),
            put: () => mkReq(undefined),
            delete: () => mkReq(undefined),
            clear: () => ({}),
          }
          const t = { objectStore: () => store }
          // oncomplete AFTER any request microtasks queued this tick.
          queueMicrotask(() => queueMicrotask(() => t.oncomplete?.()))
          return t
        },
      }
      live.add(conn)
      const req = { result: conn }
      queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.() })
      return req
    },
    deleteDatabase: (name) => {
      const req = {}
      queueMicrotask(() => {
        // Notify every open connection to this database, then see who is left.
        for (const conn of [...live]) if (conn.name === name) conn.onversionchange?.({ type: 'versionchange' })
        if ([...live].some((conn) => conn.name === name)) { req.onblocked?.(); return } // still blocked
        deleted.push(name)
        req.onsuccess?.()
      })
      return req
    },
  }

  // Simulate normal app use having already opened all three identity stores, so
  // each holds a live connection when the wipe runs.
  _resetPinStore(); forgetIdentity(); forgetSigningIdentity()
  await allRecords()            // opens + module-caches spotme-identity-pins
  await loadIdentity()          // opens spotme-e2e
  await loadSigningIdentity()   // opens spotme-signing

  const out = await wipeDevice()
  return out.ok === true &&
    ['spotme-e2e', 'spotme-identity-pins', 'spotme-signing'].every((d) => deleted.includes(d))
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
