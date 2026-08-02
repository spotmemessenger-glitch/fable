/**
 * SealedEnvelope dedup + 3-tier OrderingToken (ADR-012).
 *
 * Pure logic. The envelope's ciphertext is OPAQUE here — no seal, no open, no
 * key (the seal-lift is deferred). Scaffolding only — flag off, not wired.
 */
import {
  makeSealedEnvelope, envelopeIdFor, createDedupWindow
} from '../src/lib/transport-supervisor/envelope.js'
import {
  makeOrderingToken, compareTokens, sortEnvelopes, createReorderBuffer
} from '../src/lib/transport-supervisor/ordering.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

/* ============================== envelopeId ============================= */

check('envelopeId is deterministic for identical opaque inputs', () => {
  const args = { roomId: 'dm-1', origin: 'alice', ordering: { senderClock: 3 }, ciphertext: 'c2VhbGVk' }
  return envelopeIdFor(args) === envelopeIdFor({ ...args }) && envelopeIdFor(args).startsWith('env_')
})

check('a different ciphertext yields a different envelopeId', () => {
  const a = envelopeIdFor({ roomId: 'dm-1', origin: 'alice', ordering: { senderClock: 3 }, ciphertext: 'AAAA' })
  const b = envelopeIdFor({ roomId: 'dm-1', origin: 'alice', ordering: { senderClock: 3 }, ciphertext: 'BBBB' })
  return a !== b
})

check('envelopeId accepts raw bytes as opaque content', () => {
  const id = envelopeIdFor({ roomId: 'dm-1', origin: 'alice', ordering: { senderClock: 1 }, ciphertext: new Uint8Array([1, 2, 3]) })
  return typeof id === 'string' && id.startsWith('env_')
})

/* =========================== SealedEnvelope =========================== */

check('a SealedEnvelope is marked sealed and preserves its opaque ciphertext', () => {
  const e = makeSealedEnvelope({ roomId: 'dm-1', origin: 'alice', ciphertext: 'c2VhbGVk', ordering: { senderClock: 1 } })
  return e.sealed === true && e.ciphertext === 'c2VhbGVk' && typeof e.envelopeId === 'string'
})

check('makeSealedEnvelope refuses non-opaque ciphertext', () => {
  try { makeSealedEnvelope({ roomId: 'dm-1', origin: 'a', ciphertext: { not: 'opaque' } }); return false } catch { return true }
})

check('makeSealedEnvelope requires roomId and origin', () => {
  try { makeSealedEnvelope({ origin: 'a', ciphertext: 'x' }); return false } catch { /* expected */ }
  try { makeSealedEnvelope({ roomId: 'r', ciphertext: 'x' }); return false } catch { /* expected */ }
  return true
})

/* ============================ dedup window ============================ */

check('the dedup window accepts an envelope once and rejects every copy after', () => {
  const w = createDedupWindow({ capacity: 8 })
  const e = makeSealedEnvelope({ roomId: 'dm-1', origin: 'alice', ciphertext: 'c2VhbGVk', ordering: { senderClock: 1 } })
  return w.accept(e) === true && w.accept(e) === false && w.has(e.envelopeId) === true
})

check('two envelopes built from identical inputs collapse to one (re-send dedup)', () => {
  const w = createDedupWindow()
  const mk = () => makeSealedEnvelope({ roomId: 'dm-1', origin: 'alice', ciphertext: 'c2VhbGVk', ordering: { senderClock: 5 } })
  return w.accept(mk()) === true && w.accept(mk()) === false
})

check('the dedup window is bounded — the oldest id is eventually forgotten', () => {
  const w = createDedupWindow({ capacity: 2 })
  w.accept('a'); w.accept('b'); w.accept('c')     // 'a' evicted
  return w.has('a') === false && w.has('b') === true && w.size === 2 && w.accept('a') === true
})

/* ========================= 3-tier compareTokens ======================= */

const tok = (o) => makeOrderingToken(o)

check('serverSeq is authoritative when both tokens carry it', () => {
  // b wins on serverSeq even though its senderClock is far lower.
  const a = tok({ serverSeq: 1, senderClock: 99 })
  const b = tok({ serverSeq: 2, senderClock: 1 })
  return compareTokens(a, b) === -1 && compareTokens(b, a) === 1
})

check('with serverSeq on only one side, comparison FALLS BACK to senderClock', () => {
  // a has a serverSeq, b does not; the shared tier is senderClock, so a<b by clock.
  const a = tok({ serverSeq: 500, senderClock: 2 })
  const b = tok({ senderClock: 3 })
  return compareTokens(a, b) === -1
})

check('ratchetPos orders when neither side has a serverSeq', () => {
  const a = tok({ ratchetPos: 2, senderClock: 9 })
  const b = tok({ ratchetPos: 1, senderClock: 1 })
  return compareTokens(a, b) === 1
})

check('equal on an authoritative tier compares as equal (0)', () => {
  return compareTokens(tok({ serverSeq: 4, senderClock: 1 }), tok({ serverSeq: 4, senderClock: 8 })) === 0
})

check('makeOrderingToken requires a senderClock', () => {
  try { makeOrderingToken({ serverSeq: 1 }); return false } catch { return true }
})

/* ============================ sortEnvelopes =========================== */

check('sortEnvelopes orders by token and breaks ties by envelopeId', () => {
  const mk = (id, senderClock) => ({ envelopeId: id, ordering: tok({ senderClock }) })
  const sorted = sortEnvelopes([mk('z', 2), mk('a', 1), mk('m', 2)])
  // clock 1 first; then the two clock-2 entries tie-broken by id: 'm' before 'z'.
  return sorted.map((e) => e.envelopeId).join(',') === 'a,m,z'
})

/* ========================== reorder buffer =========================== */

check('the reorder buffer releases in order, holds gaps, and drops duplicates', () => {
  const buf = createReorderBuffer()   // expected starts at 1
  const r1 = buf.push({ origin: 'X', senderClock: 1, item: 'one' })
  const r3 = buf.push({ origin: 'X', senderClock: 3, item: 'three' })   // gap at 2 -> hold
  const held = buf.pending('X')
  const r2 = buf.push({ origin: 'X', senderClock: 2, item: 'two' })     // fills gap -> release 2,3
  const dup = buf.push({ origin: 'X', senderClock: 2, item: 'two-again' })
  return r1.released.join() === 'one' && r1.status === 'released' &&
    r3.status === 'buffered' && held === 1 &&
    r2.released.join() === 'two,three' && r2.status === 'released' &&
    dup.status === 'duplicate'
})

check('reorder buffers are independent per origin', () => {
  const buf = createReorderBuffer()
  buf.push({ origin: 'X', senderClock: 1, item: 'x1' })
  const y = buf.push({ origin: 'Y', senderClock: 1, item: 'y1' })   // Y has its own lane
  return y.released.join() === 'y1' && buf.expected('X') === 2 && buf.expected('Y') === 2
})

/* -------------------------------------------------------------- report --- */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  envelope dedup + 3-tier ordering')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
if (passed !== names.length) process.exit(1)
