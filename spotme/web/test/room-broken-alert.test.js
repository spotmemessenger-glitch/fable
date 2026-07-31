/**
 * Proves a chat that CANNOT be read says so, instead of just looking quiet.
 *
 * THE GAP THIS PINS. After the self-heal landed, a room whose key genuinely
 * could not be re-agreed ended its life in `console.warn` — one line per
 * dropped frame, on a device with no console. From the user's side the chat was
 * indistinguishable from one where nobody had written: messages left the other
 * phone, the server accepted them, push notifications fired, and this end
 * displayed nothing at all. Two real users read that silence as "the app is
 * broken" and had no way to tell which of the two it was.
 *
 * `onUndecryptable` fires only once re-agreement has already been tried and
 * failed, so it means something specific and final: frames are arriving, the
 * transport did everything it can do automatically, and the only remaining move
 * belongs to the user.
 *
 * THE TWO WAYS THIS COULD BE WORSE THAN NOTHING, both checked below:
 *
 *   1. Firing when the self-heal WORKED. The repair is invisible by design —
 *      the frame simply arrives on the retry — so a warning raised on the way
 *      past would accuse a chat that had just fixed itself.
 *   2. Firing on a SyntaxError. A frame that decrypts and then fails
 *      `JSON.parse` proves the key is RIGHT. Blaming a key mismatch there sends
 *      the user to delete a perfectly good conversation.
 *
 * Driven through the room's real `onFrame` — the same entry point
 * `socket.on('action')` calls — not the modules alone, because a signal that is
 * emitted but never wired is this project's most expensive recurring bug.
 *
 * Everything runs offline on Node's own WebCrypto. `indexedDB` and `fetch` are
 * faked; the crypto is real.
 *
 *   node test/room-broken-alert.test.js
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

const ALICE = 'u_alice_alert'
const BOB = 'u_bob_alert'
const ROOM = 'dm-alert-room'
const V1_SECRET = 'deadbeefcafe1234deadbeefcafe5678'

/* Seeded BEFORE the transport is imported: `selfId` is read from the profile at
 * module load, and dispatch drops any frame whose `from` matches it. */
globalThis.localStorage.setItem('spotme:app:v1', JSON.stringify({
  profile: { id: ALICE, name: 'Alice', username: 'alice' }, convos: {}, contacts: []
}))

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

/* Key lookups answer; guest auth never settles, which parks `ensureSocket()`
 * forever so `joinRoom` cannot start its retry loop. dispatch needs no socket. */
let peerKeyOnServer = null
globalThis.fetch = (url) => {
  if (String(url).includes('/api/v2/auth/keys/')) {
    return Promise.resolve({
      ok: true, status: 200, json: async () => ({ publicKey: peerKeyOnServer, algo: 'X25519' })
    })
  }
  return new Promise(() => {})
}

/* ------------------------------------------------------------ harness ---- */

const results = {}
const names = []
const checkAsync = async (name, fn) => {
  names.push(name)
  try { results[name] = (await fn()) === true } catch (e) {
    names.push(`${name} (threw: ${e.message})`)
    results[name] = false
    results[`${name} (threw: ${e.message})`] = false
  }
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))
const enc = new TextEncoder()

const { generateIdentity, exportPublicKeyB64, deriveRoomKey, E2E_V2 } =
  await import('../src/lib/crypto/e2e-v2.js')

const alice = await generateIdentity()
globalThis.indexedDB = fakeIndexedDB({
  algo: alice.algo,
  publicKey: alice.publicKey,
  privateKey: alice.privateKey,
  publicKeyB64: await exportPublicKeyB64(alice)
})

const { roomKeyForConvo } = await import('../src/lib/crypto/identity-store.js')
const { joinRoom, setRoomKeyProvider, clearRoomKey } = await import('../src/lib/socket-transport.js')
const { db } = await import('../src/lib/db.js')

const bobOld = await generateIdentity()
const bobNew = await generateIdentity()
const bobOldPub = await exportPublicKeyB64(bobOld)
const bobNewPub = await exportPublicKeyB64(bobNew)

const convo = {
  roomId: ROOM, secret: V1_SECRET, kind: 'dm',
  e2eVersion: E2E_V2, peerKey: bobOldPub,
  peer: { id: BOB, name: 'Bob' }
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64')
async function sealWith (key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify({ text }))))
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length)
  return b64(out)
}
async function sealGarbage (key) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode('{not json at all')))
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length)
  return b64(out)
}

const trueKey = await deriveRoomKey({ identity: alice, peerPublicKeyB64: bobNewPub, roomId: ROOM })

db.upsertConvo({ roomId: ROOM, peerKey: bobOldPub, e2eVersion: E2E_V2 })

const room = joinRoom({ password: V1_SECRET }, ROOM)
const msg = room.makeAction('msg')
let received = null
msg.onMessage = (payload) => { received = payload }

/** Every undecryptable report the room has raised. */
let alerts = []
room.onUndecryptable = (info) => { alerts.push(info) }

const provider = (opts) => roomKeyForConvo(convo, async () => ({ accessToken: 'tok' }), {
  ...opts,
  onPeerKeyChanged: (peerKey) => { convo.peerKey = peerKey; db.upsertConvo({ roomId: ROOM, peerKey }) }
})

/* ========== 1. the repair still works, and stays SILENT when it does ======= */

await checkAsync('a room the self-heal REPAIRS raises no alarm — the message just arrives', async () => {
  peerKeyOnServer = bobNewPub
  convo.peerKey = bobOldPub                     // stale: what the repair must beat
  clearRoomKey(ROOM); setRoomKeyProvider(ROOM, provider)
  alerts = []; received = null
  room.onFrame({ roomId: ROOM, from: BOB, type: 'msg', seq: 1, payload: await sealWith(trueKey, 'you can hear me now') })
  for (let i = 0; i < 40 && !received; i++) await tick()
  return received?.text === 'you can hear me now' && alerts.length === 0
})

/* ========== 2. a room nothing can repair DOES raise it ===================== */

await checkAsync('THE POINT: a frame nobody can open reports itself instead of dying in a warn', async () => {
  const orphan = await generateIdentity()
  const unknowable = await deriveRoomKey({
    identity: alice, peerPublicKeyB64: await exportPublicKeyB64(orphan), roomId: ROOM
  })
  peerKeyOnServer = bobNewPub                   // the server's key is no help here
  clearRoomKey(ROOM); setRoomKeyProvider(ROOM, provider)
  alerts = []; received = null
  room.onFrame({ roomId: ROOM, from: BOB, type: 'msg', seq: 2, payload: await sealWith(unknowable, 'never') })
  for (let i = 0; i < 40 && !alerts.length; i++) await tick()
  return received === null && alerts.length >= 1
})

await checkAsync('…and it names the room, so a device in several chats can attribute it', async () => {
  return alerts[0]?.roomId === ROOM && alerts[0]?.from === BOB
})

/* ========== 3. the two false positives that would make it harmful ========= */

await checkAsync('a frame that DECRYPTS but is not JSON raises nothing — the key is fine', async () => {
  peerKeyOnServer = bobNewPub
  clearRoomKey(ROOM); setRoomKeyProvider(ROOM, provider)
  // Settle on the good key first so the frame below really does decrypt.
  await provider({ forceRefetch: true })
  alerts = []; received = null
  room.onFrame({ roomId: ROOM, from: BOB, type: 'msg', seq: 3, payload: await sealGarbage(trueKey) })
  for (let i = 0; i < 20; i++) await tick()
  return alerts.length === 0 && received === null
})

await checkAsync('a readable frame raises nothing at all', async () => {
  peerKeyOnServer = bobNewPub
  clearRoomKey(ROOM); setRoomKeyProvider(ROOM, provider)
  alerts = []; received = null
  room.onFrame({ roomId: ROOM, from: BOB, type: 'msg', seq: 4, payload: await sealWith(trueKey, 'perfectly fine') })
  for (let i = 0; i < 40 && !received; i++) await tick()
  return received?.text === 'perfectly fine' && alerts.length === 0
})

/* -------------------------------------------------------------- report --- */

console.log('\n========================================')
console.log('  broken room — a chat that cannot be read says so')
console.log('========================================')
for (const name of names) console.log(`  ${results[name] ? 'PASS' : 'FAIL'}  ${name}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
room.leave()
process.exit(passed === names.length ? 0 : 1)
