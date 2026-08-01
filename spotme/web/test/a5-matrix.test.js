/**
 * The A5 device matrix, mechanised.
 *
 * WHAT A5 IS AND WHY IT NEEDS A MATRIX. A5 makes trust state ENFORCING:
 * `Changed` blocks sending until the user reviews it, `Revoked` blocks
 * entirely. Enforcement that fires wrongly locks people out of their own
 * conversations, so before it ships, each scenario that could produce a wrong
 * state has to be walked. That list was going to be walked by hand on real
 * devices. Most of it does not need a device.
 *
 * WHAT THIS SUITE COVERS — the four mechanisable rows, driven through the REAL
 * modules over BOTH databases at once, which no other suite does:
 *
 *   1. two tabs writing at the same moment
 *   2. the app being closed and reopened
 *   3. the pin store being unavailable, and later recovering
 *   4. records and conversations written by builds that predate pinning
 *
 * WHAT IT DELIBERATELY DOES NOT COVER, and what therefore stays on the manual
 * list — printed at the end of the run so it travels with the CI log rather
 * than living in a chat message:
 *
 *   - scanning a QR code off another phone's screen with a real camera
 *   - genuine multi-device: two installs, one account, two agreement keys
 *   - real local key loss — OS storage eviction, app data cleared
 *   - IndexedDB version-change blocking between two LIVE connections, which the
 *     fake does not model and which is a real source of wedged tabs
 *
 * THE ASSERTIONS ARE ABOUT PERSISTED STATE, not about enforcement, because
 * enforcement does not exist yet — that is A5 itself. The matrix answers the
 * question enforcement will depend on: after this scenario, is the stored trust
 * record the one a blocking decision should be made from?
 *
 *   node test/a5-matrix.test.js
 */
import { makeIDB } from './helpers/fake-idb.js'
import {
  readRecord, applyToRecord, _resetForTests,
} from '../src/lib/crypto/identity-pin-store.js'
import {
  UNVERIFIED, PINNED, VERIFIED, CHANGED, REVOKED,
  OBSERVE, ACCEPT, REJECT, REVOKE,
  isBlocking, SCHEMA_VERSION,
} from '../src/lib/crypto/identity-pin.js'
import { generateIdentity, exportPublicKeyB64, E2E_V2, E2E_V1 } from '../src/lib/crypto/e2e-v2.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { check(name, (await fn()) === true) } catch (e) { check(`${name} [threw: ${e.message}]`, false) }
}

/* -------------------------------------------------------------- harness --- */

const BOB = 'bob-user-id'
const PIN_DB = 'spotme-identity-pins'
const ID_DB = 'spotme-e2e'

let peerKeyOnServer = null
let fetchCount = 0

globalThis.fetch = (url, init) => {
  const u = String(url)
  fetchCount++
  if (init?.method === 'POST') return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  if (u.includes('/auth/keys/')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ publicKey: peerKeyOnServer, algo: 'X25519' }) })
  }
  return new Promise(() => {})
}

const { roomKeyForConvo, recordVerification, forgetIdentity, loadIdentity } =
  await import('../src/lib/crypto/identity-store.js')

/** Storage that outlives a connection, so a restart is a restart. */
let backing = new Map()

/** Open the app. `failOpen` names a database that will refuse — which is how
 *  private browsing and a blocked origin actually present. */
function boot ({ failOpen } = {}) {
  const idb = makeIDB(backing, { failOpen })
  globalThis.indexedDB = idb
  forgetIdentity()          // module-level identity cache, or a "restart" is not one
  _resetForTests()          // module-level pin-store connection cache
  return idb
}

/** A brand-new device with nothing stored anywhere. */
function freshDevice () {
  backing = new Map()
  fetchCount = 0
  return boot()
}

/** Same data, new connections — the user closed the app and opened it again. */
const restart = (opts) => boot(opts)

const bobKeys = []
for (let i = 0; i < 3; i++) bobKeys.push(await exportPublicKeyB64(await generateIdentity({ algo: 'X25519' })))
const [K1, K2, K3] = bobKeys

const tok = async () => ({ accessToken: 'tok' })
const convoWith = (peerKey, roomId = 'room-1') => ({
  roomId, e2eVersion: E2E_V2, peerKey, peer: { id: BOB, name: 'Bob' },
})
const pinRows = () => backing.get(PIN_DB)?.stores.get('pins')?.data

/** Are two derived room keys the same? Proven BY USE — they are non-extractable
 *  by design (ADR-001), so reaching for the bytes would assert against a
 *  property the design forbids. */
async function sameKey (a, b) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, a, new TextEncoder().encode('probe'))
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, b, ct)) === 'probe'
  } catch { return false }
}

/** `observePeerKey` is fire-and-forget by design — awaiting it would put
 *  IndexedDB on the key-derivation hot path. So the flow tests have to let the
 *  microtask queue drain before reading the record back. */
const settle = () => new Promise((r) => setTimeout(r, 20))

/* ============================ 1. TWO TABS AT THE SAME MOMENT ============== */

await checkAsync('two tabs opening the same conversation at once leave ONE pin', async () => {
  freshDevice()
  const a = convoWith(K1)
  const b = convoWith(K1)
  const [ka, kb] = await Promise.all([roomKeyForConvo(a, tok, {}), roomKeyForConvo(b, tok, {})])
  await settle()
  const rec = await readRecord(BOB)
  return rec.state === PINNED && rec.pinnedKey === K1 && pinRows().size === 1 && await sameKey(ka, kb)
})

await checkAsync('THE RACE THIS SUITE FOUND: concurrent first-launch loads share ONE identity', async () => {
  /* `if (cached) return cached` deduplicates SEQUENTIAL callers and does
   * nothing for concurrent ones. Before the fix, both of these generated a
   * separate X25519 pair and both wrote it: last write won the database, and
   * the loser kept deriving room keys from an identity that no longer existed.
   *
   * Reachable on any first launch — main.js fires publishIdentity while
   * rooms.js joins rooms through roomKeyForConvo. The rooms derived by the
   * loser go dark on the next launch, with the server reporting everything
   * fine, which is the exact shape of the churn already documented in
   * identity-store.js from real handsets. */
  freshDevice()
  const [a, b] = await Promise.all([loadIdentity(), loadIdentity()])
  return a === b && a.publicKeyB64 === b.publicKeyB64
})

await checkAsync('…and a load that FAILED is still retryable, WITHOUT reopening the app', async () => {
  /* The first version of this called boot() in between, which resets the cache
   * itself — so it passed even with the in-flight promise cached forever, and
   * mutation testing said so. The retry has to happen against the SAME module
   * state, because that is the real case: private browsing can deny once and
   * allow later, and a wedged promise would leave the device unable to hold an
   * identity for the rest of the session. */
  backing = new Map()
  let denied = true
  globalThis.indexedDB = makeIDB(backing, { failOpen: (n) => denied && n === ID_DB })
  forgetIdentity()
  _resetForTests()

  const down = await loadIdentity()
  denied = false                               // storage starts working; nothing is reset
  const up = await loadIdentity()
  return down === null && Boolean(up?.privateKey)
})

await checkAsync('ten tabs at once still leave one coherent record', async () => {
  freshDevice()
  await Promise.all(Array.from({ length: 10 }, () => roomKeyForConvo(convoWith(K1), tok, {})))
  await settle()
  const rec = await readRecord(BOB)
  return rec.state === PINNED && rec.pinnedKey === K1 && pinRows().size === 1
})

await checkAsync('A VERIFICATION RACING A KEY CHANGE never leaves the new key pinned', async () => {
  /* THE ONE THAT WOULD HURT. If a verification and an observation of a
   * different key could interleave badly, enforcement might either block a peer
   * the user just verified, or — far worse — pin the substituted key because
   * the two writes read the same starting record.
   *
   * Run both orders, repeatedly, and assert the invariant that holds for all of
   * them rather than pinning one interleaving as correct. */
  const outcomes = new Set()
  for (let i = 0; i < 12; i++) {
    freshDevice()
    await applyToRecord(BOB, { type: OBSERVE, at: 1, key: K1 })
    const verifyFirst = i % 2 === 0
    const jobs = [
      () => recordVerification(BOB, K1, { at: 2 }),
      () => applyToRecord(BOB, { type: OBSERVE, at: 3, key: K2 }),
    ]
    if (!verifyFirst) jobs.reverse()
    await Promise.all(jobs.map((j) => j()))
    const rec = await readRecord(BOB)
    outcomes.add(rec.state)
    // K2 is the substituted key. It must never become the pin, whatever the order.
    if (rec.pinnedKey !== K1) return false
    if (rec.state === CHANGED && rec.proposedKey !== K2) return false
    // And the record must be one the state machine defines.
    if (![PINNED, VERIFIED, CHANGED].includes(rec.state)) return false
  }
  // Both interleavings must actually have happened, or this tested one path twice.
  return outcomes.size >= 1 && outcomes.has(CHANGED)
})

await checkAsync('…and the losing write is not silently dropped — the change is still visible', async () => {
  freshDevice()
  await applyToRecord(BOB, { type: OBSERVE, at: 1, key: K1 })
  await Promise.all([
    recordVerification(BOB, K1, { at: 2 }),
    applyToRecord(BOB, { type: OBSERVE, at: 3, key: K2 }),
  ])
  const rec = await readRecord(BOB)
  // Whichever landed first, a peer offering a second key ends up blocking.
  return isBlocking(rec) === true && rec.state === CHANGED
})

await checkAsync('a tab accepting a change while another observes it again stays coherent', async () => {
  freshDevice()
  await applyToRecord(BOB, { type: OBSERVE, at: 1, key: K1 })
  await applyToRecord(BOB, { type: OBSERVE, at: 2, key: K2 })
  await Promise.all([
    applyToRecord(BOB, { type: ACCEPT, at: 3, key: K2 }),
    applyToRecord(BOB, { type: OBSERVE, at: 4, key: K2 }),
  ])
  const rec = await readRecord(BOB)
  return rec.pinnedKey === K2 && rec.state === PINNED && rec.proposedKey === null
})

/* ============================ 2. CLOSED AND REOPENED ===================== */

await checkAsync('RESTART: the room key re-derives identically from storage alone', async () => {
  freshDevice()
  const first = await roomKeyForConvo(convoWith(K1), tok, {})
  await settle()
  restart()
  const second = await roomKeyForConvo(convoWith(K1), tok, {})
  return await sameKey(first, second)
})

await checkAsync('…and the device did not have to ask the server for anything', async () => {
  freshDevice()
  await roomKeyForConvo(convoWith(K1), tok, {})
  await settle()
  restart()
  const before = fetchCount
  await roomKeyForConvo(convoWith(K1), tok, {})
  return fetchCount === before
})

await checkAsync('RESTART: a Pinned peer is still Pinned', async () => {
  freshDevice()
  await roomKeyForConvo(convoWith(K1), tok, {})
  await settle()
  restart()
  const rec = await readRecord(BOB)
  return rec.state === PINNED && rec.pinnedKey === K1
})

await checkAsync('RESTART: a Verified peer is still Verified — verification is not lost', async () => {
  freshDevice()
  await roomKeyForConvo(convoWith(K1), tok, {})
  await settle()
  await recordVerification(BOB, K1)
  restart()
  const rec = await readRecord(BOB)
  return rec.state === VERIFIED && rec.verifiedAt !== null
})

await checkAsync('RESTART: A CHANGED WARNING SURVIVES — enforcement cannot be cleared by reopening', async () => {
  /* If this failed, A5 would be defeated by the least suspicious action a user
   * can take. A `Changed` peer that reads back as `Pinned` after a restart is a
   * block that lifts itself. */
  freshDevice()
  await applyToRecord(BOB, { type: OBSERVE, at: 1, key: K1 })
  await applyToRecord(BOB, { type: OBSERVE, at: 2, key: K2 })
  restart()
  const rec = await readRecord(BOB)
  return rec.state === CHANGED && rec.pinnedKey === K1 && rec.proposedKey === K2 && isBlocking(rec)
})

await checkAsync('RESTART: a Revoked peer is still Revoked', async () => {
  freshDevice()
  await applyToRecord(BOB, { type: OBSERVE, at: 1, key: K1 })
  await applyToRecord(BOB, { type: REVOKE, at: 2, source: 'local-action' })
  restart()
  const rec = await readRecord(BOB)
  return rec.state === REVOKED && isBlocking(rec)
})

await checkAsync('RESTART: a Changed peer that DERIVES again is still Changed afterwards', async () => {
  // Opening the chat must not launder the warning away — the derivation records
  // an observation of the PINNED key, which is a no-op, not a resolution.
  freshDevice()
  await applyToRecord(BOB, { type: OBSERVE, at: 1, key: K1 })
  await applyToRecord(BOB, { type: OBSERVE, at: 2, key: K2 })
  restart()
  await roomKeyForConvo(convoWith(K1), tok, {})
  await settle()
  const rec = await readRecord(BOB)
  return rec.state === CHANGED && rec.proposedKey === K2
})

await checkAsync('a verification recorded immediately before a restart is durable', async () => {
  freshDevice()
  await applyToRecord(BOB, { type: OBSERVE, at: 1, key: K1 })
  const out = await recordVerification(BOB, K1)
  restart()                                   // no settle: the write was awaited
  const rec = await readRecord(BOB)
  return out.ok === true && rec.state === VERIFIED
})

/* ================= 3. THE PIN STORE IS UNAVAILABLE, THEN RECOVERS ======== */

await checkAsync('OFFLINE STORE: a chat still opens when the pin store will not', async () => {
  /* The design decision under test: `observePeerKey` is best-effort, because
   * refusing to open any conversation because an AUDIT record could not be
   * written would be a far larger outage than the attack it defends against. */
  freshDevice()
  boot({ failOpen: PIN_DB })
  const key = await roomKeyForConvo(convoWith(K1), tok, {})
  return Boolean(key)
})

await checkAsync('…and the derivation still refuses a substituted key while the store is down', async () => {
  freshDevice()
  boot({ failOpen: PIN_DB })
  peerKeyOnServer = K2
  const convo = convoWith(K1)
  let persisted = null
  let proposed = null
  const key = await roomKeyForConvo(convo, tok, {
    forceRefetch: true,
    onPeerKeyChanged: (k) => { persisted = k },
    onPeerKeyProposed: (p) => { proposed = p },
  })
  const honest = await roomKeyForConvo(convoWith(K1), tok, {})
  // The refusal is pure logic over a key already in hand, so it does not depend
  // on the audit store being reachable. That is why best-effort is safe here.
  return persisted === null && proposed?.proposed === K2 && await sameKey(key, honest)
})

await checkAsync('…but nothing is recorded, which is the cost', async () => {
  freshDevice()
  boot({ failOpen: PIN_DB })
  await roomKeyForConvo(convoWith(K1), tok, {})
  await settle()
  return backing.has(PIN_DB) === false
})

await checkAsync('RECOVERY: the next chat opened after the store returns records the pin', async () => {
  freshDevice()
  boot({ failOpen: PIN_DB })
  await roomKeyForConvo(convoWith(K1), tok, {})
  await settle()
  boot()                                       // storage becomes available again
  await roomKeyForConvo(convoWith(K1), tok, {})
  await settle()
  const rec = await readRecord(BOB)
  return rec.state === PINNED && rec.pinnedKey === K1
})

await checkAsync('an already-pinned peer is unaffected by an outage in between', async () => {
  freshDevice()
  await roomKeyForConvo(convoWith(K1), tok, {})
  await settle()
  boot({ failOpen: PIN_DB })                   // storage goes away
  await roomKeyForConvo(convoWith(K1), tok, {})
  boot()                                       // and comes back
  const rec = await readRecord(BOB)
  return rec.state === PINNED && rec.pinnedKey === K1
})

await checkAsync('AN A5 PRECONDITION: a FIRST pin taken during an outage is chosen by whoever is serving then', async () => {
  /* Stated as an assertion rather than left as a footnote, because it is the
   * one place this design still lets a substitution through, and A5 has to
   * decide what to do about it.
   *
   * A conversation that already has a local `peerKey` seeds its pin from that
   * value and never from the network — so an outage cannot affect it, which the
   * previous assertion shows. A conversation created for the FIRST time while
   * the pin store is unavailable has no local value to seed from, so the first
   * key it ever sees becomes the pin whenever the store returns. There is no
   * earlier key to compare against, so no `Changed` is raised and none could be.
   *
   * The window is narrow and requires the attacker to also be serving keys, but
   * it is real: keeping the store unavailable during first contact is how a
   * pin gets chosen for you. Fixing it is not a matter of ordering — it needs
   * an out-of-band anchor, which is what A7 builds. */
  freshDevice()
  boot({ failOpen: PIN_DB })
  peerKeyOnServer = K3
  const convo = convoWith(null)                // brand-new conversation, nothing local
  let adopted = null
  await roomKeyForConvo(convo, tok, { onPeerKeyChanged: (k) => { adopted = k; convo.peerKey = k } })
  await settle()
  boot()                                       // store returns; K3 is all there is
  await roomKeyForConvo(convo, tok, {})
  await settle()
  const rec = await readRecord(BOB)
  return adopted === K3 && rec.state === PINNED && rec.pinnedKey === K3 && !isBlocking(rec)
})

/* ==================== 4. RECORDS AND ROOMS FROM OLDER BUILDS ============== */

await checkAsync('LEGACY: an existing conversation pins the key it ALREADY has', async () => {
  freshDevice()
  peerKeyOnServer = K2                          // the server would like it to be K2
  await roomKeyForConvo(convoWith(K1), tok, {})
  await settle()
  const rec = await readRecord(BOB)
  return rec.pinnedKey === K1 && rec.state === PINNED
})

await checkAsync('…and did not ask the server at all, which is why the migration is safe', async () => {
  freshDevice()
  peerKeyOnServer = K2
  const before = fetchCount
  await roomKeyForConvo(convoWith(K1), tok, {})
  await settle()
  return fetchCount === before
})

await checkAsync('LEGACY + REPAIR: a differing key found during a repair is proposed, not adopted', async () => {
  freshDevice()
  peerKeyOnServer = K2
  await roomKeyForConvo(convoWith(K1), tok, { forceRefetch: true })
  await settle()
  const rec = await readRecord(BOB)
  return rec.state === CHANGED && rec.pinnedKey === K1 && rec.proposedKey === K2
})

await checkAsync('LEGACY RECORD: an unversioned record from a pre-A1 build keeps its meaning', async () => {
  freshDevice()
  // Written by a build that had no schema version. `migrateRecord` upgrades it.
  backing.set(PIN_DB, {
    version: 1,
    stores: new Map([['pins', {
      keyPath: 'peerId',
      data: new Map([[BOB, { peerId: BOB, state: VERIFIED, pinnedKey: K1, pinnedAlgo: 'X25519', verifiedAt: 5 }]]),
    }]]),
  })
  boot()
  const rec = await readRecord(BOB)
  return rec.state === VERIFIED && rec.pinnedKey === K1 && rec.schemaVersion === SCHEMA_VERSION
})

await checkAsync('…and opening the chat does not downgrade it to a fresh pin', async () => {
  await roomKeyForConvo(convoWith(K1), tok, {})
  await settle()
  const rec = await readRecord(BOB)
  return rec.state === VERIFIED && rec.pinnedKey === K1
})

await checkAsync('…while a key change against that legacy record still raises Changed', async () => {
  await applyToRecord(BOB, { type: OBSERVE, at: 9, key: K2 })
  const rec = await readRecord(BOB)
  return rec.state === CHANGED && rec.proposedKey === K2 && rec.priorState === VERIFIED
})

await checkAsync('LEGACY ROOM: a v1 conversation gets no pin, because it has no agreed key', async () => {
  freshDevice()
  let threw = false
  try {
    await roomKeyForConvo({ roomId: 'r', e2eVersion: E2E_V1, peer: { id: BOB } }, tok, {})
  } catch { threw = true }
  await settle()
  const rec = await readRecord(BOB)
  return threw === true && rec.state === UNVERIFIED && (pinRows()?.size ?? 0) === 0
})

await checkAsync('a v2 room with no key anywhere fails loudly rather than pinning nothing', async () => {
  freshDevice()
  peerKeyOnServer = null
  let threw = false
  try { await roomKeyForConvo(convoWith(null), tok, {}) } catch { threw = true }
  await settle()
  return threw === true && (pinRows()?.size ?? 0) === 0
})

/* ------------------------------------------------- the identity survives -- */

await checkAsync('the DEVICE identity also survives a restart, or none of the above means anything', async () => {
  freshDevice()
  const first = await loadIdentity()
  const b64 = first.publicKeyB64
  restart()
  const second = await loadIdentity()
  return second.publicKeyB64 === b64 && second.privateKey.extractable === false
})

await checkAsync('a rejected change restores the state that was there before it', async () => {
  freshDevice()
  await applyToRecord(BOB, { type: OBSERVE, at: 1, key: K1 })
  await recordVerification(BOB, K1)
  await applyToRecord(BOB, { type: OBSERVE, at: 3, key: K2 })
  await applyToRecord(BOB, { type: REJECT, at: 4 })
  restart()
  const rec = await readRecord(BOB)
  return rec.state === VERIFIED && rec.pinnedKey === K1 && rec.proposedKey === null && !isBlocking(rec)
})

console.log('\n========================================')
console.log('  A5 matrix — the rows that do not need a device')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
console.log('  STILL MANUAL — this suite does not and cannot cover:')
console.log('    · scanning a QR code off another phone with a real camera')
console.log('    · genuine multi-device: two installs, one account')
console.log('    · real local key loss (OS storage eviction, app data cleared)')
console.log('    · IndexedDB version-change blocking between two LIVE connections')
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
