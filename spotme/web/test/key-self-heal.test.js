/**
 * Proves a conversation REPAIRS ITSELF when the peer's identity key moves.
 *
 * THE BUG THIS PINS. A device that cannot persist its X25519 identity generates
 * and republishes a new one on every launch. Each republish staleifies the
 * `convo.peerKey` that every other device stored at room creation, both sides
 * then derive different room keys, and every frame is dropped undecryptable —
 * in BOTH directions, permanently. Measured on two real handsets: @vijay22's
 * published key moved three times in one session while @ajith11's never did,
 * and the chat went silent while the server went on accepting messages and push
 * notifications went on arriving. Nothing surfaced, because a frame that will
 * not open dies in a `console.warn` and "Sent" is the default label.
 *
 * Permanently is the important word, and it was a code decision, not bad luck:
 * `roomKeyForConvo` PREFERS `convo.peerKey` and only reaches the network when it
 * is absent. The stored key is therefore self-perpetuating — retrying can never
 * fix it, and neither can evicting the transport's key cache, because the
 * provider re-derives from the same stale value. Only re-fetching does.
 *
 * WHAT IS DRIVEN HERE. The self-heal is exercised through the room object's
 * real `onFrame` — the same entry point `socket.on('action')` calls in
 * production — so the wiring is under test, not just the modules. That
 * distinction is this project's most expensive lesson: the first V-19 cut had
 * correct crypto that was never called, and it passed its module tests.
 *
 * Everything runs offline on Node's own WebCrypto. `fetch` and `indexedDB` are
 * faked; the crypto is real.
 *
 *   node test/key-self-heal.test.js
 */

/* --------------------------------------------------------------- stage --- */

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

const ALICE = 'u_alice_heal'
const BOB = 'u_bob_heal'
const ROOM = 'dm-heal-room'
const V1_SECRET = 'deadbeefcafe1234deadbeefcafe5678'

/* Seeded BEFORE the transport is imported: `selfId` is read from the profile at
 * module load, and dispatch drops any frame whose `from` matches it. */
globalThis.localStorage.setItem('spotme:app:v1', JSON.stringify({
  profile: { id: ALICE, name: 'Alice', username: 'alice' }, convos: {}, contacts: []
}))

/* A minimal IndexedDB. loadIdentity() stores a live CryptoKey, so this holds
 * objects rather than strings — which is the whole reason the real code uses
 * IndexedDB and not localStorage (ADR-001). */
function fakeIndexedDB (seed) {
  const stores = new Map([['identity', new Map(seed ? [['self', seed]] : [])]])
  const db = {
    createObjectStore (name) { if (!stores.has(name)) stores.set(name, new Map()); return {} },
    transaction (name) {
      const t = { oncomplete: null, onerror: null, onabort: null }
      t.objectStore = () => {
        const m = stores.get(name) || new Map()
        return { get: (k) => ({ result: m.get(k) }), put: (v, k) => { m.set(k, v); return {} } }
      }
      queueMicrotask(() => t.oncomplete?.())
      return t
    }
  }
  return {
    open () {
      const req = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null }
      queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.() })
      return req
    }
  }
}

/* `fetch` answers key lookups and NEVER settles the guest-auth call. That is
 * deliberate: it leaves ensureSocket() pending forever, so joinRoom's join()
 * parks instead of failing into its 2-second retry loop — no socket, no timers,
 * no hung test process. dispatch needs none of it. */
let peerKeyOnServer = null
let keyFetches = 0
let failKeyFetch = false
globalThis.fetch = (url) => {
  const u = String(url)
  if (u.includes('/api/v2/auth/keys/')) {
    keyFetches++
    if (failKeyFetch) return Promise.reject(new Error('offline'))
    return Promise.resolve({
      ok: true, status: 200,
      json: async () => ({ publicKey: peerKeyOnServer, algo: 'X25519' })
    })
  }
  return new Promise(() => {})   // guest auth: pending forever, on purpose
}

/* ------------------------------------------------------------ harness ---- */

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  names.push(name)
  try { results[name] = (await fn()) === true } catch (e) {
    results[name] = false
    results[`${name} (threw: ${e.message})`] = false
    names.push(`${name} (threw: ${e.message})`)
  }
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

const enc = new TextEncoder()

const { generateIdentity, exportPublicKeyB64, deriveRoomKey, E2E_V2 } =
  await import('../src/lib/crypto/e2e-v2.js')

/* Alice's identity is pre-seeded so loadIdentity() finds it instead of minting
 * one, and so the keys below are the same ones the transport will use. */
const alice = await generateIdentity()
globalThis.indexedDB = fakeIndexedDB({
  algo: alice.algo,
  publicKey: alice.publicKey,
  privateKey: alice.privateKey,
  publicKeyB64: await exportPublicKeyB64(alice)
})

const { roomKeyForConvo } = await import('../src/lib/crypto/identity-store.js')
const { joinRoom, setRoomKeyProvider, clearRoomKey, refreshRoomKey } =
  await import('../src/lib/socket-transport.js')
const { db } = await import('../src/lib/db.js')

/* Bob, twice: the key he published when the room was created, and the one his
 * broken device published on its next launch. */
const bobOld = await generateIdentity()
const bobNew = await generateIdentity()
const bobOldPub = await exportPublicKeyB64(bobOld)
const bobNewPub = await exportPublicKeyB64(bobNew)

/** What reach.js wrote at creation — pointing at the key Bob has since lost. */
const convo = {
  roomId: ROOM, secret: V1_SECRET, kind: 'dm',
  e2eVersion: E2E_V2, peerKey: bobOldPub,
  peer: { id: BOB, name: 'Bob' }
}

/* A frame as the transport puts it on the wire: base64(iv || ciphertext). */
const b64 = (bytes) => Buffer.from(bytes).toString('base64')
async function wireFrame (key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value))))
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv); out.set(ct, iv.length)
  return b64(out)
}
async function wireGarbage (key) {
  // Decrypts perfectly, then fails JSON.parse — a DIFFERENT failure that must
  // not be mistaken for a wrong key.
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode('{not json at all')))
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv); out.set(ct, iv.length)
  return b64(out)
}

const staleKey = await deriveRoomKey({ identity: alice, peerPublicKeyB64: bobOldPub, roomId: ROOM })
const trueKey = await deriveRoomKey({ identity: alice, peerPublicKeyB64: bobNewPub, roomId: ROOM })

/* ============ A. the stored key is preferred — until it is forced ========== */

peerKeyOnServer = bobNewPub

await checkAsync('without forcing, the STORED peer key is used and nothing hits the network', async () => {
  const before = keyFetches
  const key = await roomKeyForConvo(convo, async () => ({ accessToken: 'tok' }))
  const sealed = await wireFrame(staleKey, { text: 'hello' })
  const iv = Buffer.from(sealed, 'base64')
  await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv.subarray(0, 12) }, key, iv.subarray(12))
  return keyFetches === before
})

await checkAsync('THE REPAIR: forcing ignores the stored key and asks what the peer publishes NOW', async () => {
  const key = await roomKeyForConvo(convo, async () => ({ accessToken: 'tok' }), { forceRefetch: true })
  const sealed = Buffer.from(await wireFrame(trueKey, { text: 'after rotation' }), 'base64')
  const out = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: sealed.subarray(0, 12) }, key, sealed.subarray(12))
  return JSON.parse(new TextDecoder().decode(out)).text === 'after rotation'
})

await checkAsync('a recovered key is handed back so the caller can persist it', async () => {
  let reported = null
  await roomKeyForConvo(convo, async () => ({ accessToken: 'tok' }), {
    forceRefetch: true, onPeerKeyChanged: (k) => { reported = k }
  })
  return reported === bobNewPub
})

await checkAsync('an UNCHANGED key reports nothing — no pointless write on every heal', async () => {
  let reported = null
  const settled = { ...convo, peerKey: bobNewPub }
  await roomKeyForConvo(settled, async () => ({ accessToken: 'tok' }), {
    forceRefetch: true, onPeerKeyChanged: (k) => { reported = k }
  })
  return reported === null
})

await checkAsync('a forced re-fetch that fails falls back to the stored key instead of going dark', async () => {
  failKeyFetch = true
  try {
    const key = await roomKeyForConvo(convo, async () => ({ accessToken: 'tok' }), { forceRefetch: true })
    const sealed = Buffer.from(await wireFrame(staleKey, { text: 'still readable' }), 'base64')
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, 12) }, key, sealed.subarray(12))
    return true
  } finally { failKeyFetch = false }
})

/* ================= B. refreshRoomKey, and its guardrails ================== */

await checkAsync('a v1 room has nothing to re-agree, and is not offered a repair', async () => {
  return (await refreshRoomKey('some-v1-room')) === null
})

let providerCalls = []
const spyProvider = (opts) => {
  providerCalls.push(opts)
  return roomKeyForConvo(convo, async () => ({ accessToken: 'tok' }), opts)
}

await checkAsync('the repair reaches the provider as forceRefetch', async () => {
  clearRoomKey(ROOM); providerCalls = []
  setRoomKeyProvider(ROOM, spyProvider)
  const key = await refreshRoomKey(ROOM)
  return key != null && providerCalls.length === 1 && providerCalls[0]?.forceRefetch === true
})

await checkAsync('a burst of thirty broken frames produces ONE key fetch, not thirty', async () => {
  clearRoomKey(ROOM); providerCalls = []
  setRoomKeyProvider(ROOM, spyProvider)
  const keys = await Promise.all(Array.from({ length: 30 }, () => refreshRoomKey(ROOM)))
  return providerCalls.length === 1 && keys.every((k) => k != null)
})

await checkAsync('a room that stays broken is rate-limited, not retried per frame', async () => {
  providerCalls = []
  const second = await refreshRoomKey(ROOM)      // immediately after the burst
  return second === null && providerCalls.length === 0
})

await checkAsync('clearing the room lifts the cooldown, so a later repair can still run', async () => {
  clearRoomKey(ROOM); providerCalls = []
  setRoomKeyProvider(ROOM, spyProvider)
  return (await refreshRoomKey(ROOM)) != null && providerCalls.length === 1
})

/* ============ C. the wiring: a real frame, through the real room =========== */

await checkAsync('SANITY: the rotated frame genuinely cannot be opened with the stale key', async () => {
  const sealed = Buffer.from(await wireFrame(trueKey, { text: 'x' }), 'base64')
  try {
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, 12) }, staleKey, sealed.subarray(12))
    return false
  } catch (e) { return e?.name === 'OperationError' }
})

clearRoomKey(ROOM)
providerCalls = []
/* Registered exactly as rooms.js registers it, persistence callback included. */
setRoomKeyProvider(ROOM, (opts) => {
  providerCalls.push(opts)
  return roomKeyForConvo(convo, async () => ({ accessToken: 'tok' }), {
    ...opts,
    onPeerKeyChanged: (peerKey) => {
      convo.peerKey = peerKey
      db.upsertConvo({ roomId: ROOM, peerKey })
    }
  })
})
db.upsertConvo({ roomId: ROOM, peerKey: bobOldPub, e2eVersion: E2E_V2 })
convo.peerKey = bobOldPub

const room = joinRoom({ password: V1_SECRET }, ROOM)
const msg = room.makeAction('msg')
let received = null
msg.onMessage = (payload) => { received = payload }

await checkAsync('THE WIRING: a message sent after the peer rotated its key still ARRIVES', async () => {
  room.onFrame({ roomId: ROOM, from: BOB, type: 'msg', seq: 1, payload: await wireFrame(trueKey, { text: 'you can hear me now' }) })
  for (let i = 0; i < 40 && !received; i++) await tick()
  return received?.text === 'you can hear me now'
})

await checkAsync('...and the recovered key is PERSISTED, so a reload does not repeat the repair', async () => {
  return db.state?.().convos?.[ROOM]?.peerKey === bobNewPub || convo.peerKey === bobNewPub
})

await checkAsync('a frame that decrypts but is not JSON does NOT trigger a key re-fetch', async () => {
  clearRoomKey(ROOM)
  setRoomKeyProvider(ROOM, (opts) => { providerCalls.push(opts); return roomKeyForConvo(convo, async () => ({ accessToken: 'tok' }), opts) })
  await refreshRoomKey(ROOM)          // settle on the good key, spend the cooldown
  providerCalls = []
  received = null
  room.onFrame({ roomId: ROOM, from: BOB, type: 'msg', seq: 2, payload: await wireGarbage(trueKey) })
  for (let i = 0; i < 10; i++) await tick()
  return providerCalls.length === 0 && received === null
})

await checkAsync('a frame nobody can open is retried ONCE, never in a loop', async () => {
  const orphan = await generateIdentity()
  const unknowable = await deriveRoomKey({
    identity: alice, peerPublicKeyB64: await exportPublicKeyB64(orphan), roomId: ROOM
  })
  clearRoomKey(ROOM); providerCalls = []
  setRoomKeyProvider(ROOM, (opts) => { providerCalls.push(opts); return roomKeyForConvo(convo, async () => ({ accessToken: 'tok' }), opts) })
  received = null
  room.onFrame({ roomId: ROOM, from: BOB, type: 'msg', seq: 3, payload: await wireFrame(unknowable, { text: 'never' }) })
  for (let i = 0; i < 20; i++) await tick()
  // One re-agreement attempt for the frame, and one retry that also fails.
  return received === null && providerCalls.filter((o) => o?.forceRefetch).length === 1
})

/* ------------------------------------------------------------- report ---- */

console.log('\n========================================')
console.log('  self-healing key re-fetch')
console.log('========================================')
for (const name of names) console.log(`  ${results[name] ? 'PASS' : 'FAIL'}  ${name}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
room.leave()
process.exit(passed === names.length ? 0 : 1)
