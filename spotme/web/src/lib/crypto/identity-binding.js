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
  /* THE FRESHNESS CODES. A signature stays cryptographically valid forever;
   * none of these is about the maths. They are the difference between "this was
   * correctly signed" and "this device is trusted right now". */
  TRUST_UNKNOWN: 'TRUST_UNKNOWN',
  TRUST_BLOCKING: 'TRUST_BLOCKING',
  REVOKED: 'REVOKED',
})

const fail = (code, message) => ({ ok: false, error: { code, message } })

/** Trust states that stop a live authentication. Mirrors `identity-pin.isBlocking`
 *  by VALUE rather than by import: this module must stay usable by a verifier
 *  that has no pin store, and the two lists drifting is caught by a test. */
export const BLOCKING_TRUST = Object.freeze(['Changed', 'Revoked'])

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
export const CLAIM_FIELDS = Object.freeze([
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
 * The two kinds of answer this module gives, and they are NOT interchangeable.
 *
 * TYPES, NOT NAMES. An earlier version distinguished these only by function
 * name and by returning a bare boolean from the weaker one — and a bare boolean
 * fits anywhere a boolean is expected, so nothing structural stopped a
 * historical signature check being used where current authentication was
 * required. That is the failure this tagging exists to make impossible:
 * `requireLiveAuthentication` refuses anything that is not the stronger result.
 */
export const RESULT = Object.freeze({
  HISTORICAL: 'historical-signature-only',
  LIVE: 'live-authentication',
})

/**
 * Check the SIGNATURE only. Never throws.
 *
 * Answers exactly one question: **did this signing key sign this claim.** That
 * is a HISTORICAL fact and it stays true forever — which is precisely why it is
 * not authentication. A signature is replayable by anyone who has ever seen
 * one, and it says nothing about whether the agreement key it names is held by
 * whoever is presenting it, nor whether that identity is still trusted.
 *
 * Returns a TAGGED result. `.signed` is the boolean, and the tag is what stops
 * it being spent as authentication.
 */
export async function verifyBindingSignature (claim, sig) {
  const historical = (signed) => ({ kind: RESULT.HISTORICAL, signed, claim })
  if (claimProblem(claim)) return historical(false)
  let bytes
  try { bytes = bindingBytes(claim) } catch { return historical(false) }
  return historical(
    await verifyBytes({ publicKeyB64: claim.signingKeyB64, algo: claim.signingAlgo }, bytes, sig))
}

/**
 * The gate a caller must pass a result through before acting on it as identity.
 *
 * THROWS on anything that is not a successful live authentication — including a
 * perfectly valid historical signature check, `true`, or any other shape. A
 * caller that wants the weaker answer has to ask for it by name and cannot
 * arrive at it by accident.
 */
export function requireLiveAuthentication (result) {
  if (result?.kind !== RESULT.LIVE) {
    throw new Error(
      `this path requires live authentication; got ${result?.kind || typeof result}. ` +
      'A signature that was valid once is not proof that a device is trusted now.')
  }
  if (!result.ok) throw new Error(`live authentication failed: ${result.error?.code}`)
  return result
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
 * Everything, in the order a verifier should ask it. Returns a LIVE-tagged
 * result — never throws, never a bare boolean.
 *
 * FIVE INDEPENDENT QUESTIONS, and conflating any two of them is a real bug:
 *
 *   1. is the claim well-formed and about what I am asking about
 *   2. is the SIGNATURE valid                      — cryptographic, permanent
 *   3. was POSSESSION proved against my nonce      — cryptographic, momentary
 *   4. is this identity currently TRUSTED          — policy, changes over time
 *   5. has it been REVOKED or the device removed   — policy, changes over time
 *
 * 2 is true forever once true. 3 is true only for the challenge it was made
 * against. 4 and 5 are not cryptographic facts at all and cannot be derived
 * from the bytes — the caller must supply them, and a caller that cannot is
 * told so rather than having its silence read as consent.
 *
 * THIS FAILS CLOSED ON UNKNOWN TRUST, and that is deliberately the OPPOSITE of
 * what `identity-enforcement.js` does when the pin store is unreadable. They
 * are different questions. A5 asks "may I send to a peer I already trust", and
 * the answer without the store is yes, because the message still goes to the
 * pinned key. This asks "should I START trusting this claim", and the honest
 * answer without trust state is no. Read them together before changing either.
 *
 * `expect.signingKeyB64` is optional and is the difference between "is this a
 * coherent live binding" — true of a stranger's — and "is this the identity I
 * already pinned", which is the one that lets a rotation be accepted.
 */
export async function verifyLiveBinding ({ claim, sig, challenge, challengePrivateKey, mac, expect = {} }) {
  const evidence = {
    signatureValid: false,
    possessionProved: false,
    challengeNonceB64: challenge?.nonceB64 || null,
    checkedAt: typeof expect.at === 'number' ? expect.at : null,
    trustState: expect.trust?.state ?? null,
    revoked: expect.trust?.revoked ?? null,
    trustChecked: Boolean(expect.trust),
  }
  const no = (code, message) => ({ kind: RESULT.LIVE, ok: false, error: { code, message }, evidence, claim })

  const problem = claimProblem(claim)
  if (problem) return no(BIND_ERR.MALFORMED, problem)

  if (typeof expect.at !== 'number') return no(BIND_ERR.MALFORMED, 'a verifier must supply its clock')
  if (claim.issuedAt - expect.at > MAX_CLOCK_SKEW_MS) {
    return no(BIND_ERR.FUTURE_DATED, 'this binding claims to have been issued in the future')
  }
  if (expect.accountId && claim.accountId !== expect.accountId) {
    return no(BIND_ERR.WRONG_ACCOUNT, 'this binding is for a different account')
  }
  if (expect.agreementKeyB64 && claim.agreementKeyB64 !== expect.agreementKeyB64) {
    return no(BIND_ERR.WRONG_AGREEMENT_KEY, 'this binding is for a different agreement key')
  }
  if (expect.signingKeyB64 && claim.signingKeyB64 !== expect.signingKeyB64) {
    return no(BIND_ERR.WRONG_SIGNING_KEY, 'this binding is signed by a different identity')
  }

  const signed = await verifyBindingSignature(claim, sig)
  if (!signed.signed) return no(BIND_ERR.BAD_SIGNATURE, 'the signature does not check out')
  evidence.signatureValid = true

  if (!(await verifyPopAnswer({ claim, challenge, challengePrivateKey, mac }))) {
    return no(BIND_ERR.BAD_POP, 'the claimant did not prove it holds the agreement key')
  }
  evidence.possessionProved = true

  /* CRYPTOGRAPHY IS DONE. Everything above could be true of a device that was
   * revoked an hour ago, because none of it can know that. */
  if (!expect.trust) {
    return no(BIND_ERR.TRUST_UNKNOWN,
      'the signature and the proof are good, but current trust state was not supplied — ' +
      'a binding that was valid once is not evidence that this device is trusted now')
  }
  if (expect.trust.revoked) {
    return no(BIND_ERR.REVOKED, 'this identity has been revoked')
  }
  if (expect.trust.state && BLOCKING_TRUST.includes(expect.trust.state)) {
    return no(BIND_ERR.TRUST_BLOCKING, `this identity is in a blocking trust state: ${expect.trust.state}`)
  }

  return { kind: RESULT.LIVE, ok: true, claim, evidence }
}
