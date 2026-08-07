/**
 * Spot Me — PUBLICATION of the device signing key. ADR-008 Phase 2B, client half.
 *
 * SWITCHED OFF. `SIGNING_PUBLICATION_ENABLED` is false, nothing under `src/`
 * calls this module, and `test/signing-not-shipped.test.js` fails the build if
 * either changes. The capability is real and fully tested — flipping it on is
 * a deliberate change whose subject is flipping it on, exactly the A5/A7
 * pattern: the day the flag turns is not the day anyone finds out whether the
 * path works.
 *
 * WHY THE GATE EXISTS, restated from ADR-008 §4: publishing turns a local key
 * into the anchor peers pin. A key whose write did not stick (`ephemeral`)
 * would hand peers a trust anchor that evaporates on the next launch —
 * strictly worse than the agreement-key version of that bug, which "only"
 * broke conversations rather than trust. And a store this build cannot read
 * (`unreadable`/`unavailable`) must never trigger generate-and-publish over a
 * record that might be fine. So the gate refuses everything except `ok`, and
 * the refusal names the state so the caller can say something true.
 *
 * TRANSPORT IS INJECTED, not imported. This module stays PURE like the rest
 * of the crypto layer — no network, no DOM — so the suite runs the shipped
 * code with no mocks. The activation PR wires `post` to the app's authed
 * fetch against `DEFAULT_ENDPOINT`; nothing in THIS change owns a URL scheme
 * or a token source, because those decisions are reviewable parts of
 * activation, not of the lifecycle.
 */
import { transcript, signBytes } from './signing-identity.js'
import { loadSigningIdentity, signingKeyStatus } from './signing-key-store.js'

/** OFF. Flipping this is the activation decision, owner-gated. */
export const SIGNING_PUBLICATION_ENABLED = false

/** Where the activation PR points its authed fetch. Kept here so the server
 *  route and the client constant cannot drift apart silently. */
export const DEFAULT_ENDPOINT = '/api/v2/auth/signing-key'

/** The supersession claim's domain — must match the server's
 *  `signing-transcript.ts` byte for byte (both suites pin the same vector). */
export const SUPERSEDE_DOMAIN = 'spotme-signing-supersede-v1'

/**
 * The supersession transcript: (domain, userId, oldPub, newPub, newAlgo).
 * The NEW key's algo is bound in because raw lengths collide across
 * protocols — Ed25519 and X25519 are both 32 bytes — the same two-defence
 * rule `signing-identity.js` applies to every transcript it signs.
 */
export function supersessionTranscript (userId, oldPublicKeyB64, newPublicKeyB64, newAlgo) {
  return transcript(SUPERSEDE_DOMAIN, [userId, oldPublicKeyB64, newPublicKeyB64, newAlgo])
}

/**
 * Sign the statement that authorises replacing `oldIdentity` with the new
 * key. Called by the future rotation flow AFTER `rotateSigningIdentity()`
 * hands back `previousPublicKeyB64` — but note the order of operations the
 * server enforces: the OLD key signs, so the signature must be produced
 * BEFORE the old private key is discarded. `rotate` keeps no history, so a
 * caller that rotates first and signs second has already lost the pen.
 */
export async function signSupersession (oldIdentity, { userId, newPublicKeyB64, newAlgo }) {
  const bytes = supersessionTranscript(
    userId,
    oldIdentity.publicKeyB64,
    newPublicKeyB64,
    newAlgo,
  )
  return signBytes(oldIdentity, bytes)
}

/**
 * Publish this device's signing key — gated, refusing loudly.
 *
 * Returns `{ ok: true, publicKeyB64, algo }` or
 * `{ ok: false, error: { code, message } }` with codes:
 *   DISABLED       the flag is off (the default, today)
 *   NO_TRANSPORT   enabled but no `post` wired — activation forgot its half
 *   EPHEMERAL      the key exists for this session only; publishing it would
 *                  hand peers an anchor that evaporates (ADR-008 §4)
 *   UNREADABLE     a record exists this build must not touch (ADR-008 §8)
 *   UNAVAILABLE    the store would not open or read
 *   PUBLISH_FAILED transport threw; the store is untouched either way
 */
export async function publishSigningIdentity ({ post, enabled = SIGNING_PUBLICATION_ENABLED } = {}) {
  if (!enabled) {
    return { ok: false, error: { code: 'DISABLED', message: 'signing-key publication is not enabled' } }
  }
  if (typeof post !== 'function') {
    return { ok: false, error: { code: 'NO_TRANSPORT', message: 'no transport wired for publication' } }
  }

  const identity = await loadSigningIdentity()
  const status = signingKeyStatus()
  if (status !== 'ok' || !identity) {
    const messages = {
      ephemeral: 'this device cannot persist its signing key — an ephemeral key must never be published (ADR-008 §4)',
      unreadable: 'a stored signing record exists that this build cannot read — refusing to publish over it (ADR-008 §8)',
      unavailable: 'the signing store is unavailable — nothing trustworthy to publish',
    }
    const code = (status in messages ? status : 'unavailable').toUpperCase()
    return { ok: false, error: { code, message: messages[status] || messages.unavailable } }
  }

  /* The payload is the PUBLIC half and the algorithm, nothing else. The
   * private key is a non-extractable handle and cannot be serialised even by
   * mistake — but the payload is still built field-by-field rather than
   * spreading the identity, so nothing new added to the record ever rides
   * along to the server unreviewed. */
  const payload = { publicKeyB64: identity.publicKeyB64, algo: identity.algo }
  try {
    await post(DEFAULT_ENDPOINT, payload)
  } catch (err) {
    return { ok: false, error: { code: 'PUBLISH_FAILED', message: String(err?.message || err) } }
  }
  return { ok: true, ...payload }
}
