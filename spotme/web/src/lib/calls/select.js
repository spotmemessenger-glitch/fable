/**
 * Spot Me — is this device allowed to place calls at all? ADR-004.
 *
 * DEFAULT OFF, and off now means CALLS ARE UNAVAILABLE, not "calls fall back to
 * something older". The peer-to-peer path was deleted; there is nothing behind
 * this switch but the SFU. `rooms.js` refuses a call with a readable message
 * rather than starting one that cannot connect.
 *
 * A SEPARATE FLAG FROM `spotme.transport` ON PURPOSE. That one chooses who
 * carries MESSAGES; this one chooses who carries CALL MEDIA. They are different
 * subsystems with different failure modes, and a single switch would mean
 * testing LiveKit calls forced a messaging transport change at the same time —
 * two variables, one knob, no way to attribute a regression.
 *
 *   localStorage['spotme.calls'] = 'livekit'   calls enabled, via the SFU
 *   localStorage.removeItem('spotme.calls')    calls unavailable on this device
 *
 * Read through a function rather than captured at module load: the flag is
 * flipped from devtools during testing, and a cached value would mean a reload
 * is needed to see the change — which is how you end up believing you tested
 * the other path.
 */

/** True when this device should place calls through LiveKit. */
export function livekitCalls () {
  try {
    return globalThis.localStorage?.getItem('spotme.calls') === 'livekit'
  } catch {
    // Private-mode Safari throws on localStorage access. Off is the safe
    // answer: the legacy path works everywhere this one might not.
    return false
  }
}
