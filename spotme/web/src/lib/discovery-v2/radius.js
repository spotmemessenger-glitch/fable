/**
 * Discovery V2 — adaptive search radius.
 *
 * A single fixed radius is always wrong: 10 km finds nothing in a village and
 * drowns you in a city. This engine widens the search in fixed steps
 * (10→15→25→50→100 km) only as far as it must to clear a minimum useful result
 * count, then stops — so a dense area answers instantly at 10 km and a sparse
 * one keeps reaching, but never past the 100 km cap.
 *
 * The search origin is the DEVICE-LOCAL precise fix (distance is a local
 * computation); the radius never leaves the device except as a plain number a
 * provider needs to bound its own query.
 *
 * Everything here is deterministic and cancellable:
 *   - `fetchAtRadius(radiusKm, ctx)` is injected, so tests drive it with a stub;
 *   - an `AbortSignal` stops expansion between steps;
 *   - each step tags its results with a monotonically increasing `epoch`, and a
 *     stale epoch (a newer search started) is rejected rather than rendered.
 */

/** The fixed expansion ladder, in kilometres. */
export const RADIUS_STEPS_KM = Object.freeze([10, 15, 25, 50, 100])
/** Stop expanding once at least this many results are in hand. */
export const DEFAULT_MIN_RESULTS = 8
/** Hard cap — the last rung of the ladder. */
export const MAX_RADIUS_KM = RADIUS_STEPS_KM[RADIUS_STEPS_KM.length - 1]

class AbortError extends Error {
  constructor () { super('aborted'); this.name = 'AbortError' }
}
class SupersededError extends Error {
  constructor () { super('superseded'); this.name = 'SupersededError' }
}

function dedupeById (items) {
  const seen = new Set()
  const out = []
  for (const it of items) {
    if (!it || it.id == null || seen.has(it.id)) continue
    seen.add(it.id)
    out.push(it)
  }
  return out
}

/**
 * Expand the radius until `minResults` distinct results are found or the ladder
 * is exhausted.
 *
 * @param {object} opts
 * @param {(radiusKm:number, ctx:object) => Promise<Array>} opts.fetchAtRadius
 *        performs one lookup bounded to `radiusKm`; returns place candidates.
 * @param {number} [opts.minResults]
 * @param {number[]} [opts.steps]
 * @param {AbortSignal} [opts.signal]  cancellation between steps
 * @param {number} [opts.epoch]        this search's epoch (stale-guard)
 * @param {() => number} [opts.currentEpoch] returns the latest epoch; if it has
 *        moved past `epoch`, this search is superseded and rejects.
 * @param {object} [opts.ctx]          passed through to fetchAtRadius
 * @returns {Promise<{results:Array, radiusKm:number, steps:number, stoppedBy:string}>}
 */
export async function expandingSearch (opts) {
  const {
    fetchAtRadius,
    minResults = DEFAULT_MIN_RESULTS,
    steps = RADIUS_STEPS_KM,
    signal,
    epoch = 0,
    currentEpoch = () => epoch,
    ctx = {}
  } = opts || {}

  if (typeof fetchAtRadius !== 'function') {
    throw new TypeError('expandingSearch requires fetchAtRadius')
  }

  const abortIfNeeded = () => {
    if (signal?.aborted) throw new AbortError()
    if (currentEpoch() > epoch) throw new SupersededError()
  }

  let merged = []
  let usedRadius = steps[0]
  let stepCount = 0

  for (const radiusKm of steps) {
    abortIfNeeded()
    usedRadius = radiusKm
    stepCount++
    const batch = await fetchAtRadius(radiusKm, { ...ctx, radiusKm, epoch })
    abortIfNeeded() // a fetch can straddle an abort/supersede
    // Widening is inclusive: each step re-covers the inner disc, so merge+dedup
    // rather than assuming disjoint rings.
    merged = dedupeById(merged.concat(Array.isArray(batch) ? batch : []))
    if (merged.length >= minResults) {
      return { results: merged, radiusKm: usedRadius, steps: stepCount, stoppedBy: 'min-results' }
    }
  }

  return { results: merged, radiusKm: usedRadius, steps: stepCount, stoppedBy: 'max-radius' }
}

export { AbortError, SupersededError }
