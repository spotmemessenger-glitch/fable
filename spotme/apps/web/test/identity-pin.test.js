/**
 * Proves the identity trust state machine is TOTAL and that a substituted key
 * never becomes the trusted one.
 *
 * WHY THIS SUITE IS EXHAUSTIVE RATHER THAN ILLUSTRATIVE. This machine's whole
 * job is to be the thing that does not have a hole in it. A transition table
 * tested by example passes with a missing case; the missing case is then a
 * silent no-op, and a silent no-op in a TRUST decision reads to the caller as
 * "recorded" when it means "ignored". So every (state, event) pair is driven,
 * and every one of them must produce either a defined next state or a defined
 * error code — never an exception, never undefined.
 *
 * THE ASSERTION THAT MATTERS MOST is that `pinnedKey` survives an observation
 * of a different key. That is the exact hole in the shipped code today:
 * `rooms.js` writes whatever `roomKeyForConvo` re-fetched straight over
 * `convo.peerKey`, so a server able to provoke a decrypt failure can provoke a
 * key rotation and have it adopted with no trace. If that check ever passes
 * while the pin moved, this module is decorative.
 *
 * Pure module, no IndexedDB, no clock, no mocks.
 *
 *   node test/identity-pin.test.js
 */
import {
  applyEvent, emptyRecord, migrateRecord,
  STATES, EVENTS, ERR, HISTORY_LIMIT, SCHEMA_VERSION,
  UNVERIFIED, PINNED, VERIFIED, CHANGED, REVOKED,
  OBSERVE, VERIFY, ACCEPT, REJECT, REVOKE, CLEAR_REVOCATION,
  isVerified, isBlocking, trustedKey, canonicalKey, algoOf,
} from '../src/lib/crypto/identity-pin.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

/** Safe unwrap. A REJECTED transition returns `{ ok: false, error }` with no
 *  `next`, so `nx(x).state` throws and aborts the run — hiding every other
 *  result behind a stack trace. Under mutation that is exactly when the output
 *  matters most, so every field read goes through this. */
const nx = (r) => (r && r.next) || {}

/** Real 32-byte X25519-length keys. The machine canonicalises and
 *  length-checks, so placeholder strings are no longer valid input.
 *
 *  K1's bytes are chosen so its base64 contains BOTH `+` and `/` and needs
 *  padding — otherwise the base64url and unpadded normalisation tests below
 *  would have nothing to normalise and would pass without exercising the path.
 *  The fixture asserts that itself, a few lines down. */
const key = (b) => btoa(String.fromCharCode(...new Array(32).fill(b)))
const PLUS_AND_SLASH = [0xFB, 0xEF, 0xBE, 0xFF, 0xFF, 0xFF]
const K1 = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => PLUS_AND_SLASH[i % 6])))
const K2 = key(2)
const K3 = key(3)

let clock = 0
const at = () => ++clock

/** Drive a record into each state, so every state can be a starting point. */
const build = {
  [UNVERIFIED]: () => emptyRecord('peer'),
  [PINNED]: () => applyEvent(emptyRecord('peer'), { type: OBSERVE, at: at(), key: K1 }).next,
  [VERIFIED]: () => applyEvent(build[PINNED](), { type: VERIFY, at: at(), key: K1 }).next,
  [CHANGED]: () => applyEvent(build[PINNED](), { type: OBSERVE, at: at(), key: K2 }).next,
  [REVOKED]: () => applyEvent(build[PINNED](), { type: REVOKE, at: at(), source: 'local-action' }).next,
}

/* ------------------------------------------- 1. the machine is TOTAL ----- */

{
  // Every state reachable, and each builder actually produces what it claims.
  for (const s of STATES) check(`${s} is reachable`, build[s]().state === s)

  const evFor = (type) => ({
    [OBSERVE]: { type, at: at(), key: K3 },
    [VERIFY]: { type, at: at(), key: K3 },
    [ACCEPT]: { type, at: at() },
    [REJECT]: { type, at: at() },
    [REVOKE]: { type, at: at(), source: 'local-action' },
    [CLEAR_REVOCATION]: { type, at: at() },
  })[type]

  // EVERY pair gets its OWN named assertion. An aggregate count would report
  // "30/30 well formed" while hiding WHICH pair regressed, and a table this
  // small has no excuse for that.
  let totalPairs = 0
  for (const s of STATES) {
    for (const e of EVENTS) {
      totalPairs++
      let out
      try {
        out = applyEvent(build[s](), evFor(e))
      } catch (err) {
        out = { threw: err.message }
      }
      const defined = out && !out.threw && (
        (out.ok === true && STATES.includes(out.next?.state)) ||
        (out.ok === false && typeof out.error?.code === 'string' && out.error.code in ERR)
      )
      const outcome = out?.threw ? `THREW ${out.threw}`
        : out?.ok ? `-> ${out.next?.state}`
          : `-> ${out?.error?.code}`
      check(`${s} x ${e} ${outcome}`, defined)
    }
  }
  check(`the table is complete: ${totalPairs} pairs = ${STATES.length} states x ${EVENTS.length} events`,
    totalPairs === STATES.length * EVENTS.length)

  // Malformed input is refused rather than crashing or being half-applied.
  check('an unknown event type is a defined error',
    applyEvent(emptyRecord('p'), { type: 'nonsense', at: at() }).error?.code === ERR.UNKNOWN_EVENT)
  check('an event with no numeric `at` is refused',
    applyEvent(emptyRecord('p'), { type: OBSERVE, key: K1 }).error?.code === ERR.UNKNOWN_EVENT)
  check('a record with a bogus state is refused',
    applyEvent({ state: 'Whatever', history: [] }, { type: OBSERVE, at: at(), key: K1 })
      .error?.code === ERR.UNKNOWN_STATE)
  check('observe with no key is refused',
    applyEvent(emptyRecord('p'), { type: OBSERVE, at: at() }).error?.code === ERR.MISSING_KEY)
}

/* ------------------------------------------ 1b. one canonical encoding --- */

{
  // Two spellings of the SAME key must not read as a substitution. If they did,
  // a peer who did nothing would trigger a MITM warning — and a warning that
  // fires on innocent input is one users learn to click through.
  const std = K1
  check('the fixture key actually contains +, / and padding to normalise',
    std.includes('+') && std.includes('/') && std.endsWith('='))
  const urlSafe = std.replace(/\+/g, '-').replace(/\//g, '_')
  const unpadded = std.replace(/=+$/, '')
  const spaced = std.slice(0, 10) + '\n  ' + std.slice(10)

  const pinned = applyEvent(emptyRecord('p'), { type: OBSERVE, at: at(), key: std }).next
  for (const [label, variant] of [
    ['base64url', urlSafe], ['unpadded', unpadded], ['whitespace', spaced],
  ]) {
    const out = applyEvent(pinned, { type: OBSERVE, at: at(), key: variant })
    check(`a ${label} spelling of the pinned key is NOT a change`, nx(out).state === PINNED)
  }
  check('verification accepts a differently-spelled form of the pinned key',
    nx(applyEvent(pinned, { type: VERIFY, at: at(), key: urlSafe })).state === VERIFIED)
  check('the stored pin is the canonical form, not whatever spelling arrived',
    applyEvent(emptyRecord('p'), { type: OBSERVE, at: at(), key: urlSafe }).next.pinnedKey === std)

  // Length-checked against the curves this app actually issues.
  check('a key of the wrong length is refused, not pinned',
    applyEvent(emptyRecord('p'), { type: OBSERVE, at: at(), key: btoa('short') })
      .error?.code === ERR.MALFORMED_KEY)
  check('a non-base64 key is refused, not pinned',
    applyEvent(emptyRecord('p'), { type: OBSERVE, at: at(), key: '!!!not base64!!!' })
      .error?.code === ERR.MALFORMED_KEY)
  check('a malformed key cannot be used to verify either',
    applyEvent(build[PINNED](), { type: VERIFY, at: at(), key: 'nonsense' })
      .error?.code === ERR.MALFORMED_KEY)
  check('canonicalKey() reports the algorithm implied by the length',
    algoOf(K1) === 'X25519' && algoOf(btoa('short')) === null)
  check('canonicalKey() is idempotent',
    canonicalKey(canonicalKey(urlSafe)) === canonicalKey(urlSafe))
}

/* -------------------------------------------- 1c. change provenance ------ */

{
  const out = applyEvent(build[PINNED](), {
    type: OBSERVE, at: at(), key: K2,
    source: 'server-refetch', reason: 'decrypt failure self-heal',
  })
  check('a change records WHO reported it', nx(out).changeSource === 'server-refetch')
  check('a change records WHY they were asking', nx(out).changeReason === 'decrypt failure self-heal')
  check('a change records WHEN it was detected', typeof nx(out).changedAt === 'number')
  check('a change records the PRIOR trust level as provenance', nx(out).priorState === PINNED)

  // Provenance is what rejection reads. It must not be inferred later.
  const resolved = applyEvent(nx(out), { type: REJECT, at: at() })
  check('resolving a change clears its provenance rather than leaving it stale',
    nx(resolved).changeSource === null && nx(resolved).changeReason === null &&
    nx(resolved).changedAt === null)

  // A record whose provenance was lost must not be upgraded to Verified.
  const noProvenance = { ...build[CHANGED](), priorState: null }
  check('rejection with NO recorded provenance falls back to Pinned, never Verified',
    nx(applyEvent(noProvenance, { type: REJECT, at: at() })).state === PINNED)
  const bogus = { ...build[CHANGED](), priorState: 'Whatever' }
  check('rejection with a bogus prior state falls back to Pinned',
    nx(applyEvent(bogus, { type: REJECT, at: at() })).state === PINNED)
}

/* ---------------------------------- 2. the pin does not move on its own -- */

{
  const pinned = build[PINNED]()
  const r = applyEvent(pinned, { type: OBSERVE, at: at(), key: K2 })
  check('a different key moves the state to Changed', nx(r).state === CHANGED)
  check('THE PIN IS NOT OVERWRITTEN by a different key', nx(r).pinnedKey === K1)
  check('the different key is recorded only as a proposal', nx(r).proposedKey === K2)
  check('trustedKey() still returns the PINNED key, never the proposal', trustedKey(r.next) === K1)

  const verified = build[VERIFIED]()
  const v = applyEvent(verified, { type: OBSERVE, at: at(), key: K2 })
  check('a change from Verified remembers it was Verified', nx(v).priorState === VERIFIED)
  check('a change from Verified does not overwrite the pin either', nx(v).pinnedKey === K1)

  // Sticky: seeing the pinned key again must NOT quietly clear the warning,
  // or an attacker could substitute, be seen, revert, and erase the evidence.
  const back = applyEvent(r.next, { type: OBSERVE, at: at(), key: K1 })
  check('Changed is STICKY — re-observing the pinned key does not clear it',
    nx(back).state === CHANGED)
  check('a no-op observation reports changed:false so callers can skip a write',
    back.changed === false)

  const third = applyEvent(r.next, { type: OBSERVE, at: at(), key: K3 })
  check('a second different key replaces the proposal, still not the pin',
    nx(third).proposedKey === K3 && nx(third).pinnedKey === K1)
}

/* -------------------------------------- 3. resolving a change explicitly - */

{
  const changed = build[CHANGED]()

  const acc = applyEvent(changed, { type: ACCEPT, at: at() })
  check('accept moves the proposal into the pin', nx(acc).pinnedKey === K2)
  check('accept lands on Pinned, NOT Verified', nx(acc).state === PINNED)
  check('accept clears any previous verification timestamp', nx(acc).verifiedAt === null)

  const rej = applyEvent(changed, { type: REJECT, at: at() })
  check('reject keeps the pinned key', nx(rej).pinnedKey === K1)
  check('reject drops the proposal', nx(rej).proposedKey === null)
  check('reject from a Pinned origin returns to Pinned', nx(rej).state === PINNED)

  const fromVerified = applyEvent(build[VERIFIED](), { type: OBSERVE, at: at(), key: K2 }).next
  const rejV = applyEvent(fromVerified, { type: REJECT, at: at() })
  check('reject RESTORES Verified rather than silently downgrading to Pinned',
    nx(rejV).state === VERIFIED)

  // Verification is stronger evidence than acceptance, so it may go further.
  const verProposed = applyEvent(changed, { type: VERIFY, at: at(), key: K2 })
  check('verifying the PROPOSED key adopts it and marks it Verified',
    nx(verProposed).state === VERIFIED && nx(verProposed).pinnedKey === K2)
  const verPinned = applyEvent(changed, { type: VERIFY, at: at(), key: K1 })
  check('verifying the PINNED key resolves the change in the pin\'s favour',
    nx(verPinned).state === VERIFIED && nx(verPinned).pinnedKey === K1)
  check('verifying an unrelated key while Changed is a defined mismatch error',
    applyEvent(changed, { type: VERIFY, at: at(), key: K3 }).error?.code === ERR.KEY_MISMATCH)
}

/* ------------------------------------------------- 4. verification rules - */

{
  check('verifying with nothing pinned is a defined error',
    applyEvent(emptyRecord('p'), { type: VERIFY, at: at(), key: K1 }).error?.code === ERR.NO_PIN)
  check('verifying a key that is not the pin is a defined error',
    applyEvent(build[PINNED](), { type: VERIFY, at: at(), key: K2 }).error?.code === ERR.KEY_MISMATCH)

  const v = applyEvent(build[PINNED](), { type: VERIFY, at: at(), key: K1 })
  check('verifying the pinned key reaches Verified', nx(v).state === VERIFIED)
  check('isVerified() is true only in Verified',
    isVerified(v.next) && !isVerified(build[PINNED]()) && !isVerified(build[CHANGED]()))
  check('re-verifying is accepted and reports changed:false',
    applyEvent(v.next, { type: VERIFY, at: at(), key: K1 }).changed === false)
}

/* --------------------------------------------------- 5. revocation rules - */

{
  // The correction that matters: a server assertion is not cryptographic proof.
  const serverSaysSo = applyEvent(build[PINNED](), {
    type: REVOKE, at: at(), source: 'server-assertion', reason: 'account disabled',
  })
  check('a SERVER ASSERTION cannot revoke an identity', serverSaysSo.ok === false)
  check('and it fails with a defined error rather than being ignored',
    serverSaysSo.error?.code === ERR.UNKNOWN_EVENT)

  const local = applyEvent(build[VERIFIED](), {
    type: REVOKE, at: at(), source: 'local-action', reason: 'user revoked',
  })
  check('a trusted local action CAN revoke', nx(local).state === REVOKED)
  check('revocation records its source', nx(local).revocation.source === 'local-action')
  check('revocation records a reason and a timestamp',
    nx(local).revocation.reason === 'user revoked' && typeof nx(local).revocation.at === 'number')

  const revoked = build[REVOKED]()
  check('trustedKey() returns null once revoked', trustedKey(revoked) === null)
  check('observing a key while revoked does not re-trust it',
    applyEvent(revoked, { type: OBSERVE, at: at(), key: K2 }).next.state === REVOKED)
  check('verifying while revoked is a defined error',
    applyEvent(revoked, { type: VERIFY, at: at(), key: K1 }).error?.code === ERR.REVOKED)
  check('accepting while revoked is a defined error',
    applyEvent(revoked, { type: ACCEPT, at: at() }).error?.code === ERR.REVOKED)

  const cleared = applyEvent(revoked, { type: CLEAR_REVOCATION, at: at() })
  check('clearing a revocation is possible, so a mistake is recoverable',
    nx(cleared).state === UNVERIFIED)
  check('clearing does NOT silently restore the old pin', nx(cleared).pinnedKey === null)
  check('clearing keeps the history so the revocation is still auditable',
    nx(cleared).history.length > 0)
  check('clearing when not revoked is a defined error',
    applyEvent(build[PINNED](), { type: CLEAR_REVOCATION, at: at() }).error?.code === ERR.NOT_REVOKED)

  check('isBlocking() covers exactly Changed and Revoked',
    isBlocking(build[CHANGED]()) && isBlocking(build[REVOKED]()) &&
    !isBlocking(build[PINNED]()) && !isBlocking(build[VERIFIED]()) &&
    !isBlocking(build[UNVERIFIED]()))
}

/* ------------------------------------------------------- 6. immutability - */

{
  const before = build[PINNED]()
  const snapshot = JSON.stringify(before)
  const out = applyEvent(before, { type: OBSERVE, at: at(), key: K2 })
  check('applyEvent does not mutate the record it was given',
    JSON.stringify(before) === snapshot)
  check('and returns a distinct object', out.next !== before)
  check('history is copied, not shared',
    nx(out).history !== before.history)
}

/* ----------------------------------------------------------- 7. history -- */

{
  let rec = emptyRecord('p')
  for (let i = 0; i < HISTORY_LIMIT + 25; i++) {
    rec = applyEvent(rec, { type: OBSERVE, at: at(), key: K1 }).next
  }
  check(`history is bounded at ${HISTORY_LIMIT} rather than growing forever`,
    rec.history.length === HISTORY_LIMIT)
  check('the bound drops the OLDEST entries, keeping recent ones',
    rec.history[rec.history.length - 1].at > rec.history[0].at)

  const noSecrets = JSON.stringify(build[REVOKED]())
  check('a serialised record contains no private key material',
    !/privateKey|secret|deriveBits/i.test(noSecrets))
}

/* ---------------------------------------------------------- 8. migration - */

{
  check('a null record migrates to a fresh one',
    migrateRecord(null, 'p').state === UNVERIFIED)
  check('a non-object migrates to a fresh one',
    migrateRecord('garbage', 'p').state === UNVERIFIED)

  const v0 = { state: PINNED, key: K1, algo: 'X25519', history: [] }
  const up = migrateRecord(v0, 'p')
  check('an unversioned record is upgraded, not discarded', up.state === PINNED)
  check('the upgrade maps the old key field onto pinnedKey', up.pinnedKey === K1)
  check('the upgrade stamps the current schema version', up.schemaVersion === SCHEMA_VERSION)

  const future = { schemaVersion: SCHEMA_VERSION + 1, state: VERIFIED, pinnedKey: K1 }
  const fwd = migrateRecord(future, 'p')
  check('a record from a NEWER build is not downgraded into false trust',
    fwd.state === UNVERIFIED && fwd.unreadable === true)

  const incoherent = { schemaVersion: SCHEMA_VERSION, state: VERIFIED, pinnedKey: null }
  check('a record claiming trust with no key it trusts is discarded',
    migrateRecord(incoherent, 'p').state === UNVERIFIED)

  const badState = { schemaVersion: SCHEMA_VERSION, state: 'Bogus', pinnedKey: K1 }
  check('a record with an unknown state is discarded',
    migrateRecord(badState, 'p').state === UNVERIFIED)

  const ok = { ...build[VERIFIED](), peerId: 'p' }
  const round = migrateRecord(JSON.parse(JSON.stringify(ok)), 'p')
  check('a current record round-trips through migration unchanged',
    round.state === VERIFIED && round.pinnedKey === K1)
}

/* ------------------------------------------- 9. no dormant side effects --- */

{
  // Importing must not have opened a database, registered a listener or set a
  // timer. This is the condition attached to landing an unreferenced module.
  check('importing the module did not touch indexedDB',
    typeof globalThis.indexedDB === 'undefined')
  // Both runs must start from the SAME record — building two with the
  // incrementing test clock would differ by construction and prove nothing.
  const fixed = applyEvent(emptyRecord('p'), { type: OBSERVE, at: 100, key: K1 }).next
  const runA = JSON.stringify(nx(applyEvent(fixed, { type: OBSERVE, at: 999, key: K2 })))
  const runB = JSON.stringify(nx(applyEvent(fixed, { type: OBSERVE, at: 999, key: K2 })))
  check('the module reads no clock of its own — same input, same output', runA === runB)
}

console.log('\n========================================')
console.log('  identity pinning — trust state machine')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
