/**
 * Spot Me — whether the SERVER will carry traffic for a peer. PURE.
 *
 * A SEPARATE AXIS FROM TRUST, AND A SEPARATE MODULE SO IT STAYS THAT WAY.
 *
 * `identity-pin.js` answers "which key is theirs, and how sure are we". This
 * answers "will the server serve them". Both can stop a conversation, and that
 * shared symptom is exactly why they get conflated — but only one of them is a
 * cryptographic fact, and the other is an assertion by the party the whole
 * design distrusts.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE. A server may say "this account is
 * disabled". It may not thereby retire a peer's identity. If it could, then
 * `Revoked -> clearRevocation -> Unverified -> observe -> Pinned` would be a
 * SERVER-TRIGGERED RE-PIN: one API response and the trust anchor for a
 * conversation is replaced, which is the substitution attack the whole identity
 * sequence exists to stop, reached through a different door.
 *
 * So availability lives in its own field, written by its own function, which
 * structurally cannot reach identity state — `applyAvailability` returns
 * `{ ...rec, availability }` and touches nothing else. The module boundary is
 * the enforcement; the tests assert every identity field survives byte-identical.
 *
 * WHY UNREACHABLE AND SERVER_DISABLED ARE NOT ONE STATE. They call for opposite
 * behaviour. A transient network or server fault should be retried, behind
 * "connection lost, trying again". A deliberate deactivation is terminal
 * policy: retrying hammers an endpoint that will keep saying no, and telling
 * the user to wait for a connection that is not the problem sends them after
 * the wrong fault. Mixing them conflates infrastructure health with access
 * control.
 *
 * The clock is an argument here too, for the same reason as identity-pin.js.
 */

export const AVAILABLE = 'Available'
export const SERVER_DISABLED = 'ServerDisabled'
export const UNREACHABLE = 'Unreachable'

export const AVAILABILITY = Object.freeze([AVAILABLE, SERVER_DISABLED, UNREACHABLE])

/** The only source there is. Named anyway, so a record says where its status
 *  came from and nothing can later claim a stronger provenance than it has. */
export const AVAILABILITY_SOURCE = 'server-assertion'

export const AVAIL_ERR = Object.freeze({
  UNKNOWN_STATUS: 'UNKNOWN_STATUS',
  BAD_EVENT: 'BAD_EVENT',
})

const fail = (code, message) => ({ ok: false, error: { code, message } })

/**
 * Record what the server says about reaching this peer.
 *
 * Returns `{ ok, next, changed }` or `{ ok: false, error }`. Never throws.
 *
 * `next` differs from `rec` in EXACTLY ONE FIELD. That is the security
 * property, not an implementation detail: no status the server can assert may
 * move an identity state, drop a pin, clear a proposal, or discard a
 * verification.
 *
 * `reason` is server-supplied text. It is stored for display and is UNTRUSTED —
 * render it escaped, never interpret it, and never branch on it.
 */
export function applyAvailability (rec, ev) {
  if (!rec || typeof rec !== 'object') return fail(AVAIL_ERR.BAD_EVENT, 'no record')
  if (!ev || typeof ev.at !== 'number') {
    return fail(AVAIL_ERR.BAD_EVENT, 'an availability event needs a numeric `at`')
  }
  if (!AVAILABILITY.includes(ev.status)) {
    return fail(AVAIL_ERR.UNKNOWN_STATUS, `not an availability status: ${ev.status}`)
  }

  const availability = {
    status: ev.status,
    source: AVAILABILITY_SOURCE,
    reason: typeof ev.reason === 'string' ? ev.reason : null,
    at: ev.at,
  }
  const changed = JSON.stringify(rec.availability || null) !== JSON.stringify(availability)
  // Spread-then-override, so adding a field to the identity record can never
  // accidentally drop out of an availability write.
  return { ok: true, next: { ...rec, availability }, changed }
}

/** The status, defaulting to Available — a peer nobody has reported on is not
 *  presumed broken. */
export const availabilityOf = (rec) => rec?.availability?.status || AVAILABLE

/**
 * Should the caller keep trying?
 *
 * TRUE for a transient fault, FALSE for a deliberate deactivation. Retrying a
 * terminal policy state is how a client ends up hammering an endpoint that will
 * keep refusing it, while showing the user a "reconnecting" spinner for a
 * condition no amount of connectivity will fix.
 */
export const shouldRetry = (rec) => availabilityOf(rec) === UNREACHABLE

/**
 * Should the UI stop offering to send?
 *
 * Both non-Available statuses block, and that is the one thing they share. What
 * differs is what the user is told and whether anything retries — see
 * `shouldRetry` and `availabilityMessage`.
 *
 * NOTE this is availability only. `identity-pin.isBlocking` answers the
 * trust question separately, and A5 will need BOTH: a peer can be perfectly
 * reachable with a key you should not be using, or unreachable with a key you
 * verified last week.
 */
export const blocksSending = (rec) => availabilityOf(rec) !== AVAILABLE

/** What to tell the user. Deliberately does NOT interpolate the server's
 *  `reason`: it is untrusted text, and a caller that wants to show it must do
 *  so knowingly and escaped. */
export function availabilityMessage (rec) {
  switch (availabilityOf(rec)) {
    case SERVER_DISABLED:
      return 'This account has been disabled. Messages will not be delivered.'
    case UNREACHABLE:
      return 'Can’t reach the server right now — still trying.'
    default:
      return null
  }
}
