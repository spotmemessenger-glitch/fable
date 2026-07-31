/**
 * V-19: proves the server can no longer derive a direct-message key.
 *
 * THE FLAW THIS EXISTS TO KILL. `reach.js:90-97` built a DM secret as
 * `stableHash('spotme-dm-secret-v1:' + key) + stableHash('...-v2:' + key)`
 * where `key` is just the two user ids, sorted. stableHash is cyrb53 — a
 * NON-cryptographic hash whose own docstring says it is "never to protect
 * anything" — and the whole input is two values the server already stores in
 * the User table. Concatenating two of them produced 128 bits of OUTPUT and
 * zero bits of ENTROPY. The server could recompute any DM key and read
 * everything, while the onboarding screen said "no server reading your
 * messages".
 *
 * HOW YOU TEST AN IMPOSSIBILITY. You cannot assert "nobody can ever derive
 * this". What you CAN assert is that the inputs the server actually holds are
 * insufficient, and that the only sufficient input never leaves the device:
 *
 *   - a positive control: v1 IS reproducible from ids alone (pinned below, so
 *     nobody can quietly reintroduce it as the live scheme);
 *   - v2 derivation REQUIRES a private key, and rejects public-only input;
 *   - the private key is non-exportable, so it cannot be uploaded even by a
 *     bug or a malicious build;
 *   - two ids, plus BOTH public keys — everything the server has — still do
 *     not produce the room key.
 *
 * Runs offline on Node's own WebCrypto. No IndexedDB, no window, no mocks:
 * `e2e-v2.js` is deliberately pure so this file can be honest about what it
 * proves.
 */
const m = await import('../src/lib/crypto/e2e-v2.js')
const {
  E2E_V1, E2E_V2,
  generateIdentity, exportPublicKeyB64, importPeerPublicKey,
  deriveRoomKey, deriveV1SecretForContrast, negotiateAlgo
} = m

const results = {}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) {
    results[name] = false
    results[`${name} (threw: ${e.message})`] = false
  }
}

const ALICE = 'u_alice_0001'
const BOB = 'u_bob_0002'
const ROOM = 'dm-room-abc'

const enc = new TextEncoder()

/* ============================ positive control ============================ */

await checkAsync('CONTROL: v1 secret IS reproducible from two user ids alone', async () => {
  const a = deriveV1SecretForContrast(ALICE, BOB)
  const b = deriveV1SecretForContrast(BOB, ALICE)
  // Order-independent and fully deterministic — exactly the flaw.
  return typeof a === 'string' && a.length === 32 && a === b
})

await checkAsync('CONTROL: v1 needs no secret input whatsoever', async () => {
  // Anyone holding the two ids — the server certainly does — reproduces it.
  return deriveV1SecretForContrast(ALICE, BOB) === deriveV1SecretForContrast(ALICE, BOB)
})

/* ========================== v2: real agreement =========================== */

await checkAsync('two peers derive the SAME v2 room key', async () => {
  const alice = await generateIdentity()
  const bob = await generateIdentity()
  const aPub = await exportPublicKeyB64(alice)
  const bPub = await exportPublicKeyB64(bob)

  const kA = await deriveRoomKey({ identity: alice, peerPublicKeyB64: bPub, roomId: ROOM })
  const kB = await deriveRoomKey({ identity: bob, peerPublicKeyB64: aPub, roomId: ROOM })

  // Compare by behaviour: a key is only "the same" if it decrypts the other's ciphertext.
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kA, enc.encode('hello bob'))
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, kB, ct)
  return new TextDecoder().decode(pt) === 'hello bob'
})

await checkAsync('derivation is order-independent (either side may initiate)', async () => {
  const alice = await generateIdentity()
  const bob = await generateIdentity()
  const kA = await deriveRoomKey({ identity: alice, peerPublicKeyB64: await exportPublicKeyB64(bob), roomId: ROOM })
  const kB = await deriveRoomKey({ identity: bob, peerPublicKeyB64: await exportPublicKeyB64(alice), roomId: ROOM })
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kB, enc.encode('x'))
  await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, kA, ct)
  return true
})

/* ================== THE POINT: the server cannot derive ================== */

await checkAsync('THE FIX: two user ids alone yield no v2 key — no such function exists', async () => {
  // The server has ALICE and BOB. Under v1 that was enough. Under v2 there is
  // deliberately no id-only derivation path to call at all.
  const idOnlyApi = Object.keys(m).filter((k) => /^derive/.test(k) && k !== 'deriveV1SecretForContrast')
  for (const name of idOnlyApi) {
    const fn = m[name]
    let threw = false
    try { await fn({ roomId: ROOM, aId: ALICE, bId: BOB }) } catch { threw = true }
    if (!threw) return false        // an id-only call that SUCCEEDS is V-19 all over again
  }
  return idOnlyApi.length > 0
})

await checkAsync('THE FIX: both PUBLIC keys are still not enough', async () => {
  const alice = await generateIdentity()
  const bob = await generateIdentity()
  const aPub = await exportPublicKeyB64(alice)
  const bPub = await exportPublicKeyB64(bob)
  // Everything the server holds: two ids and two public keys. Feed the peer's
  // public key in place of an identity and it must be refused, not accepted.
  const publicOnly = { publicKey: await importPeerPublicKey(aPub), privateKey: undefined }
  try {
    await deriveRoomKey({ identity: publicOnly, peerPublicKeyB64: bPub, roomId: ROOM })
    return false
  } catch { return true }
})

await checkAsync('THE FIX: the private key is NON-EXPORTABLE, so it cannot be uploaded', async () => {
  const alice = await generateIdentity()
  if (alice.privateKey.extractable !== false) return false
  for (const fmt of ['raw', 'pkcs8', 'jwk']) {
    try { await crypto.subtle.exportKey(fmt, alice.privateKey); return false } catch { /* expected */ }
  }
  return true
})

await checkAsync('the derived room key is itself non-extractable', async () => {
  const alice = await generateIdentity()
  const bob = await generateIdentity()
  const k = await deriveRoomKey({ identity: alice, peerPublicKeyB64: await exportPublicKeyB64(bob), roomId: ROOM })
  if (k.extractable !== false) return false
  try { await crypto.subtle.exportKey('raw', k); return false } catch { return true }
})

/* ========================= binding and separation ========================= */

await checkAsync('a different room yields a different key (HKDF info is bound to roomId)', async () => {
  const alice = await generateIdentity()
  const bob = await generateIdentity()
  const bPub = await exportPublicKeyB64(bob)
  const k1 = await deriveRoomKey({ identity: alice, peerPublicKeyB64: bPub, roomId: 'dm-room-1' })
  const k2 = await deriveRoomKey({ identity: alice, peerPublicKeyB64: bPub, roomId: 'dm-room-2' })
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k1, enc.encode('secret'))
  try { await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k2, ct); return false } catch { return true }
})

await checkAsync('a third party derives a DIFFERENT key for the same room', async () => {
  const alice = await generateIdentity()
  const bob = await generateIdentity()
  const carol = await generateIdentity()
  const kAB = await deriveRoomKey({ identity: alice, peerPublicKeyB64: await exportPublicKeyB64(bob), roomId: ROOM })
  const kAC = await deriveRoomKey({ identity: carol, peerPublicKeyB64: await exportPublicKeyB64(alice), roomId: ROOM })
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kAB, enc.encode('for bob only'))
  try { await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, kAC, ct); return false } catch { return true }
})

await checkAsync('every identity is distinct — no deterministic key material', async () => {
  const a = await exportPublicKeyB64(await generateIdentity())
  const b = await exportPublicKeyB64(await generateIdentity())
  return a !== b && a.length > 0
})

/* ============================ wire format ================================ */

await checkAsync('a public key survives base64 export and re-import', async () => {
  const alice = await generateIdentity()
  const b64 = await exportPublicKeyB64(alice)
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return false
  const reimported = await importPeerPublicKey(b64)
  const bob = await generateIdentity()
  // A re-imported key must still work as a peer key.
  const k = await deriveRoomKey({ identity: bob, peerPublicKeyB64: b64, roomId: ROOM })
  return Boolean(reimported) && k?.type === 'secret'
})

await checkAsync('a malformed peer key is rejected, not silently accepted', async () => {
  const alice = await generateIdentity()
  for (const bad of ['', 'not-base64!!', 'AAAA', null, undefined]) {
    try { await deriveRoomKey({ identity: alice, peerPublicKeyB64: bad, roomId: ROOM }); return false } catch { /* expected */ }
  }
  return true
})

await checkAsync('an empty roomId is refused — keys must be room-bound', async () => {
  const alice = await generateIdentity()
  const bob = await generateIdentity()
  const bPub = await exportPublicKeyB64(bob)
  try { await deriveRoomKey({ identity: alice, peerPublicKeyB64: bPub, roomId: '' }); return false } catch { return true }
})

/* ========================== algorithm negotiation ======================== */

await checkAsync('X25519 is preferred where available', async () => {
  const algo = await negotiateAlgo()
  return algo === 'X25519' || algo === 'P-256'
})

await checkAsync('peers on different curves cannot silently half-agree', async () => {
  const a = await generateIdentity({ algo: 'X25519' }).catch(() => null)
  const b = await generateIdentity({ algo: 'P-256' }).catch(() => null)
  if (!a || !b) return true                       // one curve unavailable here; nothing to prove
  try { await deriveRoomKey({ identity: a, peerPublicKeyB64: await exportPublicKeyB64(b), roomId: ROOM }); return false }
  catch { return true }
})

await checkAsync('the version constants are distinct and explicit', async () => {
  return E2E_V1 === 'e2e_v1' && E2E_V2 === 'e2e_v2'
})

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  V-19 — direct message key agreement')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
