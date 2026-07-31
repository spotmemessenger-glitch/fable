/**
 * Proves a device that cannot hold its encryption key can SAY SO.
 *
 * THE GAP THIS PINS. `loadIdentity` has reported `persisted` honestly since the
 * @vijay22 hotfix, and `publishIdentity` refuses to republish when it is false —
 * both correct, and both invisible. The only outward sign was `console.warn`,
 * which on a phone is nowhere at all: the handset that took down every chat it
 * was in looked perfectly healthy on its own screen, and reading the truth off
 * it required a Mac, a cable and Safari's remote inspector. Meanwhile the chat
 * kept printing "Encrypted with keys made on your devices" — true about this
 * device, and the exact opposite of what the user needed to know, because the
 * PEER could not match the key.
 *
 * So `identityStatus()` exists to be rendered. The risk it introduces is the
 * reason for most of the checks below: a status that cries wolf on healthy
 * devices is worse than no status, and there is one specific way to get it
 * wrong. `persisted` is set ONLY on a freshly generated identity — an identity
 * LOADED from IndexedDB carries no such field, so it reads `undefined`. A
 * truthiness test would therefore report "cannot save its key" on every device
 * that has been used before, i.e. almost all of them. `publishIdentity` already
 * tests `=== false` for this reason; the final checks assert the two agree,
 * because the day they disagree is the day the banner lies in one direction or
 * the other.
 *
 * Everything runs offline on Node's own WebCrypto. `indexedDB` and `fetch` are
 * faked; the crypto is real.
 *
 *   node test/identity-status.test.js
 */

/* ------------------------------------------------------------ harness ---- */

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  names.push(name)
  try { results[name] = (await fn()) === true } catch (e) {
    names.push(`${name} (threw: ${e.message})`)
    results[name] = false
    results[`${name} (threw: ${e.message})`] = false
  }
}

/**
 * An IndexedDB whose behaviour is chosen per scenario.
 *
 *   seed      an identity already in the store, as a returning device has
 *   lossy     `put` accepts and drops it — Safari's failure, the one that
 *             matters, and the reason the write is verified by reading back
 *   failOpen  `open()` errors, which is private browsing
 */
function fakeIndexedDB ({ seed = null, lossy = false, failOpen = false } = {}) {
  const stores = new Map([['identity', new Map(seed ? [['self', seed]] : [])]])
  const db = {
    createObjectStore (name) { if (!stores.has(name)) stores.set(name, new Map()); return {} },
    transaction (name) {
      const t = { oncomplete: null, onerror: null, onabort: null }
      t.objectStore = () => {
        const m = stores.get(name) || new Map()
        return {
          get: (k) => ({ result: m.get(k) }),
          put: (v, k) => { if (!lossy) m.set(k, v); return {} }
        }
      }
      queueMicrotask(() => t.oncomplete?.())
      return t
    }
  }
  return {
    open () {
      const req = { result: db, error: new Error('refused'), onupgradeneeded: null, onsuccess: null, onerror: null }
      queueMicrotask(() => {
        if (failOpen) { req.onerror?.(); return }
        req.onupgradeneeded?.()
        req.onsuccess?.()
      })
      return req
    }
  }
}

/* `identity-store.js` keeps `cached` and `openFailed` at module scope, which is
 * the whole point — the status has to outlive one call. So each scenario needs
 * its own instance of the module, and a query string is what gets ESM to hand
 * one over instead of the cached copy. */
let instance = 0
const freshStore = () => import(`../src/lib/crypto/identity-store.js?case=${++instance}`)

const { generateIdentity, exportPublicKeyB64 } = await import('../src/lib/crypto/e2e-v2.js')

/** A token whose payload carries `sub`, which is where publishIdentity reads our id. */
const tokenFor = (sub) =>
  `x.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.y`

/* -------------------------------------------------------------- checks --- */

await checkAsync('before anything asks, the status is unknown — not a fault', async () => {
  globalThis.indexedDB = fakeIndexedDB()
  const { identityStatus } = await freshStore()
  return identityStatus() === 'unknown'
})

await checkAsync('a device that CAN keep its key reports ok', async () => {
  globalThis.indexedDB = fakeIndexedDB()
  const { loadIdentity, identityStatus } = await freshStore()
  const id = await loadIdentity()
  return Boolean(id?.privateKey) && identityStatus() === 'ok'
})

await checkAsync('THE BUG: a write that does not stick reports ephemeral', async () => {
  globalThis.indexedDB = fakeIndexedDB({ lossy: true })
  const { loadIdentity, identityStatus } = await freshStore()
  await loadIdentity()
  return identityStatus() === 'ephemeral'
})

await checkAsync('…and the identity still works in memory, so the session is not dead', async () => {
  globalThis.indexedDB = fakeIndexedDB({ lossy: true })
  const { loadIdentity, identityStatus } = await freshStore()
  const id = await loadIdentity()
  // It can still send; nobody can read it. That is exactly what the UI must say.
  return Boolean(id?.privateKey) && id.persisted === false && identityStatus() === 'ephemeral'
})

await checkAsync('IndexedDB that will not open at all reports unavailable', async () => {
  globalThis.indexedDB = fakeIndexedDB({ failOpen: true })
  const { loadIdentity, identityStatus } = await freshStore()
  const id = await loadIdentity()
  return id === null && identityStatus() === 'unavailable'
})

await checkAsync('unavailable is DISTINCT from unknown — one is a fault, one is silence', async () => {
  globalThis.indexedDB = fakeIndexedDB({ failOpen: true })
  const { identityStatus, loadIdentity } = await freshStore()
  const before = identityStatus()
  await loadIdentity()
  return before === 'unknown' && identityStatus() === 'unavailable'
})

/* The cry-wolf guard. A returning device loads a record that has no `persisted`
 * field at all, so it reads `undefined`. Anything looser than `=== false` turns
 * this into a permanent red banner on every healthy phone. */
await checkAsync('a RETURNING device — persisted undefined — reports ok, not a fault', async () => {
  const seedId = await generateIdentity()
  globalThis.indexedDB = fakeIndexedDB({
    seed: {
      algo: seedId.algo,
      publicKey: seedId.publicKey,
      privateKey: seedId.privateKey,
      publicKeyB64: await exportPublicKeyB64(seedId)
    }
  })
  const { loadIdentity, identityStatus } = await freshStore()
  const id = await loadIdentity()
  return id.persisted === undefined && identityStatus() === 'ok'
})

/* --------------------------------------- the status and the guard agree --- */

/**
 * These two are the invariant worth protecting. `publishIdentity` decides
 * whether this device may overwrite the published key; `identityStatus` decides
 * whether the user is told the device is broken. If they ever disagree, either
 * the banner accuses a working device or a device quietly poisons its peers
 * while the UI says everything is fine.
 */
await checkAsync('ephemeral: status warns AND publishIdentity refuses to overwrite', async () => {
  globalThis.indexedDB = fakeIndexedDB({ lossy: true })
  let posted = false
  globalThis.fetch = (url, opts) => {
    const u = String(url)
    if (opts?.method === 'POST') { posted = true; return Promise.resolve({ ok: true, status: 200, json: async () => ({}) }) }
    if (u.includes('/api/v2/auth/keys/')) {
      // A DIFFERENT key is already published — the good one this must not clobber.
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ publicKey: 'AAAA-a-previously-published-key', algo: 'X25519' }) })
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
  }
  const { publishIdentity, identityStatus } = await freshStore()
  const published = await publishIdentity(tokenFor('me'))
  return identityStatus() === 'ephemeral' && published === false && posted === false
})

await checkAsync('returning device: status is ok AND publishIdentity is allowed to publish', async () => {
  const seedId = await generateIdentity()
  const mine = await exportPublicKeyB64(seedId)
  globalThis.indexedDB = fakeIndexedDB({
    seed: { algo: seedId.algo, publicKey: seedId.publicKey, privateKey: seedId.privateKey, publicKeyB64: mine }
  })
  let posted = false
  globalThis.fetch = (url, opts) => {
    if (opts?.method === 'POST') { posted = true; return Promise.resolve({ ok: true, status: 200, json: async () => ({}) }) }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ publicKey: 'AAAA-something-older', algo: 'X25519' }) })
  }
  const { publishIdentity, identityStatus } = await freshStore()
  const published = await publishIdentity(tokenFor('me'))
  return identityStatus() === 'ok' && posted === true && published !== false
})

/* -------------------------------------------------------------- report --- */

console.log('\n========================================')
console.log('  identity status — the device can say it is broken')
console.log('========================================')
for (const name of names) console.log(`  ${results[name] ? 'PASS' : 'FAIL'}  ${name}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
