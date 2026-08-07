/**
 * Proves a scanned safety number is BOUND before it is believed, and that
 * believing it is recorded.
 *
 * WHAT WAS MISSING. `safety-number.js` could already compute the 60 digits and
 * encode a QR payload, and `views/verify.js` displayed them — but nothing
 * consumed a scan and nothing stored the answer. Verification was something you
 * looked at and then lost, which is exactly why A1's pin could never become
 * Verified from a real comparison.
 *
 * WHY BINDING IS THE WHOLE OF THIS SUITE. A matching 60 digits proves only that
 * two keys belong together. On its own it says nothing about WHICH conversation
 * the code was for, WHEN it was made, or whether those are the keys this device
 * actually holds. So a genuine, unexpired, correctly-matching code for one chat
 * would verify a different one — and a code photographed off someone's screen
 * would keep working after the key it covered had been replaced. Each check
 * below is one of those doors.
 *
 * The order matters and is asserted: every binding is checked BEFORE the digits
 * are recomputed, so a wrong-room or expired code is refused for the right
 * reason rather than for an incidental digit mismatch.
 *
 * Real WebCrypto, real safety numbers, faked IndexedDB.
 *
 *   node test/identity-verify.test.js
 */
import {
  safetyNumber, encodeVerificationPayload, decodeVerificationPayload,
  verifyScannedPayload, SCAN_ERR, PAYLOAD_VERSION, SAFETY_VERSION, PAYLOAD_MAX_AGE_MS,
} from '../src/lib/crypto/safety-number.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { check(name, (await fn()) === true) } catch (e) { check(`${name} [threw: ${e.message}]`, false) }
}

/* ------------------------------------------------------------- fixtures --- */

const ALICE = { publicKeyB64: btoa(String.fromCharCode(...new Array(32).fill(1))), userId: 'alice' }
const BOB = { publicKeyB64: btoa(String.fromCharCode(...new Array(32).fill(2))), userId: 'bob' }
const MALLORY = { publicKeyB64: btoa(String.fromCharCode(...new Array(32).fill(3))), userId: 'bob' }

const ROOM = 'room-abc'
const NOW = 1_700_000_000_000

const digits = await safetyNumber(ALICE, BOB)
const good = encodeVerificationPayload(ALICE, BOB, { roomId: ROOM, at: NOW })
const ctx = { roomId: ROOM, at: NOW, selfKey: ALICE.publicKeyB64, peerKey: BOB.publicKeyB64 }

/* ============================ 1. the happy path, and what it returns ====== */

await checkAsync('a correct, fresh, in-room code verifies', async () =>
  (await verifyScannedPayload(good, digits, ctx)).match === true)

await checkAsync('…and hands back the key that was ACTUALLY compared', async () => {
  // The caller must record THIS, not a key re-read afterwards — the gap between
  // comparing and recording is exactly where a substitution would land.
  const out = await verifyScannedPayload(good, digits, ctx)
  return out.verifiedKey === BOB.publicKeyB64 && out.peerId === 'bob'
})

await checkAsync('the payload names the conversation, the time and the construction', async () => {
  const d = decodeVerificationPayload(good)
  return d.version === PAYLOAD_VERSION && d.roomId === ROOM &&
    d.issuedAt === NOW && d.safetyVersion === SAFETY_VERSION
})

/* ============================ 2. conversation binding ==================== */

await checkAsync('THE ONE THAT MATTERS: a genuine code for ANOTHER room does not verify', async () => {
  /* Same two people, same keys, correct digits, unexpired. Only the room
   * differs. Without `r` this passed, and scanning in one chat would silently
   * mark another verified — including one whose key had since changed. */
  const other = encodeVerificationPayload(ALICE, BOB, { roomId: 'room-xyz', at: NOW })
  const out = await verifyScannedPayload(other, digits, ctx)
  return out.match === false && out.error === SCAN_ERR.WRONG_ROOM
})

await checkAsync('a caller that forgets to name the room is refused, not waved through', async () => {
  const out = await verifyScannedPayload(good, digits, { ...ctx, roomId: undefined })
  return out.match === false && out.error === SCAN_ERR.WRONG_ROOM
})

/* ============================ 3. freshness ============================== */

await checkAsync('a code older than the window is expired', async () => {
  const out = await verifyScannedPayload(good, digits, { ...ctx, at: NOW + PAYLOAD_MAX_AGE_MS + 1 })
  return out.match === false && out.error === SCAN_ERR.EXPIRED
})

await checkAsync('…but one inside the window still works', async () => {
  const out = await verifyScannedPayload(good, digits, { ...ctx, at: NOW + PAYLOAD_MAX_AGE_MS - 1 })
  return out.match === true
})

await checkAsync('a FUTURE-dated code does not buy itself extra life', async () => {
  // Otherwise a hand-made payload post-dated by a year is valid for a year.
  const future = encodeVerificationPayload(ALICE, BOB, { roomId: ROOM, at: NOW + 86_400_000 })
  const out = await verifyScannedPayload(future, digits, ctx)
  return out.match === false && out.error === SCAN_ERR.EXPIRED
})

/* ============================ 4. version binding ======================== */

await checkAsync('a v1 code is refused as OLD_FORMAT, not as unreadable', async () => {
  /* Decodable on purpose, so the UI can say "this code predates conversation
   * binding — generate a new one" instead of "not a Spot Me code", which would
   * send someone hunting for the wrong problem. */
  const v1 = JSON.stringify({
    v: 1, t: 'spotme-safety',
    a: { k: ALICE.publicKeyB64, i: ALICE.userId },
    b: { k: BOB.publicKeyB64, i: BOB.userId }
  })
  const out = await verifyScannedPayload(v1, digits, ctx)
  return out.match === false && out.error === SCAN_ERR.OLD_FORMAT
})

await checkAsync('a code from a different SAFETY-NUMBER version is refused', async () => {
  // The digits from another VERSION prefix can never equal ours, so comparing
  // them would fail for a confusing reason instead of a stated one.
  const wrong = JSON.parse(good); wrong.sv = '9.9'
  const out = await verifyScannedPayload(JSON.stringify(wrong), digits, ctx)
  return out.match === false && out.error === SCAN_ERR.WRONG_SAFETY_VERSION
})

await checkAsync('an unparseable code is UNREADABLE, and does not throw', async () => {
  const out = await verifyScannedPayload('{not json', digits, ctx)
  return out.match === false && out.error === SCAN_ERR.UNREADABLE
})

/* ============================ 5. key binding ============================ */

await checkAsync('a code not naming THIS device\'s identity is refused', async () => {
  const between = encodeVerificationPayload(MALLORY, BOB, { roomId: ROOM, at: NOW })
  const out = await verifyScannedPayload(between, digits, ctx)
  return out.match === false && out.error === SCAN_ERR.WRONG_SELF_KEY
})

await checkAsync('a code naming a peer key this device does NOT trust is refused', async () => {
  /* The substitution case. A perfectly-formed code for Mallory's key, in the
   * right room, unexpired — refused because it is not the key we pinned. */
  const forged = encodeVerificationPayload(ALICE, MALLORY, { roomId: ROOM, at: NOW })
  const out = await verifyScannedPayload(forged, digits, ctx)
  return out.match === false && out.error === SCAN_ERR.WRONG_PEER_KEY
})

await checkAsync('…and it is refused BEFORE the digits are recomputed', async () => {
  // Reported as WRONG_PEER_KEY rather than DIGITS_DIFFER. The distinction is
  // what lets the UI say "that is not their key" instead of "numbers differ".
  const forged = encodeVerificationPayload(ALICE, MALLORY, { roomId: ROOM, at: NOW })
  const out = await verifyScannedPayload(forged, digits, ctx)
  return out.scanned === undefined && out.error === SCAN_ERR.WRONG_PEER_KEY
})

await checkAsync('matching keys but the WRONG expected digits still fails', async () => {
  const out = await verifyScannedPayload(good, '0'.repeat(60), ctx)
  return out.match === false && out.error === SCAN_ERR.DIGITS_DIFFER
})

/* ============================ 6. it is recorded ========================= */

function fakeIDB () {
  const rows = new Map()
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({}),
    transaction () {
      const t = {}
      let pending = 0
      const request = (work) => {
        const r = {}
        pending++
        queueMicrotask(() => {
          r.result = work(); r.onsuccess?.(); pending--
          queueMicrotask(() => { if (pending === 0) t.oncomplete?.() })
        })
        return r
      }
      t.abort = () => queueMicrotask(() => t.onabort?.())
      t.objectStore = () => ({
        get: (k) => request(() => rows.get(k)),
        put: (v) => request(() => { rows.set(v.peerId, JSON.parse(JSON.stringify(v))); return v.peerId }),
        getAll: () => request(() => [...rows.values()]),
        delete: (k) => request(() => { rows.delete(k) })
      })
      queueMicrotask(() => { if (pending === 0) t.oncomplete?.() })
      return t
    }
  }
  return {
    rows,
    open () {
      const req = { result: db }
      queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.() })
      return req
    }
  }
}

const idb = fakeIDB()
globalThis.indexedDB = idb
const { applyToRecord } = await import('../src/lib/crypto/identity-pin-store.js')
const { recordVerification } = await import('../src/lib/crypto/identity-store.js')
const { OBSERVE, PINNED, VERIFIED, CHANGED } = await import('../src/lib/crypto/identity-pin.js')

await checkAsync('a successful scan is PERSISTED as Verified', async () => {
  await applyToRecord('bob', { type: OBSERVE, at: NOW, key: BOB.publicKeyB64 })
  const out = await verifyScannedPayload(good, digits, ctx)
  const rec = await recordVerification('bob', out.verifiedKey)
  return rec.ok === true && rec.next.state === VERIFIED && idb.rows.get('bob').state === VERIFIED
})

await checkAsync('verifying a key that is neither pinned nor proposed is refused', async () => {
  await applyToRecord('carol', { type: OBSERVE, at: NOW, key: BOB.publicKeyB64 })
  const rec = await recordVerification('carol', MALLORY.publicKeyB64)
  return rec.ok === false && rec.error.code === 'KEY_MISMATCH'
})

await checkAsync('THE PROPOSAL RULE: only the EXACT proposed key may be verified', async () => {
  /* A Changed peer has a pin and a proposal. Verifying something that is
   * neither must not resolve the change — otherwise "a verification happened
   * while a proposal was outstanding" would be enough to clear a MITM warning. */
  await applyToRecord('dave', { type: OBSERVE, at: NOW, key: BOB.publicKeyB64 })
  await applyToRecord('dave', { type: OBSERVE, at: NOW + 1, key: MALLORY.publicKeyB64 })
  const stray = await recordVerification('dave', ALICE.publicKeyB64)
  const stillChanged = idb.rows.get('dave')
  return stray.ok === false && stillChanged.state === CHANGED &&
    stillChanged.pinnedKey === BOB.publicKeyB64
})

await checkAsync('…and verifying that exact proposed key DOES resolve it', async () => {
  const ok = await recordVerification('dave', MALLORY.publicKeyB64)
  return ok.ok === true && ok.next.state === VERIFIED && ok.next.pinnedKey === MALLORY.publicKeyB64
})

await checkAsync('Changed survives a refused verification — nothing partial is written', async () => {
  await applyToRecord('erin', { type: OBSERVE, at: NOW, key: BOB.publicKeyB64 })
  await applyToRecord('erin', { type: OBSERVE, at: NOW + 1, key: MALLORY.publicKeyB64 })
  const before = JSON.stringify(idb.rows.get('erin'))
  await recordVerification('erin', ALICE.publicKeyB64)
  return JSON.stringify(idb.rows.get('erin')) === before
})

await checkAsync('recordVerification refuses a missing key rather than throwing', async () => {
  const out = await recordVerification('bob', null)
  return out.ok === false && out.error.code === 'MISSING_KEY'
})

await checkAsync('a first-use peer is Pinned, and stays Pinned until a real scan', async () => {
  await applyToRecord('frank', { type: OBSERVE, at: NOW, key: BOB.publicKeyB64 })
  return idb.rows.get('frank').state === PINNED
})

console.log('\n========================================')
console.log('  identity verification — bound, then believed')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
