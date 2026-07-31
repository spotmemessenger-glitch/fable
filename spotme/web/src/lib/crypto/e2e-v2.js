/**
 * Spot Me — e2e_v2 key agreement. The fix for V-19.
 *
 * WHAT WAS WRONG. A DM's key used to be `stableHash(idA:idB) + stableHash(...)`
 * — cyrb53, twice, over two user ids the server stores in the User table. That
 * is 128 bits of output and ZERO bits of entropy, with the algorithm shipped in
 * the public bundle. The server could recompute every DM key. See ADR-001.
 *
 * WHAT THIS DOES INSTEAD. Each device generates a NON-EXPORTABLE X25519 pair.
 * Only the public half is uploaded. A room key is the ECDH shared secret run
 * through HKDF-SHA256, bound to the room id and to both public keys. The server
 * holds two public keys and ciphertext; recovering the room key means solving
 * a discrete log, not evaluating a hash.
 *
 * WHY IT IS PURE. No IndexedDB, no `window`, no storage of any kind lives here
 * — persistence is `identity-store.js`'s job. That separation is deliberate:
 * it is what lets test/crypto.test.js run this exact code on Node's WebCrypto
 * with no mocks, so the V-19 assertions are made against the shipped module
 * rather than a stand-in.
 *
 * WHAT THIS DOES NOT GIVE YOU, and must never be claimed:
 *   - NO forward secrecy. Static pairs: one stolen device key opens that pair's
 *     whole v2 history. Ratcheting is out of scope.
 *   - NO protection from a malicious SERVER. It hands out the public keys, so
 *     it could substitute its own and sit in the middle of a NEW conversation.
 *     Defeating that needs an out-of-band fingerprint comparison — Phase 2.
 */

export const E2E_V1 = 'e2e_v1'
export const E2E_V2 = 'e2e_v2'

/** Raw public key sizes, which is how we infer a peer's curve from the wire. */
const RAW_LEN = { X25519: 32, 'P-256': 65 }

/* --------------------------------------------------------------- base64 */
/* btoa/atob rather than Buffer: this module runs in the browser, the Android
 * WebView and Node, and Buffer exists in only one of the three. */

const toB64 = (buf) => {
  const b = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s)
}

const fromB64 = (b64) => {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/* ---------------------------------------------------------- negotiation */

let cachedAlgo = null

/**
 * X25519 where the runtime has it, P-256 otherwise.
 *
 * The fallback is not hypothetical: Capacitor's Android System WebView updates
 * independently of the app, so a user can be several Chrome releases behind the
 * browser this was developed in. Failing to chat is a worse outcome than a
 * different, still-strong curve — and the curve is recorded per identity so a
 * peer can tell whether agreement is even possible.
 */
export async function negotiateAlgo () {
  if (cachedAlgo) return cachedAlgo
  try {
    await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
    cachedAlgo = 'X25519'
  } catch {
    cachedAlgo = 'P-256'
  }
  return cachedAlgo
}

const params = (algo) => (algo === 'X25519' ? { name: 'X25519' } : { name: 'ECDH', namedCurve: 'P-256' })

/* ------------------------------------------------------------- identity */

/**
 * A device identity. `extractable` is FALSE and that is the entire point: the
 * private key becomes a handle this page can compute with but cannot serialise,
 * so no bug, no XSS and no malicious build can upload it. It is why the key is
 * kept in IndexedDB (which stores live CryptoKeys) and not localStorage (which
 * stores strings, and would therefore have forced an extractable key).
 */
export async function generateIdentity ({ algo } = {}) {
  const use = algo || (await negotiateAlgo())
  if (!RAW_LEN[use]) throw new Error(`unsupported algo: ${use}`)
  const pair = await crypto.subtle.generateKey(params(use), false, ['deriveBits'])
  return { algo: use, publicKey: pair.publicKey, privateKey: pair.privateKey }
}

/** The public half, base64 — this is what goes in `User.publicKey`. */
export async function exportPublicKeyB64 (identity) {
  if (!identity?.publicKey) throw new Error('no public key to export')
  return toB64(await crypto.subtle.exportKey('raw', identity.publicKey))
}

/**
 * A peer's public key off the wire. The curve is inferred from the raw length
 * (32 = X25519, 65 = uncompressed P-256) so the wire format stays a bare base64
 * string, and anything that is neither is refused rather than guessed at.
 */
export async function importPeerPublicKey (b64, algo) {
  if (typeof b64 !== 'string' || !b64) throw new Error('peer public key missing')
  let raw
  try { raw = fromB64(b64) } catch { throw new Error('peer public key is not base64') }
  const use = algo || Object.keys(RAW_LEN).find((k) => RAW_LEN[k] === raw.length)
  if (!use || raw.length !== RAW_LEN[use]) {
    throw new Error(`peer public key has unexpected length ${raw.length}`)
  }
  return crypto.subtle.importKey('raw', raw, params(use), false, [])
}

/* ----------------------------------------------------------- derivation */

/**
 * The room key: ECDH → HKDF-SHA256 → non-extractable AES-GCM.
 *
 * `info` binds the key to the room AND to both public keys, sorted so that both
 * sides compute the same string without exchanging anything extra. The room
 * binding means a key stolen from one conversation does not open another
 * between the same two people; the key binding means a substituted public key
 * yields a different room key rather than a silently compatible one.
 */
export async function deriveRoomKey ({ identity, peerPublicKeyB64, roomId } = {}) {
  if (!identity?.privateKey) {
    throw new Error('a private identity key is required — public keys alone cannot derive a room key')
  }
  if (!roomId || typeof roomId !== 'string') {
    throw new Error('roomId is required: room keys must be room-bound')
  }

  const peerKey = await importPeerPublicKey(peerPublicKeyB64, identity.algo)
  if (peerKey.algorithm?.name !== identity.privateKey.algorithm?.name) {
    throw new Error('peer is on a different curve — no agreement is possible')
  }

  let shared
  try {
    shared = await crypto.subtle.deriveBits(
      identity.algo === 'X25519'
        ? { name: 'X25519', public: peerKey }
        : { name: 'ECDH', public: peerKey },
      identity.privateKey,
      256
    )
  } catch (err) {
    throw new Error(`key agreement failed: ${err.message}`)
  }

  const mine = await exportPublicKeyB64(identity)
  const [x, y] = [mine, peerPublicKeyB64].sort()
  const info = new TextEncoder().encode(`spotme-e2e-v2|${roomId}|${x}|${y}`)
  const salt = new TextEncoder().encode('spotme-e2e-v2-salt')

  const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,                              // non-extractable: the key never leaves either
    ['encrypt', 'decrypt']
  )
}

/* ------------------------------------------------------------ the flaw */

/**
 * cyrb53, exactly as `reach.js` computes it, EXPORTED ONLY SO A TEST CAN PROVE
 * IT IS BROKEN. It reproduces a v1 secret from two user ids and nothing else,
 * which is the whole vulnerability. Nothing in the app may call this to create
 * a room — v1 rooms keep their existing secret from `reach.js`; this is the
 * negative control that stops the scheme being quietly reintroduced.
 */
export function deriveV1SecretForContrast (idA, idB) {
  const [a, b] = [idA, idB].sort()
  const key = `${a}:${b}`
  return cyrb53(`spotme-dm-secret-v1:${key}`) + cyrb53(`spotme-dm-secret-v2:${key}`)
}

function cyrb53 (input) {
  let h1 = 0xdeadbeef ^ input.length
  let h2 = 0x41c6ce57 ^ input.length
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}
