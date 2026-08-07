/**
 * Spot Me — X3DH key agreement. e2e_v3, ADR-004 + 004a. PURE.
 *
 * WHAT X3DH BUYS. e2e_v2 derives one room key from one ECDH and never changes
 * it: whoever gets that key reads the whole conversation, forward and back.
 * X3DH is the ASYNCHRONOUS handshake that seeds a Double Ratchet (Phase 4) —
 * it lets Alice open a session to an OFFLINE Bob from prekeys he published
 * once, with a fresh ephemeral each time, so the FIRST message already has
 * forward secrecy and Bob can answer without a round trip.
 *
 * THE FOUR DH, and why four. Signal's X3DH, exactly:
 *
 *   DH1 = DH(IK_A, SPK_B)   binds Alice's identity to Bob's signed prekey
 *   DH2 = DH(EK_A, IK_B)    binds Alice's ephemeral to Bob's identity
 *   DH3 = DH(EK_A, SPK_B)   the ephemeral × signed-prekey core
 *   DH4 = DH(EK_A, OPK_B)   the one-time prekey — present only if Bob had one
 *
 *   SS = DH1 || DH2 || DH3 || DH4        (128 bytes, or 96 with no OPK)
 *   root = HKDF(SS, salt=0^32, info="spotme/e2e_v3/root", 32)
 *
 * DH1+DH2 mutually authenticate the two identities; DH3 gives the shared
 * secret its forward secrecy against a later identity-key compromise; DH4
 * adds forward secrecy against a compromise of the signed prekey too, for the
 * one message that consumes it. Drop any one and a specific property is lost —
 * the field-by-field reasoning is 004a §3.
 *
 * PURE, exactly like `e2e-v2.js`, `signing-identity.js` and `safety-number.js`:
 * no storage, no DOM, no network, so `test/x3dh.test.js` runs the SHIPPED
 * bytes on Node's WebCrypto against the reproducible 004a vectors with no
 * mocks. Storage (the prekey pool) and transport (the bundle endpoints) are
 * separate, injected layers.
 *
 * NOT WIRED IN. e2e_v3 is behind the `spotme.e2e3` rollout flag (004a §12),
 * absent by default; nothing under `src/` reaches this module, and
 * `test/e2e-v3-not-shipped.test.js` fails the build if that changes — the same
 * discipline the signing foundation ships under.
 */
import { verifyBytes } from './signing-identity.js'

/* --------------------------------------------------------------- labels --- */
/* Domain-separated HKDF labels, frozen in 004a §10 and pinned by the vectors.
 * Changing a byte here changes the wire and breaks every existing session. */
export const X3DH_ROOT_LABEL = 'spotme/e2e_v3/root'

const enc = new TextEncoder()

/* --------------------------------------------------------------- base64 --- */
/* btoa/atob, matching e2e-v2.js — Buffer exists only in Node, and this runs in
 * the browser and the Android WebView too. */
export const toB64 = (buf) => {
  const b = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s)
}
export const fromB64 = (b64) => {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/* ------------------------------------------------------------------ DH ---- */

/**
 * One X25519 Diffie–Hellman: 32 raw bytes.
 *
 * Takes CryptoKeys, never raw bytes, because the private half is a
 * non-extractable handle by construction (that is the whole security property
 * of the identity key) and a function that accepted raw private bytes would
 * invite someone to serialise one.
 */
export async function dh (privateKey, publicKey) {
  const bits = await crypto.subtle.deriveBits({ name: 'X25519', public: publicKey }, privateKey, 256)
  return new Uint8Array(bits)
}

/** A peer's raw X25519 public key off the wire → CryptoKey. Length-checked; a
 *  wrong length is refused rather than imported as something it is not. */
export async function importX25519Public (raw) {
  const bytes = raw instanceof Uint8Array ? raw : fromB64(raw)
  if (bytes.length !== 32) throw new Error(`X25519 public key must be 32 bytes, got ${bytes.length}`)
  return crypto.subtle.importKey('raw', bytes, { name: 'X25519' }, false, [])
}

/* ------------------------------------------------------------- HKDF root -- */

/**
 * The X3DH root key: `HKDF(SS, salt=0^32, info="spotme/e2e_v3/root", 32)`.
 *
 * Returned as raw bytes — it is a one-time handoff to the ratchet, which
 * imports it as an HKDF key and never lets it out again. The 32 zero-byte salt
 * is Signal's convention and is pinned by the 004a vector.
 */
export async function rootKeyFromSharedSecret (ss) {
  const ikm = await crypto.subtle.importKey('raw', ss, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(X3DH_ROOT_LABEL) },
    ikm,
    256,
  )
  return new Uint8Array(bits)
}

/* --------------------------------------------------------- the handshake -- */

/**
 * INITIATOR (Alice). She holds her own identity + a fresh ephemeral, and Bob's
 * fetched bundle (his identity, signed prekey, and — if the pool was not empty
 * — a one-time prekey). Produces the shared secret and the root key.
 *
 * `peerOpkPub` is optional: a bundle served from an exhausted pool has none,
 * DH4 is omitted, and the session is weaker for exactly its first message. The
 * caller records OPKID = 0xFFFFFFFF so the degradation is on the wire, not
 * silent (004a §5a).
 */
export async function x3dhInitiator ({ identityPriv, ephemeralPriv, peerIkPub, peerSpkPub, peerOpkPub }) {
  if (!identityPriv || !ephemeralPriv) throw new Error('initiator needs its identity and ephemeral private keys')
  if (!peerIkPub || !peerSpkPub) throw new Error('a bundle needs at least the peer identity and signed prekey')
  const dh1 = await dh(identityPriv, peerSpkPub)
  const dh2 = await dh(ephemeralPriv, peerIkPub)
  const dh3 = await dh(ephemeralPriv, peerSpkPub)
  const parts = [dh1, dh2, dh3]
  if (peerOpkPub) parts.push(await dh(ephemeralPriv, peerOpkPub))
  const ss = concat(parts)
  return { sharedSecret: ss, rootKey: await rootKeyFromSharedSecret(ss), usedOpk: Boolean(peerOpkPub) }
}

/**
 * RESPONDER (Bob). He receives Alice's prologue (her identity + ephemeral
 * publics, and which of his prekeys she named) and holds the matching private
 * halves. DH is symmetric — `DH(a_priv, b_pub) == DH(b_priv, a_pub)` — so his
 * four DH reproduce Alice's shared secret exactly, without either side ever
 * exchanging a private key.
 *
 * `opkPriv` is supplied iff Alice named an OPKID other than the 0xFFFFFFFF
 * sentinel; if she used no OPK, Bob omits DH4 to match.
 */
export async function x3dhResponder ({ identityPriv, spkPriv, opkPriv, peerIkPub, peerEkPub }) {
  if (!identityPriv || !spkPriv) throw new Error('responder needs its identity and signed-prekey private keys')
  if (!peerIkPub || !peerEkPub) throw new Error('a prologue needs the peer identity and ephemeral publics')
  const dh1 = await dh(spkPriv, peerIkPub) // == DH(IK_A, SPK_B)
  const dh2 = await dh(identityPriv, peerEkPub) // == DH(EK_A, IK_B)
  const dh3 = await dh(spkPriv, peerEkPub) // == DH(EK_A, SPK_B)
  const parts = [dh1, dh2, dh3]
  if (opkPriv) parts.push(await dh(opkPriv, peerEkPub)) // == DH(EK_A, OPK_B)
  const ss = concat(parts)
  return { sharedSecret: ss, rootKey: await rootKeyFromSharedSecret(ss), usedOpk: Boolean(opkPriv) }
}

/* ----------------------------------------------------- signed prekey sig -- */

/**
 * The signed prekey's signature covers `IK || SPK` — both raw 32-byte X25519
 * public keys (004a §5). Raw concatenation is unambiguous here precisely
 * because both operands are FIXED 32 bytes: the collision hazard the signing
 * layer's length-prefix guards against needs a variable-length field, and
 * there is none. The signing key is the device's Ed25519 identity (A7); the
 * FETCHER verifies against the peer's PUBLISHED signing key, because the
 * server is the adversary and may substitute a bundle.
 */
export function spkSignedBytes (ikPubRaw, spkPubRaw) {
  const ik = ikPubRaw instanceof Uint8Array ? ikPubRaw : fromB64(ikPubRaw)
  const spk = spkPubRaw instanceof Uint8Array ? spkPubRaw : fromB64(spkPubRaw)
  if (ik.length !== 32 || spk.length !== 32) throw new Error('IK and SPK must both be raw 32-byte X25519 keys')
  const out = new Uint8Array(64)
  out.set(ik, 0)
  out.set(spk, 32)
  return out
}

/**
 * Verify a fetched bundle's signed prekey against the peer's signing key.
 * Returns true only if WebCrypto says the Ed25519 signature over `IK || SPK`
 * is valid — every other outcome (bad base64, wrong length, mismatch) is
 * false, never a throw, so a caller cannot turn a verification failure into an
 * accidental acceptance with a stray `catch`.
 *
 * `signingKey` is `{ publicKeyB64, algo }` as returned by the signing-key
 * fetch endpoint (#39). A bundle whose SPK does not verify MUST NOT be used to
 * open a session — that is the check that stops a substituted prekey.
 */
export async function verifyBundleSpk ({ ikB64, spkB64, sigB64, signingKey }) {
  try {
    if (!signingKey?.publicKeyB64 || !signingKey?.algo) return false
    const bytes = spkSignedBytes(fromB64(ikB64), fromB64(spkB64))
    return await verifyBytes(signingKey, bytes, sigB64)
  } catch {
    return false
  }
}

/* --------------------------------------------------------------- helpers -- */

function concat (parts) {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
