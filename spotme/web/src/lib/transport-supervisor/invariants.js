/**
 * Spot Me — the SIX ENCRYPTION INVARIANTS (INV-1..6). Priority 2, ADR-012.
 * SCAFFOLDING ONLY (flag off, not wired).
 *
 * These are the properties that must hold for it to be SAFE to move a Spot Me
 * conversation across an arbitrary, switchable set of transports — including a
 * flooding Bluetooth mesh whose relays are other people's phones. They are
 * written as EXECUTABLE PREDICATES, not prose, for the same reason ADR-002 wrote
 * the key prohibition as a test: an invariant nobody runs is a comment, and a
 * comment does not stop the V-19 mistake from happening again through a new door.
 *
 * Each predicate returns true or throws. The INVARIANTS array is the human-
 * readable register; the functions are what the tests execute.
 *
 * NOTE ON SCOPE. The seal itself is DEFERRED (seal-boundary.js). These
 * invariants therefore constrain the SCAFFOLDING's shape — opaque payloads, no
 * key surface, id/relay discipline — so that when the seal-lift is eventually
 * done above the transport, the pieces it must sit on already refuse to leak.
 */
import { FORBIDDEN_KEY_SURFACE } from './ITransport.js'

/** Field names that would indicate CLEARTEXT content riding in an envelope. */
export const PLAINTEXT_FIELD_NAMES = Object.freeze(['plaintext', 'cleartext', 'text', 'body', 'message', 'content'])

/** Inputs that may legitimately shape an id (see envelope.js / mesh.js). */
const ALLOWED_ID_INPUTS = new Set(['roomId', 'origin', 'seq', 'serverSeq', 'ratchetPos', 'senderClock', 'ciphertextDigest', 'payloadDigest'])

/* ─────────────────────────── INV-1 ─────────────────────────── */
/** Keys never cross the transport boundary: no object on the transport path may
 *  expose a key-shaped member. */
export function assertNoKeySurface (obj, label = 'object') {
  if (!obj || typeof obj !== 'object') throw new Error(`INV-1 ${label}: not an object`)
  for (const banned of FORBIDDEN_KEY_SURFACE) {
    if (banned in obj) throw new Error(`INV-1 ${label}: exposes forbidden key surface "${banned}"`)
  }
  return true
}

/* ─────────────────────────── INV-2 ─────────────────────────── */
/** Payload opacity: an envelope carries OPAQUE ciphertext (bytes or base64 text)
 *  and NO cleartext-content field. The transport layer never reads it. */
export function assertOpaquePayload (envelope, label = 'envelope') {
  if (!envelope || typeof envelope !== 'object') throw new Error(`INV-2 ${label}: not an object`)
  const ct = envelope.ciphertext ?? envelope.payload
  if (typeof ct !== 'string' && !(ct instanceof Uint8Array)) {
    throw new Error(`INV-2 ${label}: payload is not opaque bytes/text`)
  }
  for (const f of PLAINTEXT_FIELD_NAMES) {
    if (f in envelope) throw new Error(`INV-2 ${label}: carries cleartext-shaped field "${f}"`)
  }
  return true
}

/* ─────────────────────────── INV-3 ─────────────────────────── */
/** The supervisor never seals or opens: no scaffolding object performs crypto.
 *  (The seal-lift that WOULD do so is deferred; see seal-boundary.js.) */
export function assertNoSealSurface (obj, label = 'object') {
  if (!obj || typeof obj !== 'object') throw new Error(`INV-3 ${label}: not an object`)
  for (const op of ['seal', 'open', 'encrypt', 'decrypt']) {
    if (op in obj) throw new Error(`INV-3 ${label}: performs crypto op "${op}" — the supervisor must not seal/open`)
  }
  return true
}

/* ─────────────────────────── INV-4 ─────────────────────────── */
/** Identifiers derive from OPAQUE inputs only: an id's inputs are a subset of
 *  routing metadata + a ciphertext digest — never key material or plaintext. */
export function assertIdInputsOpaque (inputKeys, label = 'id') {
  const keys = Array.isArray(inputKeys) ? inputKeys : Object.keys(inputKeys || {})
  for (const k of keys) {
    if (FORBIDDEN_KEY_SURFACE.includes(k)) throw new Error(`INV-4 ${label}: id input "${k}" is key material`)
    if (PLAINTEXT_FIELD_NAMES.includes(k)) throw new Error(`INV-4 ${label}: id input "${k}" is plaintext`)
    if (!ALLOWED_ID_INPUTS.has(k)) throw new Error(`INV-4 ${label}: id input "${k}" is not an allowed opaque input`)
  }
  return true
}

/* ─────────────────────────── INV-5 ─────────────────────────── */
/** Relays preserve ciphertext bit-identically: forwarding a mesh frame changes
 *  ONLY the hop count. Payload, frameId and origin are immutable in transit, so
 *  a relay cannot tamper undetected. */
export function assertRelayPreservesCiphertext (before, after, label = 'relay') {
  if (after.frameId !== before.frameId) throw new Error(`INV-5 ${label}: frameId changed in transit`)
  if (after.origin !== before.origin) throw new Error(`INV-5 ${label}: origin changed in transit`)
  const a = before.payload; const b = after.payload
  const same = (typeof a === 'string' && a === b) ||
    (a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((v, i) => v === b[i]))
  if (!same) throw new Error(`INV-5 ${label}: payload (ciphertext) was altered by the relay`)
  if (after.hop !== before.hop + 1) throw new Error(`INV-5 ${label}: hop did not advance by exactly one`)
  return true
}

/* ─────────────────────────── INV-6 ─────────────────────────── */
/** No transport carries an unsealed message: an envelope handed to send() must
 *  be marked sealed, carry opaque ciphertext, and hold no plaintext. A transport
 *  that cannot carry sealed bytes is DISQUALIFIED by the selector, never fed
 *  plaintext (the room.js lesson). */
export function assertSealedBeforeSend (envelope, label = 'envelope') {
  assertOpaquePayload(envelope, label)
  if (envelope.sealed !== true) throw new Error(`INV-6 ${label}: not marked sealed`)
  return true
}

/** The register, in one place, for docs/reports and the ADR addendum. */
export const INVARIANTS = Object.freeze([
  { id: 'INV-1', title: 'Keys never cross the transport boundary', predicate: 'assertNoKeySurface',
    statement: 'No object on the transport path exposes a key-shaped member (FORBIDDEN_KEY_SURFACE).' },
  { id: 'INV-2', title: 'Payload opacity', predicate: 'assertOpaquePayload',
    statement: 'Envelopes carry opaque ciphertext and no cleartext-content field; the transport never reads the payload.' },
  { id: 'INV-3', title: 'The supervisor never seals or opens', predicate: 'assertNoSealSurface',
    statement: 'No scaffolding object performs seal/open/encrypt/decrypt; the seal-lift that would is deferred.' },
  { id: 'INV-4', title: 'Identifiers derive from opaque inputs only', predicate: 'assertIdInputsOpaque',
    statement: 'envelopeId/frameId inputs are routing metadata + a ciphertext digest — never keys or plaintext.' },
  { id: 'INV-5', title: 'Relays preserve ciphertext bit-identically', predicate: 'assertRelayPreservesCiphertext',
    statement: 'Forwarding a mesh frame changes only the hop count; payload/frameId/origin are immutable in transit.' },
  { id: 'INV-6', title: 'No transport carries an unsealed message', predicate: 'assertSealedBeforeSend',
    statement: 'A sent envelope is marked sealed with opaque ciphertext and no plaintext; keyless transports are disqualified, not fed plaintext.' }
])
