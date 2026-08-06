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

/** Read a flag without letting a hostile localStorage break a call. */
function flag (key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    // Private-mode Safari throws on localStorage access. Off is the safe
    // answer for every flag here.
    return null
  }
}

/** True when this device may place 1:1 calls. */
export function livekitCalls () {
  return flag('spotme.calls') === 'livekit'
}

/**
 * True when this device may place GROUP calls.
 *
 * A SECOND, INDEPENDENT SWITCH. Turning 1:1 on must not turn group on: they
 * have different blast radii. A 1:1 call is two people; a group call is up to
 * six, costs participant-minutes per person, and carries ring semantics that
 * only exist with three or more — late joiners, and one person leaving while
 * the others carry on. Shipping the second by flipping the first would mean
 * discovering that difference in production.
 *
 * Group REQUIRES calls as well as its own flag. It is an extension of the call
 * path, not a parallel one, and `spotme.calls.group` alone would be asking for
 * group calls on a device where no call may be placed at all.
 *
 *   localStorage['spotme.calls'] = 'livekit'   1:1 calls
 *   localStorage['spotme.calls.group'] = 'on'  …and group calls, with the above
 */
export function groupCalls () {
  return livekitCalls() && flag('spotme.calls.group') === 'on'
}
