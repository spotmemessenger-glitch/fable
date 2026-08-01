/**
 * Spot Me — the device SIGNING identity. A7. PURE.
 *
 * WHY A SECOND KEY EXISTS AT ALL. `e2e-v2.js` gives every device an X25519 pair,
 * and X25519 cannot sign. Agreement proves, to the two people doing it, that
 * SOMEBODY holds the other private half — and it produces nothing transferable.
 * There is no artefact a device can show later, to itself or anyone else, that
 * says "this key was mine".
 *
 * That missing artefact is what makes the current trust model brittle in one
 * specific way: a verification is pinned to an AGREEMENT key, so the day that
 * key legitimately changes — new device, reinstall, storage loss — every
 * verification it carried is void, and the two humans have to meet and read
 * sixty digits again. A signing key that outlives agreement keys lets a peer
 * who was verified ONCE vouch for its own next agreement key, and the vouching
 * is checkable offline by anyone holding the signing key. That is the whole
 * point of A7; A5 enforcement and any future ratchet both stand on it.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not generate a key for anybody. Nothing
 * under `src/` imports it yet, and `test/signing-not-shipped.test.js` fails the
 * build if that changes — see the note on `generateSigningIdentity`.
 *
 * PURE, for the same reason as `e2e-v2.js` and `safety-number.js`: no storage,
 * no DOM, no network, so `test/signing-identity.test.js` runs the SHIPPED code
 * on Node's WebCrypto with no mocks. Nothing here is hand-rolled — every
 * primitive is WebCrypto's.
 */

export const ED25519 = 'Ed25519'
export const ECDSA_P256 = 'ECDSA-P-256'

/** In preference order. Ed25519 first: smaller, deterministic, no hash to get
 *  wrong at the call site. */
export const SIGNING_ALGOS = Object.freeze([ED25519, ECDSA_P256])

/**
 * Raw public key sizes.
 *
 * READ THIS BEFORE ADDING LENGTH INFERENCE. These are the SAME LENGTHS as the
 * agreement curves in `e2e-v2.js` — X25519 is 32 bytes and so is Ed25519;
 * uncompressed P-256 is 65 bytes on both the ECDH and the ECDSA side. So the
 * trick e2e-v2 uses, inferring the curve from the raw length, cannot tell a
 * SIGNING key from an AGREEMENT key. WebCrypto will import the same 32 bytes as
 * either one without complaint.
 *
 * That is a cross-protocol hazard, not a cosmetic one: a peer's agreement key
 * accepted as its signing key would let anything that produced a valid-looking
 * signature be checked against the wrong public key entirely. So `algo` is
 * REQUIRED on import here — never inferred — and it is also bound into every
 * transcript this module signs over. Two independent defences, because the
 * failure is silent.
 */
const RAW_LEN = Object.freeze({ [ED25519]: 32, [ECDSA_P256]: 65 })

/** Ed25519 and ECDSA-P-256 both emit 64 raw bytes.
 *
 *  BELT AND BRACES, not a security property — WebCrypto refuses a wrong-length
 *  signature on its own, and mutation testing confirms removing this check
 *  changes no observable behaviour. It stays because a malformed blob should
 *  never reach a primitive in the first place, and because it makes the expected
 *  shape explicit at the boundary. Do not cite it as a defence. */
const SIG_LEN = 64

const keyParams = (algo) => (algo === ED25519 ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' })

/** ECDSA names its hash at USE time, Ed25519 does not. Getting this wrong is a
 *  thrown DataError rather than a weak signature, but only because WebCrypto
 *  refuses it — hence one function, used by both sign and verify, so they can
 *  never disagree. */
const useParams = (algo) => (algo === ED25519 ? { name: 'Ed25519' } : { name: 'ECDSA', hash: 'SHA-256' })

/* --------------------------------------------------------------- base64 --- */
/* btoa/atob rather than Buffer, matching e2e-v2.js: this runs in the browser,
 * the Android WebView and Node, and Buffer exists in only one of the three. */

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

/* ----------------------------------------------------------- negotiation --- */

let cachedAlgo = null

/**
 * Ed25519 where the runtime has it, ECDSA P-256 otherwise.
 *
 * The fallback is not hypothetical, and the reason is the same one `e2e-v2.js`
 * gives: Capacitor's Android System WebView updates independently of the app, so
 * a user can be several Chrome releases behind. Ed25519 landed in Chromium far
 * later than X25519 did, so a device perfectly able to do v2 agreement may still
 * have no Ed25519 — which is exactly why the algorithm is recorded per identity
 * rather than assumed.
 */
export async function negotiateSigningAlgo () {
  if (cachedAlgo) return cachedAlgo
  try {
    await crypto.subtle.generateKey(keyParams(ED25519), false, ['sign', 'verify'])
    cachedAlgo = ED25519
  } catch {
    cachedAlgo = ECDSA_P256
  }
  return cachedAlgo
}

/** Test seam. Negotiation caches a process-wide answer, and a test that wants
 *  the fallback path must be able to clear it. */
export function resetSigningAlgoCache () { cachedAlgo = null }

/* -------------------------------------------------------------- identity --- */

/**
 * A device signing identity. `extractable` is FALSE, and this module exports NO
 * path that serialises the private half — no wrapKey, no exportKey, no JWK. The
 * public half goes out via `exportSigningPublicKeyB64` and nothing else does.
 *
 * NOT CALLED ANYWHERE IN THE APP, DELIBERATELY. Minting a signing key on a real
 * device is a one-way act: the moment one is published it becomes the anchor
 * peers pin, and replacing it later is a user-visible trust event, not a silent
 * upgrade. The owner has not authorised that step, so nothing under `src/`
 * reaches this function and `test/signing-not-shipped.test.js` enforces it.
 *
 * The tests DO call it — a key format nobody has generated is a design
 * document, not a foundation.
 */
export async function generateSigningIdentity ({ algo } = {}) {
  const use = algo || (await negotiateSigningAlgo())
  if (!RAW_LEN[use]) throw new Error(`unsupported signing algo: ${use}`)
  const pair = await crypto.subtle.generateKey(keyParams(use), false, ['sign', 'verify'])
  return { algo: use, publicKey: pair.publicKey, privateKey: pair.privateKey }
}

/** The public half, base64. This is the only thing that ever leaves. */
export async function exportSigningPublicKeyB64 (identity) {
  if (!identity?.publicKey) throw new Error('no signing public key to export')
  return toB64(await crypto.subtle.exportKey('raw', identity.publicKey))
}

/**
 * A peer's signing key off the wire.
 *
 * `algo` is REQUIRED and never inferred — see RAW_LEN above. The length is then
 * checked against the named algorithm, so a 32-byte blob presented as P-256, or
 * an agreement key presented as a signing key, is refused at the boundary rather
 * than becoming a key that verifies nothing correctly.
 */
export async function importSigningPublicKey (b64, algo) {
  if (typeof b64 !== 'string' || !b64) throw new Error('signing public key missing')
  if (!RAW_LEN[algo]) throw new Error(`signing algo must be named explicitly, got: ${algo}`)
  let raw
  try { raw = fromB64(b64) } catch { throw new Error('signing public key is not base64') }
  if (raw.length !== RAW_LEN[algo]) {
    throw new Error(`${algo} public key must be ${RAW_LEN[algo]} bytes, got ${raw.length}`)
  }
  return crypto.subtle.importKey('raw', raw, keyParams(algo), false, ['verify'])
}

/* ------------------------------------------------------- sign and verify --- */

/**
 * Sign bytes. Returns base64.
 *
 * Takes BYTES, not a string or an object, and that is on purpose: the caller
 * must have built a canonical, domain-separated transcript first
 * (`identity-binding.js`), because a signature over an ambiguous encoding is a
 * signature over whatever an attacker can make the encoding also mean.
 */
export async function signBytes (identity, bytes) {
  if (!identity?.privateKey) throw new Error('a private signing key is required')
  if (!RAW_LEN[identity.algo]) throw new Error(`unsupported signing algo: ${identity.algo}`)
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('nothing to sign')
  const sig = await crypto.subtle.sign(useParams(identity.algo), identity.privateKey, bytes)
  return toB64(sig)
}

/**
 * Check a signature. Returns a BOOLEAN and NEVER THROWS.
 *
 * Both halves of that matter. A verifier that throws on a malformed signature is
 * a denial-of-service surface — anyone who can hand you bytes can crash the
 * path — and worse, it pushes the caller into `try { verify() } catch { }`,
 * where the catch block is one careless edit away from meaning "accepted".
 *
 * So every failure — bad base64, wrong length, unknown algorithm, an unimportable
 * key, a genuine mismatch — funnels to the same `false`. There is no input for
 * which this returns true without WebCrypto having said so.
 */
export async function verifyBytes ({ publicKeyB64, publicKey, algo }, bytes, sigB64) {
  try {
    if (!RAW_LEN[algo]) return false
    if (!(bytes instanceof Uint8Array) || !bytes.length) return false
    if (typeof sigB64 !== 'string' || !sigB64) return false

    let sig
    try { sig = fromB64(sigB64) } catch { return false }
    if (sig.length !== SIG_LEN) return false

    const key = publicKey || (await importSigningPublicKey(publicKeyB64, algo))
    return await crypto.subtle.verify(useParams(algo), key, sig, bytes)
  } catch {
    return false
  }
}

/* ------------------------------------------------------------ transcript --- */

const enc = new TextEncoder()

/**
 * Canonical, unambiguous encoding of a list of fields.
 *
 * LENGTH-PREFIXED, NOT DELIMITED, and this is the single most important detail
 * in the file. Joining fields with a separator makes distinct claims encode
 * identically the moment a field can contain the separator: `["ab", "c"]` and
 * `["a", "bc"]` are the same bytes under `join('|')`. A signature is only ever a
 * signature over BYTES, so two claims with one encoding is two claims with one
 * signature — sign the harmless one, present the other.
 *
 * Every field is `uint32be(length) || bytes`, so no field boundary can be moved
 * without changing the bytes. `e2e-v2.js` gets away with `|`-joining because its
 * inputs are base64 and an opaque id — this signs user-controlled strings, so it
 * cannot.
 *
 * The leading field COUNT is redundant given per-field lengths: a signature
 * covers the whole buffer, so a field cannot be appended or dropped unobserved
 * either way. Mutation testing confirms no test can distinguish its absence. It
 * stays because it costs four bytes and makes the buffer self-describing if
 * anything ever parses one out of a longer stream — but it is not carrying the
 * canonicality argument, the per-field lengths are.
 */
/**
 * Bounds. A transcript is signed, so it is attacker-influenced input to a
 * primitive, and an unbounded one is a memory-exhaustion path reachable by
 * anyone who can put a long string in a claim field. Both limits are far above
 * any legitimate value — a public key is 65 bytes and an account id is tens —
 * so hitting one means something is wrong, not that the limit is tight.
 */
export const MAX_FIELD_BYTES = 64 * 1024
export const MAX_TRANSCRIPT_BYTES = 256 * 1024

/** The canonical field count limit. `uint32be` could carry more; nothing
 *  legitimate needs it, and a bound that is never reached is free. */
export const MAX_FIELDS = 64

export function transcript (domain, fields) {
  if (typeof domain !== 'string' || !domain) throw new Error('a transcript needs a domain')
  if (!Array.isArray(fields)) throw new Error('a transcript needs a list of fields')
  if (fields.length > MAX_FIELDS) throw new Error(`a transcript may not have more than ${MAX_FIELDS} fields`)

  const parts = [enc.encode(domain), ...fields.map((f) => {
    /* THE ACCEPTED TYPES, AND WHY NO OTHERS. Bytes pass through. Strings are
     * UTF-8, which is the only text encoding this format has. Finite numbers
     * become their DECIMAL STRING — chosen over a fixed-width integer because
     * every value in this protocol that is a number is a millisecond timestamp
     * that already round-trips through JSON as decimal, and two encodings for
     * one value is the whole hazard this function exists to remove.
     *
     * Everything else throws. Accepting `null` as empty, or an object via
     * toString, would make two different claims encode identically — which is
     * the collision property, arrived at through the type system instead of
     * through the delimiter. */
    if (f instanceof Uint8Array) return f
    if (typeof f === 'string') return enc.encode(f)
    if (typeof f === 'number' && Number.isFinite(f)) return enc.encode(String(f))
    throw new Error(`a transcript field must be bytes, a string or a finite number, got ${typeof f}`)
  })]

  for (const p of parts) {
    if (p.length > MAX_FIELD_BYTES) throw new Error(`a transcript field may not exceed ${MAX_FIELD_BYTES} bytes`)
  }

  let total = 0
  for (const p of parts) total += 4 + p.length
  if (4 + total > MAX_TRANSCRIPT_BYTES) {
    throw new Error(`a transcript may not exceed ${MAX_TRANSCRIPT_BYTES} bytes`)
  }
  const out = new Uint8Array(4 + total)
  const view = new DataView(out.buffer)
  view.setUint32(0, parts.length, false)
  let at = 4
  for (const p of parts) {
    view.setUint32(at, p.length, false)
    at += 4
    out.set(p, at)
    at += p.length
  }
  return out
}
