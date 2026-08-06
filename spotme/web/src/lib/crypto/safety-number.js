/**
 * Spot Me — safety numbers. Key AUTHENTICATION, the gap ADR-001 left open.
 *
 * WHAT ADR-001 ACHIEVED, AND WHAT IT DID NOT. `e2e-v2.js` agrees a room key by
 * X25519 ECDH so the server cannot derive it. But the server is also the thing
 * that HANDS OUT the public keys: `GET /api/v2/auth/keys/:userId`. A malicious
 * or compromised server can answer with a key it holds the private half of,
 * agree one room key with each side, and read everything while both clients
 * report `e2e_v2`. `e2e-v2.js` says this itself, in the header, and defers it.
 *
 * That is not a small caveat. Until the two humans can compare something out of
 * band, the ECDH proves only that SOMEBODY holds the other private key — not
 * that it is the person named on the screen. This module produces the thing they
 * compare.
 *
 * CONSTRUCTION. Signal's displayable-fingerprint scheme, followed deliberately
 * rather than invented:
 *
 *   per party:  h = SHA-512(version || key || identifier)
 *               repeat 5200x:  h = SHA-512(h || key)
 *               take the first 30 bytes
 *               split into 6 groups of 5 bytes
 *               each group, big-endian, mod 100000, zero-padded to 5 digits
 *   combined:   the two 30-digit strings, SORTED, concatenated -> 60 digits
 *
 * WHY EACH PIECE. The 5200 iterations make a brute-force search for a key whose
 * fingerprint collides with a target expensive; a single hash would let an
 * attacker grind out a substitute key with a matching display string. The
 * identifier is mixed in so a key lifted from one account cannot be replayed
 * under another. Sorting means both devices show the same 60 digits without
 * either side having to know who "goes first".
 *
 * NOT SIGNAL-INTEROPERABLE, and it must not be described that way. The scheme is
 * the same; the version prefix and identifier bytes are Spot Me's, so numbers
 * from the two apps will differ. Following the construction buys the security
 * argument and the human factors (60 digits, 12 groups of 5 — sized so people
 * actually read them out), not compatibility.
 *
 * PURE ON PURPOSE. No storage, no DOM, no network — same discipline as
 * `e2e-v2.js`, so `test/safety-number.test.js` exercises the shipped module on
 * Node's WebCrypto with no mocks.
 */

/** Bumping this changes every displayed number, so it is a breaking change to
 *  the human workflow: everyone who verified must verify again. */
const VERSION = new Uint8Array([0x00, 0x00])

/** Signal's iteration count. Lowering it weakens collision resistance; raising
 *  it costs the user a longer wait.
 *
 *  MEASURED, not assumed: ~750 ms for a full safety number (two parties, 10,400
 *  SHA-512s) on a cloud container. A mid-range phone will be slower still, so
 *  this MUST NOT be computed on the render path — derive it when the
 *  verification screen opens, show a spinner, and cache the result against the
 *  two public keys. An earlier draft of this comment guessed "single-digit
 *  milliseconds", which is wrong by three orders of magnitude and would have
 *  led someone to call it during a paint. */
const ITERATIONS = 5200

/** 30 bytes -> 6 groups of 5 -> 30 digits per party, 60 combined. */
const FINGERPRINT_BYTES = 30
const GROUP_BYTES = 5
const DIGITS_PER_GROUP = 5

const enc = new TextEncoder()

const fromB64 = (b64) => {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

function concat (...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

/**
 * One party's 30 digits.
 *
 * `identifier` is the stable account id, NOT the username: usernames can be
 * released and re-claimed (`usernameRelease` renames the row), so a fingerprint
 * bound to one would silently change hands with the name.
 */
async function partyDigits (publicKeyB64, identifier) {
  if (typeof publicKeyB64 !== 'string' || !publicKeyB64) {
    throw new Error('a public key is required to compute a safety number')
  }
  if (typeof identifier !== 'string' || !identifier) {
    throw new Error('an account identifier is required to compute a safety number')
  }
  let key
  try { key = fromB64(publicKeyB64) } catch { throw new Error('public key is not base64') }
  if (!key.length) throw new Error('public key is empty')

  let hash = new Uint8Array(
    await crypto.subtle.digest('SHA-512', concat(VERSION, key, enc.encode(identifier)))
  )
  for (let i = 0; i < ITERATIONS; i++) {
    hash = new Uint8Array(await crypto.subtle.digest('SHA-512', concat(hash, key)))
  }

  let digits = ''
  for (let g = 0; g < FINGERPRINT_BYTES / GROUP_BYTES; g++) {
    // Big-endian over 5 bytes = at most 2^40, well inside Number's exact range,
    // so no BigInt is needed and the arithmetic stays exact.
    let n = 0
    for (let b = 0; b < GROUP_BYTES; b++) n = n * 256 + hash[g * GROUP_BYTES + b]
    digits += String(n % 100000).padStart(DIGITS_PER_GROUP, '0')
  }
  return digits
}

/**
 * The 60-digit number BOTH devices display for a conversation.
 *
 * Sorted, so neither side needs to know which of them is "first" — the two
 * devices compute the identical string from the same four inputs.
 *
 * @param self {{ publicKeyB64: string, userId: string }}
 * @param peer {{ publicKeyB64: string, userId: string }}
 */
export async function safetyNumber (self, peer) {
  const [mine, theirs] = await Promise.all([
    partyDigits(self?.publicKeyB64, self?.userId),
    partyDigits(peer?.publicKeyB64, peer?.userId)
  ])
  return [mine, theirs].sort().join('')
}

/** Grouped for reading aloud: 12 groups of 5. Display only — never compare
 *  formatted strings, compare the raw 60 digits. */
export function formatSafetyNumber (digits) {
  if (typeof digits !== 'string' || !/^\d{60}$/.test(digits)) {
    throw new Error('a safety number is exactly 60 digits')
  }
  return (digits.match(/\d{5}/g) || []).join(' ')
}

/**
 * What the QR encodes.
 *
 * Deliberately NOT the 60 digits. Scanning a QR that carried only the display
 * string would verify nothing an attacker could not also produce — the point of
 * scanning is to compare the KEYS, so the payload carries both public keys and
 * both ids, and the scanner recomputes the number itself. A mismatch between
 * the recomputed number and the one on screen is the detection.
 *
 * Versioned so a future format change is refused rather than misparsed.
 */
export const PAYLOAD_VERSION = 2

/** Which safety-number construction produced the digits. Bound INTO the payload
 *  so a code from a build with a different VERSION prefix is refused rather
 *  than silently compared against numbers it cannot equal. */
export const SAFETY_VERSION = VERSION.join('.')

/**
 * How long a scanned code stays acceptable.
 *
 * A QR code is scanned in person, off a screen that is in the room. Minutes is
 * already generous. Without a bound, a code photographed once is valid forever:
 * an attacker who captured it — over someone's shoulder, from a screenshot in a
 * chat, from a shared screen — could present it later against a key that had
 * since changed, and the scan would still say "verified".
 */
export const PAYLOAD_MAX_AGE_MS = 5 * 60_000

export function encodeVerificationPayload (self, peer, opts = {}) {
  for (const p of [self, peer]) {
    if (!p?.publicKeyB64 || !p?.userId) throw new Error('both parties need a public key and an id')
  }
  const { roomId, at } = opts
  if (!roomId) throw new Error('a verification payload must name the conversation')
  if (typeof at !== 'number') throw new Error('a verification payload must carry an issue time')
  return JSON.stringify({
    v: PAYLOAD_VERSION,
    t: 'spotme-safety',
    a: { k: self.publicKeyB64, i: self.userId },
    b: { k: peer.publicKeyB64, i: peer.userId },
    /* THE TWO FIELDS v1 LACKED, and the reason this is v2.
     *
     * `r` binds the code to ONE conversation. Without it a code proving
     * "these two keys belong together" verifies any room those two people
     * share, so scanning in one chat would silently mark another verified —
     * including one whose key had since changed.
     *
     * `ts` bounds its life. See PAYLOAD_MAX_AGE_MS.
     *
     * `sv` binds the construction that produced the digits, so a build with a
     * different VERSION prefix is refused rather than compared against numbers
     * it can never equal. */
    r: roomId,
    ts: at,
    sv: SAFETY_VERSION
  })
}

/**
 * Read a scanned payload. Returns the two parties, or throws.
 *
 * The caller must then RECOMPUTE the safety number from these keys and compare
 * it to what its own side shows. Trusting the payload's word for anything is
 * the whole failure mode this is built to avoid, so no number is carried in it.
 */
export function decodeVerificationPayload (text) {
  let data
  try { data = JSON.parse(String(text)) } catch { throw new Error('not a Spot Me verification code') }
  if (data?.t !== 'spotme-safety') throw new Error('not a Spot Me verification code')
  /* v1 still DECODES. It predates conversation binding and expiry, so it can
   * never satisfy `verifyScannedPayload` — but decoding it lets the caller say
   * "this code is too old, generate a new one" instead of "not a Spot Me code",
   * which would send someone hunting for the wrong problem. */
  if (data?.v !== 1 && data?.v !== PAYLOAD_VERSION) {
    throw new Error(`unsupported verification code version: ${data?.v}`)
  }
  const a = data.a
  const b = data.b
  for (const p of [a, b]) {
    if (typeof p?.k !== 'string' || typeof p?.i !== 'string' || !p.k || !p.i) {
      throw new Error('verification code is missing a key or an id')
    }
  }
  return {
    version: data.v,
    a: { publicKeyB64: a.k, userId: a.i },
    b: { publicKeyB64: b.k, userId: b.i },
    roomId: typeof data.r === 'string' ? data.r : null,
    issuedAt: typeof data.ts === 'number' ? data.ts : null,
    safetyVersion: typeof data.sv === 'string' ? data.sv : null
  }
}

/**
 * Did a scan confirm the conversation on this screen?
 *
 * Recomputes from the SCANNED keys and compares to the number this device
 * derived from the keys it holds. Equal means both devices agree on both public
 * keys, which is exactly the claim a server-in-the-middle cannot satisfy: it
 * would have had to give each side a different key, so the two numbers diverge.
 */
export const SCAN_ERR = Object.freeze({
  UNREADABLE: 'UNREADABLE',
  OLD_FORMAT: 'OLD_FORMAT',
  WRONG_SAFETY_VERSION: 'WRONG_SAFETY_VERSION',
  WRONG_ROOM: 'WRONG_ROOM',
  EXPIRED: 'EXPIRED',
  WRONG_SELF_KEY: 'WRONG_SELF_KEY',
  WRONG_PEER_KEY: 'WRONG_PEER_KEY',
  DIGITS_DIFFER: 'DIGITS_DIFFER'
})

export async function verifyScannedPayload (text, expectedDigits, ctx = {}) {
  let decoded
  try {
    decoded = decodeVerificationPayload(text)
  } catch (err) {
    return { match: false, error: SCAN_ERR.UNREADABLE, message: err.message }
  }
  const { a, b, version, roomId, issuedAt, safetyVersion } = decoded
  const no = (error) => ({ match: false, error, decoded })

  /* EVERY BINDING IS CHECKED BEFORE THE DIGITS, and that ordering is the point.
   * A matching 60 digits proves only that two keys belong together. It says
   * nothing about WHICH conversation, WHEN, or whether those are the keys this
   * device actually holds — so treating a digit match as sufficient is how a
   * genuine code for one chat comes to verify another. */
  if (version !== PAYLOAD_VERSION) return no(SCAN_ERR.OLD_FORMAT)
  if (safetyVersion !== SAFETY_VERSION) return no(SCAN_ERR.WRONG_SAFETY_VERSION)
  if (!ctx.roomId || roomId !== ctx.roomId) return no(SCAN_ERR.WRONG_ROOM)
  if (typeof issuedAt !== 'number' || typeof ctx.at !== 'number' ||
      ctx.at - issuedAt > PAYLOAD_MAX_AGE_MS || issuedAt - ctx.at > PAYLOAD_MAX_AGE_MS) {
    // Future-dated too: a clock-skewed or hand-made code must not buy extra life.
    return no(SCAN_ERR.EXPIRED)
  }

  /* The scanned code names two keys. They must be the two keys THIS device is
   * working with — its own identity, and the key it actually trusts for this
   * peer. Otherwise a valid code for a different pair, or for a peer key that
   * has since been replaced, would verify against numbers computed elsewhere. */
  const pair = [a, b]
  const self = pair.find((p) => p.publicKeyB64 === ctx.selfKey)
  if (!ctx.selfKey || !self) return no(SCAN_ERR.WRONG_SELF_KEY)
  const peer = pair.find((p) => p !== self)
  if (!ctx.peerKey || peer.publicKeyB64 !== ctx.peerKey) return no(SCAN_ERR.WRONG_PEER_KEY)

  const scanned = await safetyNumber(a, b)
  if (scanned !== expectedDigits) return { match: false, error: SCAN_ERR.DIGITS_DIFFER, scanned, decoded }
  /* `verifiedKey` is what the caller must record — the key that was ACTUALLY
   * compared, taken from the scanned payload, never re-read from anywhere. */
  return { match: true, scanned, decoded, verifiedKey: peer.publicKeyB64, peerId: peer.userId }
}
