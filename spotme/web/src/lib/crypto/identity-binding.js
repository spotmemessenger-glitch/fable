/**
 * Spot Me — binding an AGREEMENT key to a SIGNING identity. A7. PURE.
 *
 * THE CLAIM THIS FILE MAKES CHECKABLE:
 *
 *     "account <id>, on device <d>, asserts that agreement key <A> is mine,
 *      as of <t> — signed by signing key <S>."
 *
 * Two independent proofs, and each covers a hole the other leaves.
 *
 * 1. THE SIGNATURE, by S, over a canonical transcript of the whole claim. This
 *    is what makes the claim transferable: anyone holding S can check it later,
 *    offline, with nothing but the bytes. It is what will eventually let a peer
 *    verified ONCE vouch for its own next agreement key instead of sending two
 *    people back to reading sixty digits at each other.
 *
 * 2. THE PROOF OF POSSESSION, by A, over the SAME transcript. A signature alone
 *    says nothing about who holds A — S can sign a claim naming ANY public key,
 *    including one lifted from somebody else's account. Nothing in the signature
 *    contradicts it, because the signature is over a statement, not over
 *    evidence. So the verifier makes the claimant demonstrate A is live.
 *
 * WHY THE POP IS A DH ROUND TRIP AND NOT A SECOND SIGNATURE. X25519 cannot sign
 * — it is a key-agreement key and that is the only thing it does. The standard
 * way to prove possession of an agreement key is therefore to agree with it: the
 * verifier generates an ephemeral pair on the same curve, the claimant does ECDH
 * against it and MACs the transcript with the derived secret, and the verifier
 * recomputes both sides. Only the holder of A's private half can produce that
 * MAC, and it is bound to a nonce the VERIFIER chose, so a captured one cannot
 * be replayed.
 *
 * RELAY IS BLOCKED ON THE ANSWERING SIDE, NOT THE ASKING SIDE. A challenge is
 * just bytes; anyone can forward one. If a device would answer any challenge put
 * to it, an attacker could relay a challenge for a claim naming HER signing key
 * and the VICTIM'S agreement key, and the victim would obligingly prove it.
 * `answerPopChallenge` therefore refuses any claim that does not name both of
 * this device's own keys — see the guard there. It is the one place in the
 * protocol where being unhelpful is the security property.
 *
 * PURE — no storage, no DOM, no network. Every primitive is WebCrypto's.
 */
import {
  signBytes, verifyBytes, transcript, toB64, fromB64,
  ED25519, ECDSA_P256,
} from './signing-identity.js'
import { generateIdentity, exportPublicKeyB64, importPeerPublicKey } from './e2e-v2.js'

/** Bumping either domain invalidates every existing proof, deliberately: they
 *  are the outermost domain separation, so a transcript from one protocol
 *  version can never be checked as if it belonged to another. */
export const BINDING_DOMAIN = 'spotme-identity-binding-v1'
export const POP_DOMAIN = 'spotme-identity-pop-v1'

/** HKDF salt for the PoP MAC key. Fixed and public — a salt is not a secret,
 *  and a per-run one would have to be transported. */
const POP_SALT = new TextEncoder().encode('spotme-identity-pop-v1-salt')

export const NONCE_BYTES = 32

/**
 * How far into the future a binding may claim to have been issued.
 *
 * A binding has no expiry — its freshness comes from the PoP nonce, not from its
 * timestamp, and a long-lived assertion is the whole point. But a FUTURE-dated
 * one is a different matter: it would still look current after a revocation, so
 * ordinary clock skew is tolerated and anything beyond it is refused.
 */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000

export const BIND_ERR = Object.freeze({
  MALFORMED: 'MALFORMED',
  BAD_SIGNATURE: 'BAD_SIGNATURE',
  BAD_POP: 'BAD_POP',
  WRONG_ACCOUNT: 'WRONG_ACCOUNT',
  WRONG_AGREEMENT_KEY: 'WRONG_AGREEMENT_KEY',
  WRONG_SIGNING_KEY: 'WRONG_SIGNING_KEY',
  FUTURE_DATED: 'FUTURE_DATED',
  ALGO_MISMATCH: 'ALGO_MISMATCH',
  NOT_MY_CLAIM: 'NOT_MY_CLAIM',
})

const fail = (code, message) => ({ ok: false, error: { code, message } })

const SIGNING_ALGO_OK = (a) => a === ED25519 || a === ECDSA_P256
const AGREEMENT_ALGO_OK = (a) => a === 'X25519' || a === 'P-256'

/* ------------------------------------------------------------ the claim --- */

/**
 * The seven fields, in a fixed order that both sides encode identically.
 *
 * Order is part of the format. `transcript` length-prefixes each field so the
 * boundaries cannot be shifted, but it does not sort — two peers that disagreed
 * about the order would produce different bytes and every signature would fail
 * closed. Which is the right failure, but only if the order lives in exactly one
 * place. This is that place.
 */
const CLAIM_FIELDS = Object.freeze([
  'signingAlgo', 'signingKeyB64', 'agreementAlgo', 'agreementKeyB64',
  'accountId', 'deviceId', 'issuedAt',
])

/** Every field present, well-typed, and both algorithms known. Returns null when
 *  the claim is sound, or a reason when it is not. */
export function claimProblem (claim) {
  if (!claim || typeof claim !== 'object') return 'no claim'
  for (const f of CLAIM_FIELDS) {
    const v = claim[f]
    if (f === 'issuedAt') {
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'issuedAt must be a finite number'
    } else if (typeof v !== 'string' || !v) {
      return `${f} is required`
    }
  }
  if (!SIGNING_ALGO_OK(claim.signingAlgo)) return `unknown signing algo: ${claim.signingAlgo}`
  if (!AGREEMENT_ALGO_OK(claim.agreementAlgo)) return `unknown agreement algo: ${claim.agreementAlgo}`
  return null
}

/** The exact bytes that get signed. Canonical by construction — see
 *  `transcript` in signing-identity.js for why length-prefixing is not optional. */
export function bindingBytes (claim) {
  const problem = claimProblem(claim)
  if (problem) throw new Error(`cannot encode binding: ${problem}`)
  return transcript(BINDING_DOMAIN, CLAIM_FIELDS.map((f) => claim[f]))
}

/**
 * Sign a binding.
 *
 * The signing algorithm and public key are taken FROM THE IDENTITY, never from
 * the caller's claim, so the two cannot disagree — a claim that named a signing
 * key other than the one signing it would produce a signature that verifies
 * against nothing, which is a confusing failure a long way from its cause.
 */
export async function signBinding (signingIdentity, signingKeyB64, rest) {
  if (!signingIdentity?.privateKey) throw new Error('a private signing key is required')
  if (typeof signingKeyB64 !== 'string' || !signingKeyB64) throw new Error('the signing public key is required')
  const claim = {
    ...rest,
    signingAlgo: signingIdentity.algo,
    signingKeyB64,
  }
  const sig = await signBytes(signingIdentity, bindingBytes(claim))
  return { claim, sig }
}

/**
 * Check the SIGNATURE only. Boolean, never throws.
 *
 * NAMED FOR WHAT IT IS NOT. This answers "did S sign this claim", which is a
 * HISTORICAL question — it is the right check for a binding already stored and
 * already verified. It is NOT sufficient for a claim arriving now: a signature
 * is replayable by anyone who has ever seen it, and says nothing about whether
 * the agreement key it names is held by the claimant. Use `verifyLiveBinding`
 * for that. The two names are deliberately not variants of one another.
 */
export async function verifyBindingSignature (claim, sig) {
  if (claimProblem(claim)) return false
  let bytes
  try { bytes = bindingBytes(claim) } catch { return false }
  return verifyBytes({ publicKeyB64: claim.signingKeyB64, algo: claim.signingAlgo }, bytes, sig)
}

/* --------------------------------------------------- proof of possession --- */

const ecdhParams = (algo, publicKey) =>
  (algo === 'X25519' ? { name: 'X25519', public: publicKey } : { name: 'ECDH', public: publicKey })

/**
 * A verifier's challenge: an ephemeral pair on the claimed curve, plus a nonce.
 *
 * EPHEMERAL AND VERIFIER-CHOSEN, both loadbearing. Ephemeral so the challenge
 * private key never becomes something worth stealing; verifier-chosen so the
 * claimant cannot have prepared the answer in advance, which is what makes a
 * captured MAC useless anywhere else.
 *
 * `nonce` is injectable for tests only. Production passes nothing and gets
 * `crypto.getRandomValues`.
 */
export async function makePopChallenge ({ agreementAlgo, nonce } = {}) {
  if (!AGREEMENT_ALGO_OK(agreementAlgo)) throw new Error(`unknown agreement algo: ${agreementAlgo}`)
  const pair = await generateIdentity({ algo: agreementAlgo })
  const bytes = nonce instanceof Uint8Array ? nonce : crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  if (bytes.length !== NONCE_BYTES) throw new Error(`a nonce must be ${NONCE_BYTES} bytes`)
  return {
    challenge: { algo: agreementAlgo, publicKeyB64: await exportPublicKeyB64(pair), nonceB64: toB64(bytes) },
    privateKey: pair.privateKey,
  }
}

/**
 * The bytes both sides MAC. Binds the whole claim and the nonce, so a MAC proves
 * possession OF THIS KEY FOR THIS CLAIM and nothing more portable than that.
 *
 * The challenge public key is in here too, and it is the one field that is
 * already bound WITHOUT being listed: it determines the ECDH shared secret and
 * therefore the MAC key itself, so a MAC made against a different challenge key
 * cannot verify regardless of what the transcript says. Mutation testing
 * confirms removing it from this list breaks nothing. It is listed anyway as
 * transcript hygiene — MAC over everything you saw — but the implicit binding is
 * what is load-bearing, and a reader should not mistake the two.
 */
function popBytes (claim, challenge) {
  return transcript(POP_DOMAIN, [
    bindingBytes(claim),
    challenge.algo,
    fromB64(challenge.publicKeyB64),
    fromB64(challenge.nonceB64),
  ])
}

/** ECDH -> HKDF-SHA256 -> HMAC-SHA256 key. Both sides reach the same key from
 *  opposite halves of the same agreement. */
async function popMacKey (algo, privateKey, peerPublicKey) {
  const shared = await crypto.subtle.deriveBits(ecdhParams(algo, peerPublicKey), privateKey, 256)
  const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: POP_SALT, info: new TextEncoder().encode(POP_DOMAIN) },
    ikm,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

/**
 * Answer a challenge. Returns `{ ok, mac }` or `{ ok: false, error }`.
 *
 * THE GUARD BELOW IS THE ANTI-RELAY PROPERTY, and it is why this function needs
 * to know both of the device's own public keys rather than just its agreement
 * private key.
 *
 * Without it: an attacker builds a claim naming HER signing key and the
 * VICTIM'S agreement key, and relays a verifier's challenge to the victim. The
 * victim holds that agreement key, so it can produce the MAC — and would, and
 * the attacker's forged binding would then carry a perfectly valid proof of
 * possession for a key she does not hold.
 *
 * Answering a challenge is asserting "this entire claim is mine". A device that
 * will assert that about a claim it did not make has given away the only thing
 * the PoP was protecting.
 */
export async function answerPopChallenge ({ agreement, agreementKeyB64, signingKeyB64, claim, challenge }) {
  if (claimProblem(claim)) return fail(BIND_ERR.MALFORMED, 'not a well-formed claim')
  if (!agreement?.privateKey) return fail(BIND_ERR.MALFORMED, 'a private agreement key is required')
  if (claim.signingKeyB64 !== signingKeyB64) {
    return fail(BIND_ERR.NOT_MY_CLAIM, 'this claim names another signing key — refusing to prove it')
  }
  if (claim.agreementKeyB64 !== agreementKeyB64) {
    return fail(BIND_ERR.NOT_MY_CLAIM, 'this claim names another agreement key — refusing to prove it')
  }
  if (challenge?.algo !== claim.agreementAlgo) {
    return fail(BIND_ERR.ALGO_MISMATCH, 'the challenge is on a different curve')
  }
  try {
    const peer = await importPeerPublicKey(challenge.publicKeyB64, challenge.algo)
    const key = await popMacKey(claim.agreementAlgo, agreement.privateKey, peer)
    return { ok: true, mac: toB64(await crypto.subtle.sign('HMAC', key, popBytes(claim, challenge))) }
  } catch (err) {
    return fail(BIND_ERR.BAD_POP, `could not answer the challenge: ${err.message}`)
  }
}

/**
 * Check an answer. Boolean, never throws — same reasoning as `verifyBytes`.
 *
 * Uses WebCrypto's HMAC verify rather than comparing strings: a byte-by-byte
 * comparison that returns early leaks, through timing, how much of a forged MAC
 * was right, and that is enough to construct the rest.
 */
export async function verifyPopAnswer ({ claim, challenge, challengePrivateKey, mac }) {
  try {
    if (claimProblem(claim)) return false
    if (typeof mac !== 'string' || !mac) return false
    if (challenge?.algo !== claim.agreementAlgo) return false
    const claimed = await importPeerPublicKey(claim.agreementKeyB64, claim.agreementAlgo)
    const key = await popMacKey(claim.agreementAlgo, challengePrivateKey, claimed)
    return await crypto.subtle.verify('HMAC', key, fromB64(mac), popBytes(claim, challenge))
  } catch {
    return false
  }
}

/* ------------------------------------------------------- the whole check --- */

/**
 * Everything, in the order a verifier should ask it. Returns `{ ok }` or
 * `{ ok: false, error: { code } }` — never throws, never a bare boolean.
 *
 * THE ORDER IS THE POINT, exactly as in `verifyScannedPayload`. A valid
 * signature over a well-formed claim is easy to obtain and proves only that
 * SOMEBODY signed SOMETHING; it becomes meaningful only once the claim is known
 * to be about the account, the key and the identity this verifier is actually
 * asking about. So every binding is checked before either proof, and the
 * expensive proof-of-possession runs last.
 *
 * `expect.signingKeyB64` is optional and is the difference between two very
 * different questions. Omitted, this asks "is this a coherent, live binding" —
 * true of a stranger's. Supplied, it asks "is this the identity I already
 * pinned", which is the one that lets a rotation be accepted.
 */
export async function verifyLiveBinding ({ claim, sig, challenge, challengePrivateKey, mac, expect = {} }) {
  const problem = claimProblem(claim)
  if (problem) return fail(BIND_ERR.MALFORMED, problem)

  if (typeof expect.at !== 'number') return fail(BIND_ERR.MALFORMED, 'a verifier must supply its clock')
  if (claim.issuedAt - expect.at > MAX_CLOCK_SKEW_MS) {
    return fail(BIND_ERR.FUTURE_DATED, 'this binding claims to have been issued in the future')
  }
  if (expect.accountId && claim.accountId !== expect.accountId) {
    return fail(BIND_ERR.WRONG_ACCOUNT, 'this binding is for a different account')
  }
  if (expect.agreementKeyB64 && claim.agreementKeyB64 !== expect.agreementKeyB64) {
    return fail(BIND_ERR.WRONG_AGREEMENT_KEY, 'this binding is for a different agreement key')
  }
  if (expect.signingKeyB64 && claim.signingKeyB64 !== expect.signingKeyB64) {
    return fail(BIND_ERR.WRONG_SIGNING_KEY, 'this binding is signed by a different identity')
  }

  if (!(await verifyBindingSignature(claim, sig))) {
    return fail(BIND_ERR.BAD_SIGNATURE, 'the signature does not check out')
  }
  if (!(await verifyPopAnswer({ claim, challenge, challengePrivateKey, mac }))) {
    return fail(BIND_ERR.BAD_POP, 'the claimant did not prove it holds the agreement key')
  }
  return { ok: true, claim }
}
