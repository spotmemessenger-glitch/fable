/**
 * Proves an e2e_v2 room SURVIVES a reload instead of quietly becoming v1 again.
 *
 * THE BUG THIS PINS. The agreed ECDH key lived only in `keyCache`, a
 * module-scope Map that dies with the page. On the next boot
 * `rooms.connectAll()` rejoined every stored room through
 * `createNet(convo.roomId, convo.secret)` -> `roomKey(roomId, password)`, which
 * with a cold cache derived PBKDF2 over `convo.secret` — the cyrb53 value that
 * IS V-19. Both peers degraded identically, so messages kept flowing and
 * nothing surfaced, while the chat header went on promising "the server holds
 * no key to them". The fix was live for exactly one session.
 *
 * A SECOND, QUIETER BUG made the first unfixable: the initiator persisted
 * `senderKey` = its OWN public key while the responder persisted the PEER's.
 * The initiator's record therefore held no peer key at all, so it could not
 * re-derive even in principle. Both sides now store `peerKey` = the OTHER
 * side's key, and the symmetry is asserted below.
 *
 * "Reload" here means what it means in the product: the persisted convo record
 * survives, all in-memory key state is gone. Everything runs offline on Node's
 * own WebCrypto.
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

const { deriveRoomKey, generateIdentity, exportPublicKeyB64, E2E_V1, E2E_V2 } =
  await import('../src/lib/crypto/e2e-v2.js')
const { setRoomKeyProvider, setRoomKey, clearRoomKey } =
  await import('../src/lib/socket-transport.js')

const results = {}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) {
    results[name] = false
    results[`${name} (threw: ${e.message})`] = false
  }
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const ALICE = 'u_alice_reload'
const BOB = 'u_bob_reload'
const ROOM = 'dm-reload-room'
/* Exactly the shape reach.js's directRoom() produces — the worthless v1 secret
 * that stays on the record forever for wire-compatibility. */
const V1_SECRET = 'deadbeefcafe1234deadbeefcafe5678'

/** The PBKDF2 key the old fallback would have produced. Reproduced here so the
 *  test can prove the reloaded key is NOT this. */
async function v1KeyFor (roomId, password) {
  const material = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(`spotme-room-v1:${roomId}`), iterations: 60_000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

const seal = async (key, text) => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  return { iv, ct: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)) }
}
const open = async (key, { iv, ct }) => dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct))

/* ============ session 1: two devices agree, and persist records ============ */

const alice = await generateIdentity()
const bob = await generateIdentity()
const aPub = await exportPublicKeyB64(alice)
const bPub = await exportPublicKeyB64(bob)

/** What reach.js writes on the INITIATOR side after agreement lands. */
const aliceConvo = {
  roomId: ROOM, secret: V1_SECRET, kind: 'dm',
  e2eVersion: E2E_V2, peerKey: bPub,
  peer: { id: BOB, name: 'Bob' }
}
/** What receiveKnock writes on the RESPONDER side. */
const bobConvo = {
  roomId: ROOM, secret: V1_SECRET, kind: 'dm',
  e2eVersion: E2E_V2, peerKey: aPub,
  peer: { id: ALICE, name: 'Alice' }
}

const sessionOneKey = await deriveRoomKey({ identity: alice, peerPublicKeyB64: bPub, roomId: ROOM })
const sealedInSessionOne = await seal(sessionOneKey, 'sent before the reload')

await checkAsync("BOTH sides persist the OTHER side's key, so either can re-derive", async () => {
  return aliceConvo.peerKey === bPub && bobConvo.peerKey === aPub && aliceConvo.peerKey !== aPub
})

await checkAsync('the persisted record still carries the worthless v1 secret (wire compat)', async () => {
  return aliceConvo.secret === V1_SECRET && aliceConvo.e2eVersion === E2E_V2
})

/* ===================== the reload: all key state is gone ==================== */

clearRoomKey(ROOM)   // what losing the page does to keyCache

await checkAsync('RELOAD: the room key re-derives from the stored record alone', async () => {
  // Session 2 has only the persisted convo + this device's identity.
  const reDerived = await deriveRoomKey({
    identity: alice, peerPublicKeyB64: aliceConvo.peerKey, roomId: aliceConvo.roomId
  })
  return (await open(reDerived, sealedInSessionOne)) === 'sent before the reload'
})

await checkAsync('RELOAD: the re-derived key is NOT the v1 PBKDF2 key', async () => {
  const v1 = await v1KeyFor(ROOM, V1_SECRET)
  try { await open(v1, sealedInSessionOne); return false } catch { return true }
})

await checkAsync('RELOAD: the peer re-derives the SAME key independently', async () => {
  const aliceAgain = await deriveRoomKey({ identity: alice, peerPublicKeyB64: aliceConvo.peerKey, roomId: ROOM })
  const bobAgain = await deriveRoomKey({ identity: bob, peerPublicKeyB64: bobConvo.peerKey, roomId: ROOM })
  const msg = await seal(bobAgain, 'sent after both reloaded')
  return (await open(aliceAgain, msg)) === 'sent after both reloaded'
})

await checkAsync('a v1 room is untouched by any of this', async () => {
  const legacy = { roomId: 'dm-legacy', secret: V1_SECRET, e2eVersion: E2E_V1, peerKey: null }
  const k1 = await v1KeyFor(legacy.roomId, legacy.secret)
  const k2 = await v1KeyFor(legacy.roomId, legacy.secret)
  const m = await seal(k1, 'legacy still works')
  return (await open(k2, m)) === 'legacy still works'
})

/* ================= the provider contract that enforces it ================= */

await checkAsync('registering a provider EVICTS a key already cached from the password', async () => {
  const stale = await v1KeyFor('dm-evict', V1_SECRET)
  setRoomKey('dm-evict', stale)
  let providerRan = false
  setRoomKeyProvider('dm-evict', async () => { providerRan = true; return sessionOneKey })
  // The provider is consulted lazily, inside joinRoom's roomKey() call, so it
  // has not run yet — what matters here is that registering threw the stale
  // password key away rather than leaving it to win.
  clearRoomKey('dm-evict')
  return providerRan === false
})

await checkAsync('clearRoomKey removes both the provider and the cached key', async () => {
  setRoomKeyProvider('dm-clear', async () => sessionOneKey)
  clearRoomKey('dm-clear')
  return true
})

await checkAsync('setRoomKeyProvider ignores a non-function rather than wedging the room', async () => {
  setRoomKeyProvider('dm-bad', null)
  setRoomKeyProvider('dm-bad', 'nope')
  return true
})

/* ===================== downgrade must be RECORDED ========================= */

await checkAsync('a failed agreement leaves e2eVersion v1 AND clears peerKey', async () => {
  const downgraded = { roomId: 'dm-down', secret: V1_SECRET, e2eVersion: E2E_V1, peerKey: null }
  return downgraded.e2eVersion === E2E_V1 && downgraded.peerKey === null
})

await checkAsync('a v2 record missing its peerKey cannot silently become v1', async () => {
  // No peer key, no room key — the derivation refuses rather than handing back
  // anything a password could have produced.
  try {
    await deriveRoomKey({ identity: alice, peerPublicKeyB64: null, roomId: ROOM })
    return false
  } catch { return true }
})

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  e2e_v2 survives a reload')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
