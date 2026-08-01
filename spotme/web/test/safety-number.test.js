/**
 * Proves a safety number detects the one attack e2e_v2 cannot: a server that
 * substitutes its own public key.
 *
 * THE GAP THIS CLOSES. ADR-001 stopped the server DERIVING a room key, but the
 * server still HANDS OUT the public keys. Answer `GET /api/v2/auth/keys/:id`
 * with a key it holds the private half of, agree separately with each side, and
 * it reads everything while both clients display `e2e_v2`. `e2e-v2.js` states
 * this in its own header and defers it. The only defence is two humans comparing
 * something out of band, and this is that something.
 *
 * Everything runs on Node's WebCrypto against the SHIPPED module — no mocks, in
 * the same spirit as test/crypto.test.js, because a safety number computed by a
 * stand-in proves nothing about the one users will read out.
 *
 *   node test/safety-number.test.js
 */
import {
  safetyNumber, formatSafetyNumber, encodeVerificationPayload,
  decodeVerificationPayload, verifyScannedPayload
} from '../src/lib/crypto/safety-number.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  names.push(name)
  try { results[name] = (await fn()) === true } catch (e) {
    results[name] = false
    names.push(`${name} (threw: ${e.message})`)
    results[`${name} (threw: ${e.message})`] = false
  }
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64')
const keyOf = async () => b64(new Uint8Array(
  await crypto.subtle.exportKey('raw',
    (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])).publicKey)))

const ALICE = { userId: 'u_alice', publicKeyB64: await keyOf() }
const BOB = { userId: 'u_bob', publicKeyB64: await keyOf() }
const MALLORY_KEY = await keyOf()

/* ------------------------------------------- shape, and both sides agreeing */

const number = await safetyNumber(ALICE, BOB)

check('a safety number is exactly 60 digits', /^\d{60}$/.test(number))

await checkAsync('BOTH DEVICES SEE THE SAME NUMBER, whichever order they compute it in', async () =>
  (await safetyNumber(BOB, ALICE)) === number)

await checkAsync('it is deterministic — the same inputs always give the same number', async () =>
  (await safetyNumber(ALICE, BOB)) === number)

check('it reads as 12 groups of 5 for saying out loud',
  formatSafetyNumber(number) === (number.match(/\d{5}/g) || []).join(' '))

check('a malformed number is refused rather than displayed', (() => {
  try { formatSafetyNumber('123'); return false } catch { return true }
})())

/* ------------------------------------------------- THE ATTACK IT DETECTS */

await checkAsync('THE MITM: a substituted peer key changes the number', async () => {
  const impostor = { userId: BOB.userId, publicKeyB64: MALLORY_KEY }
  return (await safetyNumber(ALICE, impostor)) !== number
})

await checkAsync('...and the two sides then DISAGREE, which is the detection', async () => {
  // The server gives Alice a key it controls, and Bob a key it controls. Each
  // side's number is computed from what IT was told, so they cannot match.
  const aliceSees = await safetyNumber(ALICE, { userId: BOB.userId, publicKeyB64: MALLORY_KEY })
  const bobSees = await safetyNumber(BOB, { userId: ALICE.userId, publicKeyB64: MALLORY_KEY })
  return aliceSees !== bobSees
})

await checkAsync('the same key under a DIFFERENT account id gives a different number', async () => {
  // Binding to the account id stops a key lifted from one account being replayed
  // under another — the number would otherwise still match.
  const renamed = { userId: 'u_someone_else', publicKeyB64: BOB.publicKeyB64 }
  return (await safetyNumber(ALICE, renamed)) !== number
})

await checkAsync('a different conversation between different people is a different number', async () => {
  const carol = { userId: 'u_carol', publicKeyB64: await keyOf() }
  return (await safetyNumber(ALICE, carol)) !== number
})

/* --------------------------------------------------------- QR verification */

const payload = encodeVerificationPayload(ALICE, BOB)

check('the QR payload carries the KEYS, never the number', (() => {
  // Carrying the digits would verify nothing: an attacker who can show a QR can
  // show any string. The scanner has to recompute from keys.
  const parsed = JSON.parse(payload)
  return !JSON.stringify(parsed).includes(number.slice(0, 10)) &&
    parsed.a.k === ALICE.publicKeyB64 && parsed.b.k === BOB.publicKeyB64
})())

check('a payload round-trips', (() => {
  const { a, b } = decodeVerificationPayload(payload)
  return a.publicKeyB64 === ALICE.publicKeyB64 && b.userId === BOB.userId
})())

await checkAsync('scanning the honest payload CONFIRMS the number on screen', async () =>
  (await verifyScannedPayload(payload, number)).match === true)

await checkAsync('scanning a payload built from a substituted key FAILS', async () => {
  const forged = encodeVerificationPayload(ALICE, { userId: BOB.userId, publicKeyB64: MALLORY_KEY })
  const { match } = await verifyScannedPayload(forged, number)
  return match === false
})

check('a foreign QR is refused, not misparsed', (() => {
  for (const bad of ['', 'nonsense', '{}', JSON.stringify({ t: 'other' })]) {
    try { decodeVerificationPayload(bad); return false } catch { /* expected */ }
  }
  return true
})())

check('a future version is refused rather than guessed at', (() => {
  try {
    decodeVerificationPayload(JSON.stringify({ v: 99, t: 'spotme-safety', a: { k: 'x', i: 'y' }, b: { k: 'x', i: 'y' } }))
    return false
  } catch (e) { return /version/.test(e.message) }
})())

check('a payload missing a key is refused', (() => {
  try {
    decodeVerificationPayload(JSON.stringify({ v: 1, t: 'spotme-safety', a: { i: 'y' }, b: { k: 'x', i: 'y' } }))
    return false
  } catch { return true }
})())

/* ------------------------------------------------------------- bad input */

await checkAsync('a missing public key is refused, not silently hashed', async () => {
  try { await safetyNumber({ userId: 'a' }, BOB); return false } catch { return true }
})

await checkAsync('a missing account id is refused', async () => {
  try { await safetyNumber({ publicKeyB64: ALICE.publicKeyB64 }, BOB); return false } catch { return true }
})

await checkAsync('a non-base64 key is refused', async () => {
  try { await safetyNumber({ userId: 'a', publicKeyB64: '!!!not base64!!!' }, BOB); return false } catch { return true }
})

/* -------------------------------------------------------------- cost */

const t0 = Date.now()
await safetyNumber(ALICE, BOB)
const ms = Date.now() - t0
check(`5200 iterations cost ${ms}ms here — a visible pause on a phone, not a hang`, ms < 5000)

console.log('\n========================================')
console.log('  safety numbers — key authentication')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
