/**
 * Spot Me — the 3-tier OrderingToken and pure ordering logic. ADR-012.
 * SCAFFOLDING ONLY (flag off, not wired). Pure logic.
 *
 * When one conversation can arrive over several paths, "what order did these
 * messages go in?" stops being "the order they arrived". The OrderingToken
 * carries three tiers, most authoritative first:
 *
 *   1. serverSeq     — a monotonic sequence the server stamps. Global, total,
 *                      and the truth WHEN it exists (online transports).
 *   2. ratchetPos    — the Double Ratchet message number. Per-conversation, and
 *                      the truth once P1 crypto is active, even offline. (The
 *                      ratchet itself is DEFERRED to P1; the token only reserves
 *                      the slot — this layer never computes a ratchet position.)
 *   3. senderClock   — a per-sender monotonic counter (Lamport-style). Always
 *                      present, so there is always *some* order, even mesh-only.
 *
 * compareTokens uses the HIGHEST tier BOTH tokens carry — so two server-ordered
 * messages compare by serverSeq, a server-ordered and a mesh-only message fall
 * back to senderClock, and mesh-only peers compare by senderClock throughout.
 */

/** Build a token. senderClock is mandatory; the higher tiers are optional. */
export function makeOrderingToken ({ serverSeq = null, ratchetPos = null, senderClock, origin = null }) {
  if (typeof senderClock !== 'number' || senderClock < 0) {
    throw new Error('ordering: senderClock is mandatory and must be a non-negative number')
  }
  for (const [k, v] of [['serverSeq', serverSeq], ['ratchetPos', ratchetPos]]) {
    if (v != null && (typeof v !== 'number' || v < 0)) throw new Error(`ordering: ${k} must be a non-negative number or null`)
  }
  return Object.freeze({ serverSeq, ratchetPos, senderClock, origin })
}

/**
 * Total order across two tokens. Returns -1, 0, or 1.
 *
 * Compares on the highest tier where BOTH tokens carry a value. Equality on an
 * authoritative tier means "same position" and returns 0 — the caller breaks
 * remaining ties with the envelopeId (see sortEnvelopes), never with arrival
 * time, which is precisely the thing multi-path delivery makes meaningless.
 */
export function compareTokens (a, b) {
  for (const tier of ['serverSeq', 'ratchetPos']) {
    const av = a[tier]; const bv = b[tier]
    if (av != null && bv != null) {
      if (av !== bv) return av < bv ? -1 : 1
      return 0
    }
  }
  if (a.senderClock !== b.senderClock) return a.senderClock < b.senderClock ? -1 : 1
  return 0
}

/**
 * Stable-sort envelopes by their ordering token, breaking ties by envelopeId so
 * the result is deterministic across devices. `getToken`/`getId` default to the
 * SealedEnvelope shape but are injectable for tests.
 */
export function sortEnvelopes (
  envelopes,
  getToken = (e) => e.ordering,
  getId = (e) => e.envelopeId
) {
  return [...envelopes].sort((x, y) => {
    const c = compareTokens(getToken(x), getToken(y))
    if (c !== 0) return c
    const ix = getId(x); const iy = getId(y)
    return ix < iy ? -1 : ix > iy ? 1 : 0
  })
}

/**
 * A per-origin reorder buffer over the senderClock tier.
 *
 * senderClock is a sender's own contiguous counter (1,2,3,…). A path that
 * delivers 1,3,2 must surface them 1,2,3; a duplicate 2 must be dropped; a gap
 * (…,4 while 3 is missing) must HOLD 4 until 3 fills it. This is the classic
 * in-order-release problem, and keeping it pure — no network, just push() —
 * makes "does it hold the gap?" a unit test.
 *
 * The buffer is per (origin). Cross-origin/global ordering is compareTokens'
 * job, not this one's.
 */
export function createReorderBuffer ({ start = 0 } = {}) {
  // origin -> { expected, held: Map<senderClock, item> }
  const state = new Map()

  function laneFor (origin) {
    let lane = state.get(origin)
    if (!lane) { lane = { expected: start + 1, held: new Map() }; state.set(origin, lane) }
    return lane
  }

  return {
    /**
     * Offer an item. Returns { released: [...], status } where status is:
     *   'released'  — item (and any it unblocked) came out in order
     *   'buffered'  — item is ahead of the gap and is being held
     *   'duplicate' — item is at/behind the high-water mark; dropped
     */
    push ({ origin, senderClock, item }) {
      if (origin == null) throw new Error('reorder: origin required')
      if (typeof senderClock !== 'number') throw new Error('reorder: senderClock must be a number')
      const lane = laneFor(origin)
      if (senderClock < lane.expected) return { released: [], status: 'duplicate' }
      if (lane.held.has(senderClock)) return { released: [], status: 'duplicate' }
      lane.held.set(senderClock, item)
      const released = []
      while (lane.held.has(lane.expected)) {
        released.push(lane.held.get(lane.expected))
        lane.held.delete(lane.expected)
        lane.expected++
      }
      return { released, status: released.length ? 'released' : 'buffered' }
    },
    /** How many items are held (blocked behind a gap) for an origin. */
    pending (origin) { return state.get(origin)?.held.size ?? 0 },
    /** The next senderClock this origin is waiting for. */
    expected (origin) { return state.get(origin)?.expected ?? start + 1 }
  }
}
