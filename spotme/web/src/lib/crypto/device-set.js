/**
 * Spot Me — multi-device safety numbers. ADR-006 + ADR-008 §BLOCKING. PURE.
 *
 * THE PROBLEM THIS SOLVES, stated in ADR-008 §BLOCKING: once a user has a
 * device *set*, a safety number derived from ONE device's key is a lie. Sixty
 * digits over one key say nothing about the others, so two people comparing
 * them believe they have verified an identity when they have verified a
 * fraction of it — and a device added later, honestly or by an attacker, is
 * invisible to that number.
 *
 * THE CONSTRUCTION (ADR-008 §BLOCKING option 3, the RECOMMENDED one, pending
 * the owner's ratification): the party's fingerprint is computed over a
 * COMMITMENT to the whole active device set, not a single key. Adding or
 * removing a device changes the commitment, so it changes the number — which
 * means **adding a device is a visible verification event for every contact**,
 * exactly the honesty the single-key version cannot give. That visibility is
 * the property, not a cost.
 *
 * WHY NOT THE OTHER OPTIONS (recorded so the choice is a decision, not a
 * default):
 *   1. One device-to-device key — today's version. Honest only at one device;
 *      it is kept as SAFETY_VERSION 0.0 and coexists (ADR-006), it does not
 *      scale to a set.
 *   2. A user identity key with an authenticated device set — needs an
 *      account-level key that can be transferred or escrowed, which ADR-008 §6
 *      rules out (no key backup, no recovery). Rejected on that ground.
 *   4. Some other versioned account construction — open, but nothing proposed
 *      beats option 3's simplicity, and every added mechanism is added attack
 *      surface.
 *
 * COEXISTENCE. This is SAFETY_VERSION 1 ([0x00,0x01]); the single-device
 * version 0 still computes and displays for single-device accounts. A payload
 * carries its version, and a scanner refuses a version it did not expect
 * (ADR-006 coexistence) rather than silently comparing numbers from two
 * different constructions.
 *
 * NOT WIRED IN. Multi-device is Phase 5, gated on the owner ratifying THIS
 * construction (ADR-008 §BLOCKING: "decided before multi-device is
 * implemented, not during"). `test/e2e-v3-not-shipped.test.js`'s sibling fence
 * keeps it unreachable; nothing here activates a device set.
 *
 * PURE, like `safety-number.js`: no storage, no DOM, no network.
 */

/** SAFETY_VERSION 1 — the device-set construction. Distinct from
 *  `safety-number.js`'s 0.0 so the two can never be compared by accident. */
export const DEVICE_SET_VERSION = new Uint8Array([0x00, 0x01])
export const DEVICE_SET_SAFETY_VERSION = DEVICE_SET_VERSION.join('.')

/** Signal's iteration count, matched to `safety-number.js` so the two
 *  constructions have the same collision resistance and the same cost profile
 *  (compute off the render path, cache against the commitment). */
const ITERATIONS = 5200
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
 * A canonical commitment to a device set.
 *
 * LENGTH-PREFIXED and SORTED, the same discipline `signing-identity.js`
 * applies to every signed structure: each device contributes
 * `uint32be(len(deviceId)) || deviceId || uint32be(len(key)) || key`, the
 * devices are sorted by their raw bytes, and the whole is prefixed with the
 * device count. Two clients holding the same set compute the identical
 * commitment without agreeing an order, and no device boundary can be moved
 * without changing the bytes — so `[{a},{bc}]` and `[{ab},{c}]` cannot collide.
 *
 * `devices` is `[{ deviceId: string, signingPublicKeyB64: string }]`. The
 * SIGNING key is committed (not the agreement key) because it is the durable
 * identity anchor (ADR-006/008); the agreement key rotates freely.
 */
export async function deviceSetCommitment (devices) {
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new Error('a device set needs at least one device')
  }
  const encoded = devices.map((d) => {
    const id = enc.encode(String(d?.deviceId ?? ''))
    if (!id.length) throw new Error('every device needs a deviceId')
    let key
    try { key = fromB64(String(d?.signingPublicKeyB64 ?? '')) } catch { throw new Error('device signing key is not base64') }
    if (!key.length) throw new Error('every device needs a signing public key')
    return lp(id, key)
  })
  // Sort by the encoded bytes so the set — not the order — determines the commitment.
  encoded.sort(compareBytes)
  const count = new Uint8Array(4)
  new DataView(count.buffer).setUint32(0, devices.length, false)
  const commitment = await crypto.subtle.digest('SHA-512', concat(count, ...encoded))
  return new Uint8Array(commitment)
}

function lp (id, key) {
  const out = new Uint8Array(4 + id.length + 4 + key.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, id.length, false)
  out.set(id, 4)
  view.setUint32(4 + id.length, key.length, false)
  out.set(key, 8 + id.length)
  return out
}
function compareBytes (a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) { if (a[i] !== b[i]) return a[i] - b[i] }
  return a.length - b.length
}

/**
 * One party's 30 digits, over the device-set commitment.
 *
 * Identical iterated-hash shape to `safety-number.js`'s single-key version,
 * but the seed is the account's device-set commitment rather than one key —
 * so the number changes the instant the device set does.
 */
async function partyDigits (commitment, identifier) {
  if (!(commitment instanceof Uint8Array) || commitment.length === 0) {
    throw new Error('a device-set commitment is required')
  }
  if (typeof identifier !== 'string' || !identifier) {
    throw new Error('an account identifier is required')
  }
  let hash = new Uint8Array(
    await crypto.subtle.digest('SHA-512', concat(DEVICE_SET_VERSION, commitment, enc.encode(identifier))),
  )
  for (let i = 0; i < ITERATIONS; i++) {
    hash = new Uint8Array(await crypto.subtle.digest('SHA-512', concat(hash, commitment)))
  }
  let digits = ''
  for (let g = 0; g < FINGERPRINT_BYTES / GROUP_BYTES; g++) {
    let n = 0
    for (let b = 0; b < GROUP_BYTES; b++) n = n * 256 + hash[g * GROUP_BYTES + b]
    digits += String(n % 100000).padStart(DIGITS_PER_GROUP, '0')
  }
  return digits
}

/**
 * The 60-digit number both accounts display, each over the OTHER's full device
 * set. Sorted, so neither side needs to know which is "first" — the two
 * compute the identical string.
 *
 * @param self {{ devices: [{deviceId, signingPublicKeyB64}], userId: string }}
 * @param peer {{ devices: [{deviceId, signingPublicKeyB64}], userId: string }}
 */
export async function deviceSetSafetyNumber (self, peer) {
  const [mine, theirs] = await Promise.all([
    partyDigits(await deviceSetCommitment(self?.devices), self?.userId),
    partyDigits(await deviceSetCommitment(peer?.devices), peer?.userId),
  ])
  return [mine, theirs].sort().join('')
}
