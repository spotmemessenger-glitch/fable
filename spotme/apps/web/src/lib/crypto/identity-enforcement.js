/**
 * Spot Me — whether this device will SEND. A5. PURE, plus a synchronous cache.
 *
 * A1–A4 built a trust record and A6a added a second axis for what the server
 * says. Nothing has ever *stopped* anything. `rooms.js` still carries the note
 * "Advisory in this step — A5 turns this into a block". This is that.
 *
 * THE VERDICT IS ALWAYS COMPUTED. THE FLAG ONLY DECIDES WHETHER IT BITES.
 *
 * That distinction is the whole shape of this module. `ENFORCING` defaults to
 * FALSE, and a false flag does NOT short-circuit the decision — every send
 * still runs the full verdict, and a blocking one is reported as `advisory`
 * instead of refusing. So the enforcement path is exercised on every message
 * long before it is ever switched on, and the day it is switched on is not the
 * day anybody finds out whether it works. A flag that skips the code it gates
 * buys nothing but the illusion of caution.
 *
 * WHY AN UNAVAILABLE PIN STORE IS **NOT** A BLOCK, which is a change from what
 * ADR-005 §7 anticipated. That ADR said A5 is where an unreachable store
 * becomes fail-closed. The A5 matrix showed the premise was wrong: with the pin
 * store down, `roomKeyForConvo` still derives against the LOCAL `convo.peerKey`
 * and still merely PROPOSES a differing key, so messages remain encrypted to
 * the pinned key and the substitution is still refused. An unavailable store
 * hides the WARNING; it does not enable the attack. Blocking there would take
 * every private-browsing user offline in exchange for nothing.
 *
 * The one case it does not cover is a conversation whose FIRST pin was taken
 * during an outage — at this layer that is indistinguishable from any other
 * first pin, and it is the precondition A7's out-of-band anchor exists to
 * close. Recorded rather than papered over.
 *
 * TRUST IS READ BEFORE AVAILABILITY, deliberately. A peer who is both revoked
 * and unreachable must be told the revocation: it is the cryptographic fact,
 * it is the one the user acted on, and "can't reach the server" would send them
 * to fix a network that is not the problem.
 */
import { isBlocking, CHANGED, REVOKED } from './identity-pin.js'
import {
  availabilityOf, AVAILABLE, SERVER_DISABLED, UNREACHABLE,
} from './identity-availability.js'

export const SEND = Object.freeze({
  ALLOWED: 'Allowed',
  BLOCKED_CHANGED: 'BlockedChanged',
  BLOCKED_REVOKED: 'BlockedRevoked',
  BLOCKED_UNREACHABLE: 'BlockedUnreachable',
  BLOCKED_SERVER_DISABLED: 'BlockedServerDisabled',
})

/**
 * What the user must DO. Every blocking verdict names one.
 *
 * A block with no next step is an outage with extra words. This is the field
 * the UI branches on, so a new blocking verdict cannot be added without
 * someone deciding what it asks of the person holding the phone.
 */
export const NEEDS = Object.freeze({
  NOTHING: 'nothing',
  REVIEW_KEY_CHANGE: 'review-key-change',
  RESTORE_TRUST: 'restore-trust',
  WAIT: 'wait',
  CONTACT_ELSEWHERE: 'contact-elsewhere',
})

/* ------------------------------------------------------------ the flag --- */

/**
 * OFF. Turning this on is a product decision, not a refactor.
 *
 * With it off, a `Changed` peer is reported and still messageable — today's
 * behaviour. With it on, sending refuses until the user accepts, verifies or
 * rejects the new key. The cost of ON is that every LEGITIMATE key rotation —
 * new phone, reinstall, storage cleared — stops a conversation until two people
 * do something about it. A7 is what makes that rare enough to be reasonable;
 * until then this stays false and the verdicts are advisory.
 */
let enforcing = false

export const isEnforcing = () => enforcing

/** Deliberately not persisted and not reachable from a setting. It is flipped
 *  in code, in a change whose subject is flipping it. */
export function setEnforcement (on) { enforcing = on === true }

/* --------------------------------------------------------- the decision --- */

/**
 * May this device send to this peer? PURE — no storage, no DOM, never throws.
 *
 * `record` may be null, which means "nothing known" and is NOT a fault: a v1
 * conversation has no pin at all, and a peer nobody has ever observed is not
 * presumed hostile.
 *
 * Returns `{ verdict, allowed, advisory, needs, message }`:
 *   verdict   the true answer, always computed
 *   allowed   what the caller must actually do — false only when ENFORCING
 *   advisory  a blocking verdict that is NOT being enforced, so the UI can warn
 *   needs     what would clear it
 *   message   what to tell the user, already phrased for them
 */
export function sendDecision (record, opts = {}) {
  const enforced = opts.enforcing === undefined ? enforcing : opts.enforcing === true
  const settle = (verdict, needs, message) => ({
    verdict,
    allowed: verdict === SEND.ALLOWED || !enforced,
    advisory: verdict !== SEND.ALLOWED && !enforced,
    needs,
    message,
  })

  // TRUST FIRST. See the header — a revoked peer is told about the revocation
  // even when the server is also unreachable.
  if (record && isBlocking(record)) {
    if (record.state === REVOKED) {
      return settle(SEND.BLOCKED_REVOKED, NEEDS.RESTORE_TRUST,
        'You marked this contact’s key as no longer trusted. Messages are not being sent.')
    }
    if (record.state === CHANGED) {
      return settle(SEND.BLOCKED_CHANGED, NEEDS.REVIEW_KEY_CHANGE,
        'This contact is using a different key than the one you trust. ' +
        'Verify with them in person, or accept the change, before sending.')
    }
  }

  switch (availabilityOf(record)) {
    case SERVER_DISABLED:
      return settle(SEND.BLOCKED_SERVER_DISABLED, NEEDS.CONTACT_ELSEWHERE,
        'This account has been disabled. Messages will not be delivered.')
    case UNREACHABLE:
      return settle(SEND.BLOCKED_UNREACHABLE, NEEDS.WAIT,
        'Can’t reach the server right now — still trying.')
    case AVAILABLE:
    default:
      return settle(SEND.ALLOWED, NEEDS.NOTHING, null)
  }
}

/* ------------------------------------------------- the synchronous cache --- */

/**
 * WHY A CACHE AT ALL. `rooms.sendMessage` is synchronous and reading a trust
 * record is not. Making the send path async would ripple through every caller
 * in `views/chat.js` and put IndexedDB between a keypress and a bubble —
 * the same objection that made `identityStatus()` synchronous in
 * `identity-store.js`, for the same reason.
 *
 * KEYED BY ROOM, NOT BY PEER, because the room id is what the send path holds.
 * The mapping is fixed for a DM and the verdict is refreshed wherever trust is
 * already being consulted, so nothing has to look a peer up at send time.
 *
 * A ROOM WITH NO ENTRY IS ALLOWED. That is not a gap: a v1 room has no pinning
 * to enforce, and a room whose key has not been derived yet cannot have sent
 * anything either.
 */
const verdicts = new Map()

/** Record the decision for a room. Pass the trust record; the verdict is
 *  derived here so callers cannot disagree about how. */
export function setRoomTrust (roomId, record) {
  if (!roomId) return null
  const decision = sendDecision(record)
  verdicts.set(roomId, decision)
  return decision
}

/**
 * Mark a room blocked because a differing key was just proposed.
 *
 * Separate from `setRoomTrust` because it is reached from `onPeerKeyProposed`,
 * which knows the answer SYNCHRONOUSLY and before any store read could return.
 * Waiting for the record would leave a window in which the substituted key is
 * known and sending is still allowed, and that window is exactly the one an
 * attacker provoking a decrypt failure would be operating in.
 */
export function markKeyProposed (roomId) {
  if (!roomId) return null
  return setRoomTrust(roomId, { state: CHANGED })
}

/** The current decision for a room. SYNCHRONOUS, for the send path. */
export function roomDecision (roomId) {
  return verdicts.get(roomId) || sendDecision(null)
}

/** May this room send right now? The one-liner the send path calls. */
export const maySend = (roomId) => roomDecision(roomId).allowed

export function clearRoomTrust (roomId) { verdicts.delete(roomId) }

/** Cleared on wipe and on sign-out — a verdict outliving the account it was
 *  about would apply somebody else's trust to a new user's rooms. */
export function forgetAllTrust () { verdicts.clear() }

/* ------------------------------------------------------ telling the user --- */

let onBlocked = null

/**
 * Registered by the UI, called when a send is refused.
 *
 * A handler rather than a direct import, matching `setTerminalAuthHandler`:
 * this module must not reach into a view, and a refusal the user is never told
 * about is indistinguishable from a message that quietly went nowhere — which
 * is the exact ambiguity the rest of this codebase keeps being bitten by.
 */
export function setBlockedSendHandler (fn) { onBlocked = typeof fn === 'function' ? fn : null }

export function reportBlocked (roomId) {
  const decision = roomDecision(roomId)
  try { onBlocked?.({ roomId, ...decision }) } catch { /* a broken UI must not break sending */ }
  return decision
}
