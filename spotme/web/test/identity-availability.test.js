/**
 * Proves the server can say "unreachable" and never "untrusted".
 *
 * THE ATTACK THIS FORBIDS. A server that could set a peer's identity state to
 * Revoked would have a path back to a fresh pin:
 *
 *     Revoked -> clearRevocation -> Unverified -> observe -> Pinned
 *
 * One API response, and the trust anchor for a conversation is replaced. That
 * is the same substitution the whole identity sequence exists to stop, reached
 * through a different door — and it would look like an ordinary account status
 * change while it happened.
 *
 * So availability is a second axis with its own module, and the assertions
 * below are mostly one shape: after the server has said whatever it likes,
 * every identity field is byte-identical. Blocking a conversation and
 * distrusting a key are different claims, and only one of them is the server's
 * to make.
 *
 * THE SPLIT IS ALSO TESTED. Unreachable and ServerDisabled both stop sending
 * and are otherwise opposites: one should be retried behind "still trying",
 * the other is terminal policy where retrying hammers an endpoint that will
 * keep refusing and the user is told to wait for a connection that was never
 * the problem.
 *
 *   node test/identity-availability.test.js
 */
import {
  applyAvailability, availabilityOf, shouldRetry, blocksSending, availabilityMessage,
  AVAILABLE, SERVER_DISABLED, UNREACHABLE, AVAILABILITY, AVAILABILITY_SOURCE, AVAIL_ERR,
} from '../src/lib/crypto/identity-availability.js'
import {
  applyEvent, emptyRecord, isBlocking,
  OBSERVE, VERIFY, REVOKE, PINNED, VERIFIED, CHANGED, REVOKED, UNVERIFIED,
} from '../src/lib/crypto/identity-pin.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { check(name, (await fn()) === true) } catch (e) { check(`${name} [threw: ${e.message}]`, false) }
}

const key = (b) => btoa(String.fromCharCode(...new Array(32).fill(b)))
const K1 = key(1)
const K2 = key(2)

/** Every field that belongs to the TRUST axis. Availability must not move one. */
const IDENTITY_FIELDS = [
  'state', 'pinnedKey', 'pinnedAlgo', 'proposedKey', 'proposedAlgo', 'priorState',
  'changeSource', 'changeReason', 'pinnedAt', 'verifiedAt', 'changedAt', 'revocation',
]
const identityOf = (rec) => JSON.stringify(IDENTITY_FIELDS.map((f) => rec[f]))

/* ---------------------------------------------- 1. the axis is separate --- */

{
  // Build one record of every interesting identity state.
  const pinned = applyEvent(emptyRecord('p'), { type: OBSERVE, at: 1, key: K1 }).next
  const verified = applyEvent(pinned, { type: VERIFY, at: 2, key: K1 }).next
  const changed = applyEvent(verified, { type: OBSERVE, at: 3, key: K2 }).next
  const revoked = applyEvent(pinned, { type: REVOKE, at: 4, source: 'local-action' }).next
  const states = { UNVERIFIED: emptyRecord('p'), PINNED: pinned, VERIFIED: verified, CHANGED: changed, REVOKED: revoked }

  let allHeld = true
  for (const [label, rec] of Object.entries(states)) {
    for (const status of AVAILABILITY) {
      const before = identityOf(rec)
      const out = applyAvailability(rec, { at: 10, status, reason: 'whatever the server says' })
      if (!out.ok || identityOf(out.next) !== before) {
        check(`${label} survives the server asserting ${status}`, false)
        allHeld = false
      }
    }
  }
  check(
    `THE INVARIANT: every identity field survives every server assertion, ` +
    `across all ${Object.keys(states).length} states x ${AVAILABILITY.length} statuses`,
    allHeld,
  )

  // The three that would actually be exploitable, called out by name.
  const disabled = (rec) => applyAvailability(rec, { at: 11, status: SERVER_DISABLED }).next
  check('a server assertion cannot reach Revoked', disabled(pinned).state === PINNED)
  check('a server assertion cannot drop a pin', disabled(verified).pinnedKey === K1)
  check('a server assertion cannot clear a Changed warning',
    disabled(changed).state === CHANGED && disabled(changed).proposedKey === K2)
  check('…nor discard a verification', disabled(verified).state === VERIFIED)
  check('…nor resurrect a revoked identity',
    applyAvailability(revoked, { at: 12, status: AVAILABLE }).next.state === REVOKED)
}

/* ------------------------------------------- 2. the split, and its point -- */

{
  const rec = emptyRecord('p')
  const unreachable = applyAvailability(rec, { at: 1, status: UNREACHABLE }).next
  const disabled = applyAvailability(rec, { at: 1, status: SERVER_DISABLED }).next

  check('both statuses stop sending — that is what they share',
    blocksSending(unreachable) && blocksSending(disabled))
  check('…and Available does not', !blocksSending(rec))

  check('THE SPLIT: a transient fault is retried', shouldRetry(unreachable) === true)
  check('…and a deliberate deactivation is NOT — no hammering a terminal answer',
    shouldRetry(disabled) === false)

  check('the two say different things to the user',
    availabilityMessage(unreachable) !== availabilityMessage(disabled))
  check('a reachable peer has nothing to say', availabilityMessage(rec) === null)
  check('neither message interpolates the server\'s untrusted reason text', (() => {
    const evil = applyAvailability(rec, { at: 1, status: SERVER_DISABLED, reason: '<script>x</script>' }).next
    return !String(availabilityMessage(evil)).includes('<script>')
  })())
}

/* ------------------------------------------------------- 3. provenance --- */

{
  const out = applyAvailability(emptyRecord('p'), {
    at: 99, status: SERVER_DISABLED, reason: 'account closed',
  })
  check('the status records its source, and it is never anything stronger',
    out.next.availability.source === AVAILABILITY_SOURCE)
  check('…with the server\'s reason kept for display', out.next.availability.reason === 'account closed')
  check('…and a timestamp', out.next.availability.at === 99)
  check('a non-string reason is dropped rather than stored as an object',
    applyAvailability(emptyRecord('p'), { at: 1, status: AVAILABLE, reason: { a: 1 } })
      .next.availability.reason === null)

  check('an unknown status is a defined error, not a stored value',
    applyAvailability(emptyRecord('p'), { at: 1, status: 'Whatever' }).error?.code === AVAIL_ERR.UNKNOWN_STATUS)
  check('an event with no `at` is refused',
    applyAvailability(emptyRecord('p'), { status: AVAILABLE }).error?.code === AVAIL_ERR.BAD_EVENT)
  check('applyAvailability never throws on rubbish',
    applyAvailability(null, null).ok === false)

  check('re-asserting the same status reports changed:false so a write can be skipped',
    applyAvailability(out.next, { at: 99, status: SERVER_DISABLED, reason: 'account closed' }).changed === false)
  check('a different status reports changed:true',
    applyAvailability(out.next, { at: 100, status: AVAILABLE }).changed === true)
  check('applyAvailability does not mutate its input',
    (() => {
      const rec = emptyRecord('p')
      const snapshot = JSON.stringify(rec)
      applyAvailability(rec, { at: 1, status: UNREACHABLE })
      return JSON.stringify(rec) === snapshot
    })())
}

/* --------------------------------- 4. the two axes are read separately --- */

{
  const pinned = applyEvent(emptyRecord('p'), { type: OBSERVE, at: 1, key: K1 }).next
  const changed = applyEvent(pinned, { type: OBSERVE, at: 2, key: K2 }).next

  // A5 will need BOTH answers, and they are genuinely independent.
  const reachableButUntrusted = applyAvailability(changed, { at: 3, status: AVAILABLE }).next
  const trustedButUnreachable = applyAvailability(pinned, { at: 3, status: UNREACHABLE }).next

  check('a reachable peer can still be untrusted',
    !blocksSending(reachableButUntrusted) && isBlocking(reachableButUntrusted))
  check('an unreachable peer can still be trusted',
    blocksSending(trustedButUnreachable) && !isBlocking(trustedButUnreachable))
  check('availabilityOf defaults to Available — silence is not a fault',
    availabilityOf(emptyRecord('p')) === AVAILABLE && availabilityOf(null) === AVAILABLE)
}

/* -------------------------------------------------- 5. it is persisted --- */

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
  return { rows, open () { const req = { result: db }; queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.() }); return req } }
}

const idb = fakeIDB()
globalThis.indexedDB = idb
const { applyToRecord, setAvailability, readRecord } =
  await import('../src/lib/crypto/identity-pin-store.js')

await checkAsync('an availability report is persisted', async () => {
  await applyToRecord('bob', { type: OBSERVE, at: 1, key: K1 })
  const out = await setAvailability('bob', { at: 2, status: SERVER_DISABLED, reason: 'closed' })
  return out.ok === true && idb.rows.get('bob').availability.status === SERVER_DISABLED
})

await checkAsync('…and it did NOT disturb the stored identity state', async () => {
  const rec = await readRecord('bob')
  return rec.state === PINNED && rec.pinnedKey === K1
})

await checkAsync('THE STORED INVARIANT: a server report leaves a Changed record Changed', async () => {
  await applyToRecord('carol', { type: OBSERVE, at: 1, key: K1 })
  await applyToRecord('carol', { type: OBSERVE, at: 2, key: K2 })
  const before = identityOf(idb.rows.get('carol'))
  await setAvailability('carol', { at: 3, status: SERVER_DISABLED, reason: 'nice try' })
  return identityOf(idb.rows.get('carol')) === before &&
    idb.rows.get('carol').availability.status === SERVER_DISABLED
})

await checkAsync('a refused availability report writes nothing', async () => {
  await applyToRecord('dave', { type: OBSERVE, at: 1, key: K1 })
  const before = JSON.stringify(idb.rows.get('dave'))
  const out = await setAvailability('dave', { at: 2, status: 'Nonsense' })
  return out.ok === false && JSON.stringify(idb.rows.get('dave')) === before
})

await checkAsync('availability survives a read-back through migration', async () => {
  const rec = await readRecord('bob')
  return rec.availability.status === SERVER_DISABLED && rec.availability.source === AVAILABILITY_SOURCE
})

await checkAsync('a peer with no report reads as Available, not broken', async () => {
  return availabilityOf(await readRecord('nobody')) === AVAILABLE &&
    (await readRecord('nobody')).state === UNVERIFIED
})

console.log('\n========================================')
console.log('  identity availability — the server\'s axis, and only that one')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
