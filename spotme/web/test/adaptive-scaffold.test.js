/**
 * Adaptive transport SCAFFOLDING — the contract, the invariants, and the
 * DEFERRED seal-lift (ADR-012).
 *
 * Proves: the barrel loads with the flag OFF; ITransport is a real, enforced
 * contract that still forbids key surface; every scaffolding object refuses key
 * and crypto surface (INV-1/INV-3); the six invariants bite; and the seal-lift
 * is DEFINED but NOT implemented. Scaffolding only — nothing is wired in.
 */
import * as SUP from '../src/lib/transport-supervisor/index.js'
import {
  ITRANSPORT_METHODS, TransportStatus, makeQualitySample, makeCostSignal,
  assertImplementsITransport, FORBIDDEN_KEY_SURFACE
} from '../src/lib/transport-supervisor/ITransport.js'
import { CAPABILITY_MATRIX, CAPABILITY_KEYS, makeCapabilities, RANGE } from '../src/lib/transport-supervisor/capabilities.js'
import { createTransportRegistry } from '../src/lib/transport-supervisor/registry.js'
import { createMemoryOutbox, assertImplementsOutbox } from '../src/lib/transport-supervisor/outbox.js'
import { createSelector } from '../src/lib/transport-supervisor/selection.js'
import { makeSealedEnvelope, createDedupWindow, ENVELOPE_ID_INPUTS } from '../src/lib/transport-supervisor/envelope.js'
import { makeMeshFrame, forward, createSeenSet } from '../src/lib/transport-supervisor/mesh.js'
import {
  INVARIANTS, assertNoKeySurface, assertOpaquePayload, assertNoSealSurface,
  assertIdInputsOpaque, assertRelayPreservesCiphertext, assertSealedBeforeSend
} from '../src/lib/transport-supervisor/invariants.js'
import {
  createDeferredSealer, assertSealLiftNotImplemented, SEAL_LIFT_STATUS, SEALER_METHODS
} from '../src/lib/transport-supervisor/seal-boundary.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

const fakeTransport = () => ({
  connect: async () => {}, disconnect: async () => {},
  send: async () => ({ accepted: true }), receive: () => () => {},
  quality: () => makeQualitySample({ connected: true }), costSignal: () => makeCostSignal({}),
  capabilities: () => CAPABILITY_MATRIX.socketio, status: () => TransportStatus.IDLE
})

/* =============================== the flag ============================== */

check('the barrel loads and the flag is OFF', () => {
  return SUP.ADAPTIVE_TRANSPORT_ENABLED === false && SUP.isAdaptiveTransportEnabled() === false
})

/* =========================== ITransport contract ====================== */

check('a conforming transport satisfies ITransport', () => {
  assertImplementsITransport(fakeTransport(), 'fake')
  return ITRANSPORT_METHODS.length === 8
})

check('a missing method is rejected', () => {
  const t = fakeTransport(); delete t.send
  try { assertImplementsITransport(t, 'broken'); return false } catch { return true }
})

check('a bogus status() is rejected', () => {
  try { assertImplementsITransport({ ...fakeTransport(), status: () => 'vibes' }, 'bogus'); return false } catch { return true }
})

check('the generalised contract STILL forbids key surface (INV-1 inherited)', () => {
  for (const banned of ['seal', 'open', 'roomKey', 'key', 'password', 'secret']) {
    const leaky = { ...fakeTransport(), [banned]: () => {} }
    try { assertImplementsITransport(leaky, 'leaky'); return false } catch { /* expected */ }
  }
  return FORBIDDEN_KEY_SURFACE.includes('seal') && FORBIDDEN_KEY_SURFACE.includes('open')
})

/* ========================== capability matrix ========================= */

check('the matrix marks bleMesh as the only offline, no-internet transport', () => {
  return CAPABILITY_MATRIX.bleMesh.offline === true && CAPABILITY_MATRIX.bleMesh.needsInternet === false &&
    CAPABILITY_MATRIX.socketio.offline === false && CAPABILITY_MATRIX.bleMesh.range === RANGE.PROXIMITY
})

check('every matrix row carries every capability key', () => {
  for (const row of Object.values(CAPABILITY_MATRIX)) {
    for (const k of CAPABILITY_KEYS) if (!(k in row)) return false
  }
  return true
})

check('makeCapabilities rejects the needsInternet && offline contradiction', () => {
  try {
    makeCapabilities({ range: RANGE.PROXIMITY, needsInternet: true, offline: true, bandwidthKbps: 1, latencyMs: 1, batteryCostPerMin: 0.1, maxPayloadBytes: 1 })
    return false
  } catch { return true }
})

/* ============================== registry ============================= */

check('the registry registers, looks up, and refuses a double-register', () => {
  const reg = createTransportRegistry()
  reg.register('socketio', { transport: fakeTransport(), capabilities: CAPABILITY_MATRIX.socketio })
  const ok = reg.has('socketio') && reg.get('socketio').name === 'socketio' && reg.list().length === 1 &&
    'socketio' in reg.capabilityMap()
  let refused = false
  try { reg.register('socketio', { capabilities: CAPABILITY_MATRIX.socketio }) } catch { refused = true }
  return ok && refused && reg.unregister('socketio') && reg.size === 0
})

check('the registry rejects a capability row missing keys', () => {
  const reg = createTransportRegistry()
  try { reg.register('bad', { capabilities: { range: 'internet' } }); return false } catch { return true }
})

/* ============================ outbox (S&F) =========================== */

check('the memory outbox satisfies IOutbox', () => {
  assertImplementsOutbox(createMemoryOutbox(), 'memoryOutbox')
  return true
})

check('enqueue is idempotent by id and keeps the ORIGINAL first-seen time', () => {
  const box = createMemoryOutbox({ ttlMs: 1000 })
  box.enqueue('c', 'v1', 0)
  const e = box.enqueue('c', 'v2', 500)   // same id, later time
  return e.first === 0 && e.item === 'v2' && box.size === 1
})

check('pending excludes delivered and expired; sweep drops the expired', () => {
  const box = createMemoryOutbox({ ttlMs: 1000 })
  box.enqueue('a', 'x', 0)
  box.markDelivered('a')
  box.enqueue('b', 'y', 0)
  const pendingWhileFresh = box.pending(500).length          // b still owed
  const pendingAfterTtl = box.pending(2000).length           // b expired
  const dropped = box.sweep(2000)
  return pendingWhileFresh === 1 && pendingAfterTtl === 0 && dropped.join() === 'b' && box.has('b') === false
})

/* ===================== the six invariants (INV-1..6) ================== */

check('the register lists exactly INV-1..6', () => {
  return INVARIANTS.map((i) => i.id).join(',') === 'INV-1,INV-2,INV-3,INV-4,INV-5,INV-6'
})

check('INV-1 & INV-3: every scaffolding object refuses key AND crypto surface', () => {
  const objs = [
    createTransportRegistry(), createSelector(), createDedupWindow(), createSeenSet(),
    createMemoryOutbox(), fakeTransport(),
    makeSealedEnvelope({ roomId: 'r', origin: 'o', ciphertext: 'x' }),
    makeMeshFrame({ origin: 'o', seq: 1, payload: 'x', ttl: 2 })
  ]
  for (const o of objs) { assertNoKeySurface(o); assertNoSealSurface(o) }
  return true
})

check('INV-1 bites: an object with a key surface is rejected', () => {
  try { assertNoKeySurface({ password: 'hunter2' }); return false } catch { return true }
})

check('INV-2: a SealedEnvelope is opaque; a cleartext-carrying object is rejected', () => {
  assertOpaquePayload(makeSealedEnvelope({ roomId: 'r', origin: 'o', ciphertext: 'x' }))
  try { assertOpaquePayload({ ciphertext: 'x', text: 'MEET AT SIX' }); return false } catch { /* expected */ }
  try { assertOpaquePayload({ ciphertext: { not: 'opaque' } }); return false } catch { /* expected */ }
  return true
})

check('INV-3 bites: an object performing crypto is rejected', () => {
  try { assertNoSealSurface({ encrypt: () => {} }); return false } catch { return true }
})

check('INV-4: the real id inputs are opaque; keys and plaintext as inputs are rejected', () => {
  assertIdInputsOpaque(ENVELOPE_ID_INPUTS)
  for (const bad of [['key'], ['password'], ['plaintext'], ['bogus']]) {
    try { assertIdInputsOpaque(bad); return false } catch { /* expected */ }
  }
  return true
})

check('INV-5: a relay preserves ciphertext; tampering or a bad hop is caught', () => {
  const before = makeMeshFrame({ origin: 'o', seq: 1, payload: 'c2VhbGVk', ttl: 5, hop: 0 })
  assertRelayPreservesCiphertext(before, forward(before))
  try { assertRelayPreservesCiphertext(before, { ...forward(before), payload: 'TAMPERED' }); return false } catch { /* expected */ }
  try { assertRelayPreservesCiphertext(before, { ...before }); return false } catch { /* expected: hop did not advance */ }
  return true
})

check('INV-6: a sealed envelope may be sent; an unsealed or plaintext one may not', () => {
  assertSealedBeforeSend(makeSealedEnvelope({ roomId: 'r', origin: 'o', ciphertext: 'x' }))
  try { assertSealedBeforeSend({ ciphertext: 'x' }); return false } catch { /* not marked sealed */ }
  try { assertSealedBeforeSend({ ciphertext: 'x', sealed: true, text: 'hi' }); return false } catch { /* plaintext field */ }
  return true
})

/* ===================== the seal-lift is DEFERRED ===================== */

check('SEAL_LIFT_STATUS records the lift as NOT implemented and gated on P1', () => {
  return SEAL_LIFT_STATUS.implemented === false && /Priority 1/.test(SEAL_LIFT_STATUS.gate) &&
    SEALER_METHODS.join(',') === 'seal,open'
})

check('the deferred sealer THROWS on both seal() and open()', () => {
  const s = createDeferredSealer()
  let sealThrew = false; let openThrew = false
  try { s.seal('r', new Uint8Array([1])) } catch { sealThrew = true }
  try { s.open('r', new Uint8Array([1])) } catch { openThrew = true }
  return sealThrew && openThrew
})

check('assertSealLiftNotImplemented passes for the stub and BITES a real sealer', () => {
  assertSealLiftNotImplemented(createDeferredSealer())
  // A sealer that actually returns bytes must be refused — proving the check bites.
  const fakeImplemented = { seal: () => new Uint8Array([9]), open: () => new Uint8Array([9]) }
  try { assertSealLiftNotImplemented(fakeImplemented); return false } catch { return true }
})

/* -------------------------------------------------------------- report --- */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  adaptive scaffolding — contract + invariants + deferred seal-lift')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
if (passed !== names.length) process.exit(1)
