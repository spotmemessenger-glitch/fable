/**
 * Spot Me — which media path a call uses. ADR-003.
 *
 * DEFAULT OFF. With no flag set, `livekitCalls()` is false, nothing else in
 * this folder is ever imported, and calls run exactly the WebRTC path they ran
 * before: peer connections built in socket-transport.js (or Trystero when
 * `spotme.transport` says p2p). That is the rollback — clear the key.
 *
 * A SEPARATE FLAG FROM `spotme.transport` ON PURPOSE. That one chooses who
 * carries MESSAGES; this one chooses who carries CALL MEDIA. They are different
 * subsystems with different failure modes, and a single switch would mean
 * testing LiveKit calls forced a messaging transport change at the same time —
 * two variables, one knob, no way to attribute a regression.
 *
 *   localStorage['spotme.calls'] = 'livekit'   media via the LiveKit SFU
 *   localStorage.removeItem('spotme.calls')    back to peer-to-peer WebRTC
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

/**
 * Which media path two devices can BOTH use.
 *
 * Pure, and exported, because this is the decision that fails silently. Media
 * only flows if the two ends meet in the same place: if one publishes to the
 * SFU while the other adds tracks to a peer connection, both sit in a
 * connected-looking call hearing nothing. Every indicator says the call is up.
 *
 * So the answer is livekit ONLY when both sides say so. `theirs` comes off the
 * wire, which means it can be undefined (a client built before this existed),
 * a stale value, or anything at all — and every one of those must resolve to
 * the path that works everywhere.
 *
 * @param {boolean} mineIsLivekit  this device's flag
 * @param {*}       theirs         whatever the peer put in the call payload
 */
export function agreeCallMedia (mineIsLivekit, theirs) {
  return mineIsLivekit && theirs === 'livekit' ? 'livekit' : 'p2p'
}

/** What the last call actually used, and why it may differ from the flag. */
let report = { requested: null, actual: null, reason: null }

/** Record the resolved path. A non-null `reason` means it was a fallback. */
export function noteCallPath (requested, actual, reason = null) {
  report = { requested, actual, reason }
  if (reason) console.warn(`spotme calls: ${reason}`)
}

export function activeCallPath () {
  return { ...report }
}
