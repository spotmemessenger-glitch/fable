/**
 * Proves a message that could not be opened is not thrown away.
 *
 * THE BUG THIS PINS — it is why a broken chat never recovered, and the single
 * most damaging line in the transport:
 *
 *     } finally {
 *       if (frame.seq && frame.seq > readCursor()) writeCursor(frame.seq)
 *     }
 *
 * `finally` runs whether or not the frame opened. The server replays strictly
 * `id > since`, so one undecryptable frame burned its own place in the replay
 * window and the message was gone from every future join — permanently, on both
 * devices, and irrespective of anything done afterwards. Repairing the key
 * brought nothing back because there was nothing left to bring back: the
 * self-heal would fix the room and the conversation would still be empty.
 *
 * A wrong key is REPAIRABLE, so a frame it could not open has not been
 * consumed. Anything else — JSON that is not JSON, a type nobody registered —
 * cannot be fixed by waiting, and holding the cursor for those would stall the
 * room forever, so those still advance.
 *
 * THE CASE THAT MATTERS MOST is the third check: a LATER frame opening must not
 * carry the cursor past an EARLIER one that did not. That is the difference
 * between "one message is waiting for a repair" and "one message is gone and
 * the rest look fine".
 *
 * Everything runs offline on Node's own WebCrypto. `indexedDB` and `fetch` are
 * faked; the crypto is real.
 *
 *   node test/replay-cursor-hold.test.js
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

const ALICE = 'u_alice_cursor'
const BOB = 'u_bob_cursor'
const ROOM = 'dm-cursor-room'
const V1_SECRET = 'deadbeefcafe1234deadbeefcafe5678'
const CURSOR = `spotme.cursor.${ALICE}.${ROOM}`

globalThis.localStorage.setItem('spotme:app:v1', JSON.stringify({
  profile: { id: ALICE, name: 'Alice', username: 'alice' }, convos: {}, contacts: []
}))

function fakeIndexedDB (seed) {
  const stores = new Map([['identity', new Map(seed ? [['self', seed]] : [])]])
  const db = {
    createObjectStore (n) { if (!stores.has(n)) stores.set(n, new Map()); return {} },
    transaction (n) {
      const t = { oncomplete: null, onerror: null, onabort: null }
      t.objectStore = () => {
        const m = stores.get(n) || new Map()
        return { get: (k) => ({ result: m.get(k) }), put: (v, k) => { m.set(k, v); return {} } }
      }
      queueMicrotask(() => t.oncomplete?.())
      return t
    }
  }
  return { open () {
    const req = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null }
    queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.() })
    return req
  } }
}

let peerKeyOnServer = null
globalThis.fetch = (url) => {
  if (String(url).includes('/api/v2/auth/keys/')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ publicKey: peerKeyOnServer, algo: 'X25519' }) })
  }
  return new Promise(() => {})   // guest auth never settles: no socket, no timers
}

const results = {}
const names = []
const checkAsync = async (name, fn) => {
  names.push(name)
  try { results[name] = (await fn()) === true } catch (e) {
    names.push(`${name} (threw: ${e.message})`)
    results[name] = false; results[`${name} (threw: ${e.message})`] = false
  }
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))
const enc = new TextEncoder()
const cursor = () => Number(globalThis.localStorage.getItem(CURSOR) || 0)

const { generateIdentity, exportPublicKeyB64, deriveRoomKey, E2E_V2 } =
  await import('../src/lib/crypto/e2e-v2.js')

const alice = await generateIdentity()
globalThis.indexedDB = fakeIndexedDB({
  algo: alice.algo, publicKey: alice.publicKey, privateKey: alice.privateKey,
  publicKeyB64: await exportPublicKeyB64(alice)
})

const { roomKeyForConvo } = await import('../src/lib/crypto/identity-store.js')
const { joinRoom, setRoomKeyProvider, clearRoomKey } = await import('../src/lib/socket-transport.js')
const { db } = await import('../src/lib/db.js')

const bob = await generateIdentity()
const bobPub = await exportPublicKeyB64(bob)
peerKeyOnServer = bobPub

const convo = {
  roomId: ROOM, secret: V1_SECRET, kind: 'dm',
  e2eVersion: E2E_V2, peerKey: bobPub, peer: { id: BOB, name: 'Bob' }
}
db.upsertConvo({ roomId: ROOM, peerKey: bobPub, e2eVersion: E2E_V2 })

const b64 = (b) => Buffer.from(b).toString('base64')
async function sealWith (key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value))))
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length)
  return b64(out)
}
async function sealGarbage (key) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode('{not json')))
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length)
  return b64(out)
}

const goodKey = await deriveRoomKey({ identity: alice, peerPublicKeyB64: bobPub, roomId: ROOM })
const orphan = await generateIdentity()
const unknowable = await deriveRoomKey({
  identity: alice, peerPublicKeyB64: await exportPublicKeyB64(orphan), roomId: ROOM
})

clearRoomKey(ROOM)
setRoomKeyProvider(ROOM, (opts) => roomKeyForConvo(convo, async () => ({ accessToken: 'tok' }), opts))

const room = joinRoom({ password: V1_SECRET }, ROOM)
const msg = room.makeAction('msg')
let received = []
msg.onMessage = (p) => received.push(p.text)

/* -------------------------------------------------------------- checks -- */

await checkAsync('a frame that OPENS advances the cursor', async () => {
  received = []
  room.onFrame({ roomId: ROOM, from: BOB, type: 'msg', seq: 10, payload: await sealWith(goodKey, { text: 'one' }) })
  for (let i = 0; i < 40 && !received.length; i++) await tick()
  return received[0] === 'one' && cursor() === 10
})

await checkAsync('THE BUG: a frame that cannot be opened does NOT advance the cursor', async () => {
  const before = cursor()
  room.onFrame({ roomId: ROOM, from: BOB, type: 'msg', seq: 11, payload: await sealWith(unknowable, { text: 'held' }) })
  for (let i = 0; i < 40; i++) await tick()
  return cursor() === before
})

await checkAsync('THE ONE THAT MATTERS: a LATER frame opening does not carry the cursor past it', async () => {
  received = []
  room.onFrame({ roomId: ROOM, from: BOB, type: 'msg', seq: 12, payload: await sealWith(goodKey, { text: 'later' }) })
  for (let i = 0; i < 40 && !received.length; i++) await tick()
  // The later message is delivered — but seq 11 is still owed, so the cursor
  // must sit below it or the server will never replay 11 again.
  return received[0] === 'later' && cursor() < 11
})

await checkAsync('a frame that DECRYPTS but is not JSON still advances — waiting cannot fix it', async () => {
  // A fresh room, so the earlier hold does not mask the result.
  const ROOM2 = 'dm-cursor-room-2'
  const CURSOR2 = `spotme.cursor.${ALICE}.${ROOM2}`
  const convo2 = { ...convo, roomId: ROOM2 }
  const key2 = await deriveRoomKey({ identity: alice, peerPublicKeyB64: bobPub, roomId: ROOM2 })
  db.upsertConvo({ roomId: ROOM2, peerKey: bobPub, e2eVersion: E2E_V2 })
  clearRoomKey(ROOM2)
  setRoomKeyProvider(ROOM2, (opts) => roomKeyForConvo(convo2, async () => ({ accessToken: 'tok' }), opts))
  const room2 = joinRoom({ password: V1_SECRET }, ROOM2)
  room2.makeAction('msg')
  room2.onFrame({ roomId: ROOM2, from: BOB, type: 'msg', seq: 7, payload: await sealGarbage(key2) })
  for (let i = 0; i < 40; i++) await tick()
  const out = Number(globalThis.localStorage.getItem(CURSOR2) || 0)
  room2.leave()
  return out === 7
})

/* -------------------------------------------------------------- report -- */

console.log('\n========================================')
console.log('  replay cursor — an unopened message keeps its place')
console.log('========================================')
for (const name of names) console.log(`  ${results[name] ? 'PASS' : 'FAIL'}  ${name}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
room.leave()
process.exit(passed === names.length ? 0 : 1)
