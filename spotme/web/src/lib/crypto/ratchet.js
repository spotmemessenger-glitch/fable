/**
 * Spot Me — the Double Ratchet. e2e_v3, ADR-004 + 004a/004b. PURE.
 *
 * WHAT THE RATCHET BUYS over X3DH's one shared secret: a NEW message key for
 * every message, and a NEW root every time the conversation turns around. So a
 * key compromised today does not read yesterday's messages (forward secrecy)
 * and stops reading tomorrow's as soon as one healthy round trip happens
 * (break-in recovery). X3DH (Phase 3) seeds the first root; this advances it.
 *
 * TWO RATCHETS TURNING TOGETHER:
 *   - The DH ratchet. Each side carries a ratchet keypair; whenever it receives
 *     a message under a NEW peer ratchet public key, it does one DH and feeds
 *     the result through the root KDF, minting a fresh receiving chain — and on
 *     its next send it generates a new keypair and mints a fresh sending chain.
 *     That is the step that heals a compromise.
 *   - The symmetric (message) ratchet. Within a chain, each message advances
 *     the chain key by one KDF step and takes a one-time message key. That is
 *     the step that gives every message its own key.
 *
 * THE KDF LADDER, pinned by the 004b oracle and reproduced byte-for-byte in
 * `test/ratchet.test.js`:
 *   root step:  HKDF(salt=root, ikm=DH,   info="spotme/e2e_v3/chain", 64) -> root' || chain
 *   msg  step:  HKDF(salt=chain, ikm=0x01, info="spotme/e2e_v3/msg",   64) -> chain' || msgKey
 *
 * INJECTED SEAMS, so the SHIPPED bytes are what the vectors test:
 *   - `keygen()` -> a fresh X25519 ratchet keypair. Random in production; the
 *     vector test injects the oracle's deterministic counter-KDF sequence so
 *     `ratchet_pub` and the whole ciphertext reproduce exactly.
 *   - `aead` -> `{ seal(key, iv, pt, aad), open(key, iv, ct, aad), makeIv(key) }`.
 *     Production seals with a RANDOM 12-byte IV (each message key is used once,
 *     so a random IV is safe and a reused one would be catastrophic). The
 *     vector test injects the oracle's derived-IV AEAD to match `ciphertext_hex`.
 *
 * NOT WIRED IN. e2e_v3 rides behind the `spotme.e2e3` flag (004a §12), absent
 * by default; `test/e2e-v3-not-shipped.test.js` fails the build if any app
 * module imports this. The wire framing, AAD, and bounds are 004a; the failure
 * behaviour (fail closed on a crossed bound, never auto-reset) is 004a §5.
 */

const enc = new TextEncoder()

/* -------------------------------------------------------------- labels ---- */
export const LABEL_ROOT_CHAIN = 'spotme/e2e_v3/chain' // the root/DH step's HKDF info
export const LABEL_MSG = 'spotme/e2e_v3/msg' // the symmetric step's HKDF info
export const AAD_PREFIX = 'spotme/e2e_v3'
export const MAGIC = 0x53
export const VERSION = 0x03

/* Bounds — MESSAGE-LOSS POLICIES, not tuning knobs (004a §5). Crossing one
 * loses messages permanently and the caller must surface it. */
export const MAX_SKIP_PER_CHAIN = 1000
export const MAX_SKIPPED_STORED = 2000

/* Header sizes (004a §2a): only these two lengths are legal, checkable before
 * any key material is touched. */
export const HDR_STEADY = 73

/* --------------------------------------------------------------- errors --- */
/** A defined protocol error, so a caller can tell "message lost to a bound"
 *  from "corrupt frame" from "wrong version" — never a bare throw the send
 *  path might swallow into "accepted". */
export class RatchetError extends Error {
  constructor (code, message) { super(message); this.name = 'RatchetError'; this.code = code }
}

/* --------------------------------------------------------------- crypto --- */
async function hkdf64 (saltBytes, ikmBytes, infoStr) {
  const ikm = await crypto.subtle.importKey('raw', ikmBytes, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: enc.encode(infoStr) },
    ikm, 512,
  )
  return new Uint8Array(bits)
}

/** DH ratchet root step: root' || chain = HKDF(salt=root, ikm=dh, info=chain). */
async function rootStep (rootKey, dhOut) {
  const out = await hkdf64(rootKey, dhOut, LABEL_ROOT_CHAIN)
  return { rootKey: out.slice(0, 32), chainKey: out.slice(32) }
}

/** Symmetric step: chain' || msgKey = HKDF(salt=chain, ikm=0x01, info=msg). */
async function messageStep (chainKey) {
  const out = await hkdf64(chainKey, new Uint8Array([0x01]), LABEL_MSG)
  return { chainKey: out.slice(0, 32), messageKey: out.slice(32) }
}

async function dh (privateKey, publicKey) {
  const bits = await crypto.subtle.deriveBits({ name: 'X25519', public: publicKey }, privateKey, 256)
  return new Uint8Array(bits)
}

/* --------------------------------------------------------- default seams -- */

/** Production ratchet keypair: random X25519. */
export async function defaultKeygen () {
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, pub }
}

/** Production AEAD: AES-256-GCM with a RANDOM IV. The message key is used
 *  exactly once (the ratchet guarantees it), which is the precondition that
 *  makes even a repeated IV survivable — but we never repeat one. */
export const defaultAead = {
  makeIv () { return crypto.getRandomValues(new Uint8Array(12)) },
  async seal (keyBytes, iv, plaintext, aad) {
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plaintext)
    return new Uint8Array(ct)
  },
  async open (keyBytes, iv, ct, aad) {
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt'])
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ct)
    return new Uint8Array(pt)
  },
}

/* ------------------------------------------------------- header + framing - */

/** Steady-state header (004a §2), 73 bytes. The X3DH prologue form is added by
 *  the session layer, not here — the ratchet only ever emits steady state. */
export function encodeHeader ({ sdev, rdev, ratchetPub, pn, n }) {
  const h = new Uint8Array(HDR_STEADY)
  const view = new DataView(h.buffer)
  h[0] = 0x00 // FLAGS: no prologue
  h.set(sdev, 1)
  h.set(rdev, 17)
  h.set(ratchetPub, 33)
  view.setUint32(65, pn, false)
  view.setUint32(69, n, false)
  return h
}

export function buildAad (roomId, headerBytes) {
  const prefix = enc.encode(AAD_PREFIX)
  const room = enc.encode(roomId)
  const out = new Uint8Array(prefix.length + 1 + room.length + headerBytes.length)
  let o = 0
  out.set(prefix, o); o += prefix.length
  out[o] = VERSION; o += 1
  out.set(room, o); o += room.length
  out.set(headerBytes, o)
  return out
}

export function framePayload (headerBytes, sealed) {
  const out = new Uint8Array(4 + headerBytes.length + sealed.length)
  const view = new DataView(out.buffer)
  out[0] = MAGIC
  out[1] = VERSION
  view.setUint16(2, headerBytes.length, false)
  out.set(headerBytes, 4)
  out.set(sealed, 4 + headerBytes.length)
  return out
}

/** Parse a payload into { header fields, iv, ct }. Refuses on any structural
 *  fault BEFORE key material is touched (004a §2a/§7) — the cheapest rejection. */
export function parsePayload (payload) {
  if (payload.length < 4 + HDR_STEADY + 12 + 16) throw new RatchetError('MALFORMED', 'payload too short')
  if (payload[0] !== MAGIC) throw new RatchetError('MALFORMED', 'bad magic')
  if (payload[1] !== VERSION) throw new RatchetError('VERSION', `unexpected version ${payload[1]}`)
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const hdrLen = view.getUint16(2, false)
  if (hdrLen !== HDR_STEADY) throw new RatchetError('MALFORMED', `illegal header length ${hdrLen}`)
  const header = payload.subarray(4, 4 + hdrLen)
  if (header[0] & 0xfe) throw new RatchetError('MALFORMED', 'reserved FLAGS bits set')
  const ratchetPub = header.slice(33, 65)
  const pn = view.getUint32(4 + 65, false)
  const n = view.getUint32(4 + 69, false)
  const rest = payload.subarray(4 + hdrLen)
  return { header: header.slice(), ratchetPub, pn, n, iv: rest.slice(0, 12), ct: rest.slice(12) }
}

/* --------------------------------------------------------- session ------- */
/*
 * State (all Uint8Array unless noted):
 *   rootKey
 *   self: { privateKey, publicKey (CryptoKey), pub (raw) } | null  — our ratchet keypair
 *   peerRatchetPub: raw | null                                     — theirs
 *   sendChainKey | null, sendN                                     — sending chain
 *   recvChainKey | null, recvN                                     — receiving chain
 *   prevSendN                                                      — PN for the header
 *   skipped: Map<"pubhex:n", msgKey>  (insertion-ordered = FIFO)
 *   sdev, rdev
 * The keygen and aead seams are carried on the session so encrypt/decrypt stay
 * pure functions of (session, message).
 */

function pubHex (u8) { return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('') }
function eq (a, b) { if (!a || !b || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0 }

/**
 * INITIATOR session (Alice) from the X3DH root. She immediately does one DH
 * ratchet step against Bob's initial ratchet public key (his signed prekey),
 * which mints her first sending chain — so her very first message already
 * ratchets.
 */
export async function initInitiator ({ sharedSecret, peerRatchetPub, sdev, rdev, keygen = defaultKeygen, aead = defaultAead }) {
  const self = await keygen()
  const peer = await importPub(peerRatchetPub)
  const { rootKey, chainKey } = await rootStep(sharedSecret, await dh(self.privateKey, peer))
  return {
    rootKey, self, peerRatchetPub: peerRatchetPub.slice(),
    sendChainKey: chainKey, sendN: 0,
    recvChainKey: null, recvN: 0, prevSendN: 0,
    skipped: new Map(), sdev: sdev.slice(), rdev: rdev.slice(),
    keygen, aead,
  }
}

/**
 * RESPONDER session (Bob) from the X3DH root. His ratchet keypair IS his signed
 * prekey (the key Alice already did DH against), so he has no sending chain yet
 * — his first send will generate a fresh keypair and DH-step. He receives
 * first.
 */
export async function initResponder ({ sharedSecret, selfRatchetKeyPair, sdev, rdev, keygen = defaultKeygen, aead = defaultAead }) {
  return {
    rootKey: sharedSecret.slice(), self: selfRatchetKeyPair,
    peerRatchetPub: null,
    sendChainKey: null, sendN: 0,
    recvChainKey: null, recvN: 0, prevSendN: 0,
    skipped: new Map(), sdev: sdev.slice(), rdev: rdev.slice(),
    keygen, aead,
  }
}

async function importPub (raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== 32) throw new RatchetError('MALFORMED', 'ratchet public key must be 32 bytes')
  return crypto.subtle.importKey('raw', raw, { name: 'X25519' }, false, [])
}

/** Encrypt one message. Advances the sending chain by one symmetric step. */
export async function encrypt (s, plaintext, roomId) {
  if (!s.sendChainKey) throw new RatchetError('NO_SEND_CHAIN', 'no sending chain — this side must receive first')
  const { chainKey, messageKey } = await messageStep(s.sendChainKey)
  const header = encodeHeader({ sdev: s.sdev, rdev: s.rdev, ratchetPub: s.self.pub, pn: s.prevSendN, n: s.sendN })
  const aad = buildAad(roomId, header)
  const iv = await s.aead.makeIv(messageKey)
  const ct = await s.aead.seal(messageKey, iv, enc.encode(typeof plaintext === 'string' ? plaintext : ''), aad)
  const sealed = new Uint8Array(iv.length + ct.length)
  sealed.set(iv, 0); sealed.set(ct, iv.length)
  const payload = framePayload(header, sealed)
  return { payload, session: { ...s, sendChainKey: chainKey, sendN: s.sendN + 1 } }
}

/**
 * Decrypt one message. The order of operations is the whole correctness of the
 * ratchet:
 *   1. If it names a NEW peer ratchet key, DH-step: skip any remaining keys of
 *      the current receiving chain up to its PN, then mint a fresh receiving
 *      chain and a fresh sending chain.
 *   2. If a stored skipped key matches, use it once and delete it (out-of-order
 *      and single-shot replay defence in one).
 *   3. Otherwise skip forward within the current chain up to N (storing the
 *      skipped keys), then take key N.
 * Every skipped-key derivation is bounded; crossing a bound FAILS CLOSED.
 */
export async function decrypt (s, payload, roomId) {
  const p = parsePayload(payload)
  const header = p.header
  const aad = buildAad(roomId, header)

  // 2 (fast path): a skipped key we already hold for exactly this (pub, n).
  const skKey = `${pubHex(p.ratchetPub)}:${p.n}`
  if (s.skipped.has(skKey)) {
    const mk = s.skipped.get(skKey)
    const pt = await open(s, mk, p, aad) // throws AUTH on tamper — before we mutate
    const skipped = new Map(s.skipped); skipped.delete(skKey)
    return { plaintext: pt, session: { ...s, skipped } }
  }

  let session = { ...s, skipped: new Map(s.skipped) }

  // 1: a new peer ratchet key → DH ratchet step.
  if (!session.peerRatchetPub || !eq(session.peerRatchetPub, p.ratchetPub)) {
    // A duplicate of an OLD chain whose keys are gone lands here with a pub we
    // no longer track; if it is not genuinely new it will fail below rather
    // than corrupt state.
    await skipRecvChain(session, p.pn) // finish the old receiving chain first
    await dhRatchet(session, p.ratchetPub)
  }

  // 3: skip forward within the current receiving chain up to N.
  await skipRecvChain(session, p.n)
  if (session.recvN !== p.n) {
    // The only way to be here is n < recvN with no stored key: a duplicate of a
    // message whose key was already consumed and deleted. Drop silently (004a
    // §5b) — never advance, never surface.
    throw new RatchetError('DUPLICATE', 'message key already consumed — dropped')
  }
  const { chainKey, messageKey } = await messageStep(session.recvChainKey)
  const pt = await open(session, messageKey, p, aad)
  session.recvChainKey = chainKey
  session.recvN = p.n + 1
  return { plaintext: pt, session }
}

async function open (s, messageKey, p, aad) {
  try {
    const bytes = await s.aead.open(messageKey, p.iv, p.ct, aad)
    return new TextDecoder().decode(bytes)
  } catch {
    // AAD mismatch (wrong room/version/edited header) or a tampered ciphertext
    // both land here as a GCM tag failure. Fail closed, defined error.
    throw new RatchetError('AUTH', 'authentication failed — frame refused')
  }
}

/** Advance the receiving chain up to `target`, storing each skipped message
 *  key. Bounded: a header claiming a gap beyond MAX_SKIP_PER_CHAIN is REFUSED,
 *  not honoured — that is the remote-DoS defence (004a §5). */
async function skipRecvChain (s, target) {
  if (s.recvChainKey === null) return
  if (target < s.recvN) return
  if (target - s.recvN > MAX_SKIP_PER_CHAIN) {
    throw new RatchetError('SKIP_BOUND', `refusing to derive ${target - s.recvN} skipped keys (max ${MAX_SKIP_PER_CHAIN})`)
  }
  const pubKey = pubHex(s.peerRatchetPub)
  while (s.recvN < target) {
    const { chainKey, messageKey } = await messageStep(s.recvChainKey)
    s.skipped.set(`${pubKey}:${s.recvN}`, messageKey)
    evictSkipped(s)
    s.recvChainKey = chainKey
    s.recvN += 1
  }
}

/** FIFO eviction at the stored-key bound (004a §5, §5's FIFO is Spot Me's
 *  decision, not the oracle's). Oldest inserted key goes first. */
function evictSkipped (s) {
  while (s.skipped.size > MAX_SKIPPED_STORED) {
    const oldest = s.skipped.keys().next().value
    s.skipped.delete(oldest)
  }
}

/** One DH ratchet step: adopt the peer's new ratchet key, mint a fresh
 *  receiving chain, then generate our own new keypair and mint a fresh sending
 *  chain. This is the step that heals a break-in. */
async function dhRatchet (s, newPeerPub) {
  s.prevSendN = s.sendN
  s.peerRatchetPub = newPeerPub.slice()
  const peer = await importPub(newPeerPub)
  // receiving chain from a DH with our CURRENT keypair
  const recv = await rootStep(s.rootKey, await dh(s.self.privateKey, peer))
  s.rootKey = recv.rootKey
  s.recvChainKey = recv.chainKey
  s.recvN = 0
  // new sending keypair, then sending chain
  s.self = await s.keygen()
  const send = await rootStep(s.rootKey, await dh(s.self.privateKey, peer))
  s.rootKey = send.rootKey
  s.sendChainKey = send.chainKey
  s.sendN = 0
}

/* --------------------------------------------------------- serialization - */
/*
 * State persisted to IndexedDB is LOCAL and NOT part of the wire format (004a
 * §5c) — versioned by the app, no canonical form. What must survive a
 * round-trip is exactly what carries a live session: both chain keys and
 * counters, the peer ratchet key, PN, and every skipped key (004a vector 09).
 * The ratchet PRIVATE key is a non-extractable CryptoKey and is serialized as
 * an opaque marker only — the persistence layer keeps the live handle beside
 * the plain state, exactly as the identity store does.
 */
export function serializeSession (s) {
  return {
    v: 1,
    rootKey: [...s.rootKey],
    peerRatchetPub: s.peerRatchetPub ? [...s.peerRatchetPub] : null,
    selfPub: [...s.self.pub],
    sendChainKey: s.sendChainKey ? [...s.sendChainKey] : null,
    sendN: s.sendN,
    recvChainKey: s.recvChainKey ? [...s.recvChainKey] : null,
    recvN: s.recvN,
    prevSendN: s.prevSendN,
    sdev: [...s.sdev], rdev: [...s.rdev],
    skipped: [...s.skipped.entries()].map(([k, v]) => [k, [...v]]),
  }
}

/** Restore, given the plain state and the live self keypair (which cannot be
 *  serialized because the private key is non-extractable). */
export function deserializeSession (plain, selfKeyPair, { keygen = defaultKeygen, aead = defaultAead } = {}) {
  const skipped = new Map((plain.skipped || []).map(([k, v]) => [k, Uint8Array.from(v)]))
  return {
    rootKey: Uint8Array.from(plain.rootKey),
    peerRatchetPub: plain.peerRatchetPub ? Uint8Array.from(plain.peerRatchetPub) : null,
    self: selfKeyPair,
    sendChainKey: plain.sendChainKey ? Uint8Array.from(plain.sendChainKey) : null,
    sendN: plain.sendN,
    recvChainKey: plain.recvChainKey ? Uint8Array.from(plain.recvChainKey) : null,
    recvN: plain.recvN,
    prevSendN: plain.prevSendN,
    sdev: Uint8Array.from(plain.sdev), rdev: Uint8Array.from(plain.rdev),
    skipped, keygen, aead,
  }
}
