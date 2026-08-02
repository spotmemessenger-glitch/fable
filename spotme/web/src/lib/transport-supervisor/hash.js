/**
 * Spot Me — Adaptive transport scaffolding: stable NON-CRYPTOGRAPHIC hashing.
 * Priority 2, ADR-012 (scaffolding only). Flag ADAPTIVE_TRANSPORT_ENABLED=false.
 *
 * envelopeId and MeshFrame frameId need a short, deterministic identifier that
 * BOTH sides can compute from the same opaque inputs — for dedup and ordering,
 * never to protect anything. This is the exact role reach.js's `stableHash`
 * plays for room ids; it is duplicated here (not imported) so the scaffolding
 * carries no dependency on the live message path, and it is labelled loudly so
 * nobody mistakes it for a MAC.
 *
 * INV-4 (see invariants.js): identifiers are derived from ROUTING METADATA and a
 * digest of the ALREADY-SEALED ciphertext only. No key material, no plaintext,
 * ever enters an id. That is why a non-cryptographic fold is not merely
 * acceptable here but correct: it hashes bytes that are already opaque.
 */

/** FNV-style 64-bit fold over a string. Same shape reach.js uses for room ids. */
export function stableHash (input) {
  const s = String(input)
  let h1 = 0xdeadbeef ^ s.length
  let h2 = 0x41c6ce57 ^ s.length
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}

/** Fold raw bytes (Uint8Array or number[]) into the same 16-hex space. */
export function hashBytes (bytes) {
  let h1 = 0xdeadbeef ^ bytes.length
  let h2 = 0x41c6ce57 ^ bytes.length
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] & 0xff
    h1 = Math.imul(h1 ^ b, 2654435761)
    h2 = Math.imul(h2 ^ b, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}

/**
 * Digest opaque content whether it arrives as base64/opaque TEXT or as raw
 * bytes. Both are treated as OPAQUE — this function never interprets them.
 */
export function digest (opaque) {
  if (opaque == null) return stableHash('')
  if (typeof opaque === 'string') return stableHash(opaque)
  if (opaque instanceof Uint8Array || Array.isArray(opaque)) return hashBytes(opaque)
  // Anything else is a caller error at this boundary — do not silently coerce
  // structured data into an id, or two different envelopes could collide.
  throw new Error('digest: opaque content must be base64 text or bytes')
}
