/**
 * Proves A5 blocks the right things, for stated reasons, and is OFF.
 *
 * THREE CLAIMS, AND THE THIRD IS THE ONE THAT USUALLY ROTS:
 *
 *   1. a Changed or Revoked peer is refused, and an ordinary one is not
 *   2. every refusal names what would clear it — a block with no next step is
 *      an outage with extra words
 *   3. THE FLAG DOES NOT SKIP THE CODE IT GATES. With enforcement off the full
 *      verdict is still computed and reported as advisory. A flag that
 *      short-circuits means the enforcement path first runs in anger on the day
 *      it is switched on, which is the worst possible day to discover it is
 *      wrong. So the assertions below check the VERDICT with the flag off, not
 *      just `allowed`.
 *
 * Also pinned here: an unavailable pin store is NOT a block. That reverses what
 * ADR-005 §7 anticipated, and the reason is in the module header — with the
 * store down the substitution is still refused, so blocking would cost every
 * private-browsing user their messaging and buy nothing.
 *
 *   node test/identity-enforcement.test.js
 */
import { readFileSync } from 'node:fs'
import {
  sendDecision, setRoomTrust, markKeyProposed, roomDecision, maySend,
  clearRoomTrust, forgetAllTrust, setEnforcement, isEnforcing,
  setBlockedSendHandler, reportBlocked,
  SEND, NEEDS,
} from '../src/lib/crypto/identity-enforcement.js'
import {
  applyEvent, emptyRecord, OBSERVE, VERIFY, REVOKE, ACCEPT, REJECT,
  PINNED, VERIFIED, CHANGED,
} from '../src/lib/crypto/identity-pin.js'
import {
  applyAvailability, AVAILABLE, SERVER_DISABLED, UNREACHABLE,
} from '../src/lib/crypto/identity-availability.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const key = (b) => btoa(String.fromCharCode(...new Array(32).fill(b)))
const K1 = key(1)
const K2 = key(2)

const pinned = applyEvent(emptyRecord('p'), { type: OBSERVE, at: 1, key: K1 }).next
const verified = applyEvent(pinned, { type: VERIFY, at: 2, key: K1 }).next
const changed = applyEvent(verified, { type: OBSERVE, at: 3, key: K2 }).next
const revoked = applyEvent(pinned, { type: REVOKE, at: 4, source: 'local-action' }).next
const avail = (rec, status) => applyAvailability(rec, { at: 9, status }).next

/* ------------------------------------------- 1. it is OFF, and stays off -- */

check('THE FLAG IS OFF BY DEFAULT — nothing in this change alters behaviour',
  isEnforcing() === false)

check('…so a Changed peer can still be messaged today',
  sendDecision(changed).allowed === true)

check('…and that is reported as ADVISORY, not as fine',
  sendDecision(changed).advisory === true && sendDecision(pinned).advisory === false)

check('THE VERDICT IS STILL COMPUTED WITH THE FLAG OFF — the path is exercised',
  sendDecision(changed).verdict === SEND.BLOCKED_CHANGED &&
  sendDecision(revoked).verdict === SEND.BLOCKED_REVOKED)

check('…and it still says what would clear it, so the UI can ask now',
  sendDecision(changed).needs === NEEDS.REVIEW_KEY_CHANGE &&
  typeof sendDecision(changed).message === 'string')

/* --------------------------------------------- 2. what it blocks, when on -- */

{
  const on = { enforcing: true }

  check('ON: an unverified peer sends — first contact is not an attack',
    sendDecision(emptyRecord('p'), on).allowed === true)
  check('ON: a pinned peer sends', sendDecision(pinned, on).allowed === true)
  check('ON: a verified peer sends', sendDecision(verified, on).allowed === true)
  check('ON: a peer with NO record at all sends — a v1 room has nothing to enforce',
    sendDecision(null, on).allowed === true && sendDecision(undefined, on).allowed === true)

  check('ON: a CHANGED peer is refused', sendDecision(changed, on).allowed === false)
  check('ON: a REVOKED peer is refused', sendDecision(revoked, on).allowed === false)

  check('…and neither is advisory any more',
    sendDecision(changed, on).advisory === false && sendDecision(revoked, on).advisory === false)

  // Their spec: accept -> Pinned, verify -> Verified, reject -> restore. Each
  // must actually lift the block, or the block has no exit.
  const accepted = applyEvent(changed, { type: ACCEPT, at: 5, key: K2 }).next
  const rejected = applyEvent(changed, { type: REJECT, at: 5 }).next
  const reverified = applyEvent(changed, { type: VERIFY, at: 5, key: K2 }).next

  check('ACCEPT lifts the block, and the record says Pinned',
    accepted.state === PINNED && sendDecision(accepted, on).allowed === true)
  check('VERIFY lifts the block, and the record says Verified',
    reverified.state === VERIFIED && sendDecision(reverified, on).allowed === true)
  check('REJECT lifts the block by RESTORING what was trusted before',
    rejected.state === VERIFIED && rejected.pinnedKey === K1 &&
    sendDecision(rejected, on).allowed === true)
  check('…and none of the three silently adopted the substituted key except ACCEPT',
    rejected.pinnedKey === K1 && reverified.pinnedKey === K2 && accepted.pinnedKey === K2)
}

/* --------------------------------------- 3. the availability axis, and order */

{
  const on = { enforcing: true }

  check('ON: a server-disabled peer is refused, and told it is terminal',
    sendDecision(avail(pinned, SERVER_DISABLED), on).allowed === false &&
    sendDecision(avail(pinned, SERVER_DISABLED), on).needs === NEEDS.CONTACT_ELSEWHERE)
  check('ON: an unreachable peer is refused, and told to wait',
    sendDecision(avail(pinned, UNREACHABLE), on).needs === NEEDS.WAIT)
  check('ON: an available peer is not refused for availability',
    sendDecision(avail(pinned, AVAILABLE), on).allowed === true)

  check('TRUST IS READ FIRST: a revoked AND unreachable peer is told about the revocation',
    sendDecision(avail(revoked, UNREACHABLE), on).verdict === SEND.BLOCKED_REVOKED)
  check('…and a changed AND server-disabled peer is told about the key',
    sendDecision(avail(changed, SERVER_DISABLED), on).verdict === SEND.BLOCKED_CHANGED)
  check('…because sending someone after a network fault that is not the problem is worse than useless',
    sendDecision(avail(revoked, UNREACHABLE), on).needs === NEEDS.RESTORE_TRUST)

  check('THE SERVER STILL CANNOT REACH TRUST: a disabled peer is not revoked',
    avail(pinned, SERVER_DISABLED).state === PINNED)
}

/* ---------------------------------- 4. an unavailable STORE is not a block -- */

check('AN UNREADABLE PIN STORE DOES NOT BLOCK — see the header for why',
  sendDecision(null, { enforcing: true }).allowed === true)

check('…and the reason is that the refusal does not depend on it: a Changed record ' +
  'still blocks when it CAN be read',
  sendDecision(changed, { enforcing: true }).allowed === false)

/* ---------------------------------------------- 5. every verdict is named -- */

{
  const all = Object.values(SEND)
  const seen = new Set([
    sendDecision(pinned).verdict,
    sendDecision(changed).verdict,
    sendDecision(revoked).verdict,
    sendDecision(avail(pinned, UNREACHABLE)).verdict,
    sendDecision(avail(pinned, SERVER_DISABLED)).verdict,
  ])
  check(`all ${all.length} verdicts are reachable, so none is dead code`,
    all.every((v) => seen.has(v)))

  const blocking = all.filter((v) => v !== SEND.ALLOWED)
  const decisions = [changed, revoked, avail(pinned, UNREACHABLE), avail(pinned, SERVER_DISABLED)]
    .map((r) => sendDecision(r, { enforcing: true }))
  check('EVERY BLOCK NAMES AN ACTION — no dead ends',
    decisions.length === blocking.length &&
    decisions.every((d) => d.needs !== NEEDS.NOTHING && Object.values(NEEDS).includes(d.needs)))
  check('…and every block has its own sentence',
    new Set(decisions.map((d) => d.message)).size === decisions.length &&
    decisions.every((d) => typeof d.message === 'string' && d.message.length > 20))
  check('an allowed send has nothing to say',
    sendDecision(pinned).message === null && sendDecision(pinned).needs === NEEDS.NOTHING)
}

check('sendDecision never throws, whatever it is handed', (() => {
  for (const junk of [null, undefined, 0, '', 'record', [], { state: 'Nonsense' },
    { state: CHANGED, availability: 'not an object' }, { availability: { status: 42 } }]) {
    try {
      const d = sendDecision(junk, { enforcing: true })
      if (typeof d.allowed !== 'boolean' || !Object.values(SEND).includes(d.verdict)) return false
    } catch { return false }
  }
  return true
})())

/* ------------------------------------------------ 6. the room-level cache -- */

{
  forgetAllTrust()
  check('a room nobody has recorded anything about may send',
    maySend('room-1') === true && roomDecision('room-1').verdict === SEND.ALLOWED)

  setRoomTrust('room-1', changed)
  check('recording a Changed record gives the room a blocking verdict',
    roomDecision('room-1').verdict === SEND.BLOCKED_CHANGED)
  check('…which with the flag off still ALLOWS the send',
    maySend('room-1') === true && roomDecision('room-1').advisory === true)

  setEnforcement(true)
  setRoomTrust('room-1', changed)
  check('ON: the same record now refuses', maySend('room-1') === false)
  check('…and a different room is unaffected', maySend('room-2') === true)

  markKeyProposed('room-2')
  check('THE SYNCHRONOUS PATH: a key proposed right now blocks immediately, ' +
    'without waiting for a store read', maySend('room-2') === false &&
    roomDecision('room-2').verdict === SEND.BLOCKED_CHANGED)

  setRoomTrust('room-1', applyEvent(changed, { type: ACCEPT, at: 6, key: K2 }).next)
  check('accepting the change unblocks that room', maySend('room-1') === true)

  clearRoomTrust('room-2')
  check('clearing a room returns it to allowed', maySend('room-2') === true)

  setRoomTrust('room-3', revoked)
  forgetAllTrust()
  check('a wipe forgets every verdict — one account\'s trust must not outlive it',
    maySend('room-3') === true && maySend('room-1') === true)

  setEnforcement(false)
  check('the flag can be put back', isEnforcing() === false)
}

/* -------------------------------------------- 7. the user is always told --- */

{
  setEnforcement(true)
  setRoomTrust('room-9', revoked)
  let told = null
  setBlockedSendHandler((info) => { told = info })
  reportBlocked('room-9')
  check('A REFUSAL REACHES THE UI — a message that quietly goes nowhere is the ' +
    'bug this codebase keeps rediscovering',
    told?.roomId === 'room-9' && told.verdict === SEND.BLOCKED_REVOKED &&
    told.needs === NEEDS.RESTORE_TRUST && typeof told.message === 'string')

  setBlockedSendHandler(() => { throw new Error('the UI is broken') })
  let survived = true
  try { reportBlocked('room-9') } catch { survived = false }
  check('a handler that throws does not take the send path down with it', survived)

  setBlockedSendHandler(null)
  check('the handler can be removed without breaking the report',
    reportBlocked('room-9').verdict === SEND.BLOCKED_REVOKED)

  setEnforcement(false)
  forgetAllTrust()
}

/* ------------------------------------- 8. the gate is actually in the path -- */

{
  /* A TRIPWIRE, NOT A PROOF, and it is labelled that way on purpose.
   *
   * Everything above tests the DECISION. The decision only matters if the send
   * path consults it, and `rooms.js` pulls in db, discovery, notify, push, net
   * and the socket transport — a harness for it would cost more than it proves
   * and would itself need trusting. So this reads the source and checks the two
   * choke points call `maySend` before doing anything.
   *
   * What it catches: someone deleting the gate, or adding a third send path
   * without one. What it does NOT catch: a gate that is present and wrong. That
   * is on the manual matrix, where a human sends a message to a peer whose key
   * changed and watches what happens. Do not read a green here as "enforcement
   * works". */
  const src = readFileSync(new URL('../src/lib/rooms.js', import.meta.url), 'utf8')
  const gated = (fn) => {
    const at = src.indexOf(`  ${fn} (roomId`)
    if (at < 0) return false
    const body = src.slice(at, at + 1200)
    const gate = body.indexOf('maySend(roomId)')
    const work = body.indexOf('conn.store.add')
    return gate > 0 && (work < 0 || gate < work)
  }
  check('THE GATE IS IN sendMessage, before anything is stored or sent', gated('sendMessage'))
  check('…and in sendAttachment — a gate on one of two send paths is not a gate',
    gated('sendAttachment'))
  check('…and a refused send REPORTS, so it is not silent',
    (src.match(/reportBlocked\(roomId\)/g) || []).length === 2)
  check('the proposal callback blocks the room at the moment it learns, not later',
    /onPeerKeyProposed[\s\S]{0,900}markKeyProposed\(convo\.roomId\)/.test(src))
}

check('THE FLAG IS OFF WHEN THIS SUITE ENDS — nothing leaks into the next test',
  isEnforcing() === false)

console.log('\n========================================')
console.log('  A5 enforcement — built, reasoned, and switched off')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
