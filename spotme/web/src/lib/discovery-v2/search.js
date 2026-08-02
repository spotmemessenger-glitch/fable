/**
 * Discovery V2 — search orchestration.
 *
 * Ties the pieces together: normalise the query, fan out to the configured
 * provider adapters at an adaptive radius, normalise + dedup + distance-tag +
 * rank the results, and resolve to exactly ONE result state
 * (ok/partial/empty/unavailable/failed/superseded). No fake providers — with
 * none configured the honest answer is `unavailable`, not invented places.
 *
 * CANCELLATION & STALENESS. Each call gets a monotonically increasing epoch. A
 * newer search bumps the epoch; the older one, if still running, resolves
 * `superseded` and its results are dropped — the map never renders a stale
 * response that lands after a fresher one. An `AbortSignal` cancels outright.
 *
 * PRIVACY. The search origin is the DEVICE-LOCAL precise fix, used only to
 * compute `distanceM` and to bound the radius. It is passed to a provider only
 * because a nearby lookup technically needs a centre; it is never stored,
 * logged, or attached to results beyond the distance number.
 */
import { RESULT_STATE, normalizeQuery, normalizePlace, isValidProvider, assertNoSecrets } from './contracts.js'
import { expandingSearch, AbortError, SupersededError, DEFAULT_MIN_RESULTS } from './radius.js'
import { rankPlaces } from './ranking.js'

/** Haversine metres between two {lat,lon}; null if either is missing. */
export function distanceM (a, b) {
  if (a?.lat == null || b?.lat == null || a?.lon == null || b?.lon == null) return null
  const R = 6371000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLon = ((b.lon - a.lon) * Math.PI) / 180
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(s)))
}

/**
 * Build a search runner over a fixed set of provider adapters. The epoch
 * counter lives in the closure so successive `run` calls supersede each other.
 *
 * @param {object} opts
 * @param {Array} [opts.providers]  provider adapters (validated + secret-checked)
 * @param {number} [opts.minResults]
 * @returns {{run: Function, providerCount: number}}
 */
export function createSearch (opts = {}) {
  const providers = (opts.providers || []).filter((p) => {
    if (!isValidProvider(p)) return false
    assertNoSecrets(p) // throws on a credential-carrying adapter — fail loud, not silent
    return true
  })
  const minResults = opts.minResults || DEFAULT_MIN_RESULTS
  let epoch = 0

  /**
   * Run one search. Resolves to a single result-state envelope.
   *
   * @param {object} rawQuery
   * @param {object} [runOpts]
   * @param {AbortSignal} [runOpts.signal]
   * @returns {Promise<{state:string, results:Array, radiusKm:number|null, query:object, providerErrors:number}>}
   */
  async function run (rawQuery, runOpts = {}) {
    const myEpoch = ++epoch
    const query = normalizeQuery(rawQuery)
    const signal = runOpts.signal
    const origin = query.origin // DEVICE-LOCAL

    if (providers.length === 0) {
      return { state: RESULT_STATE.UNAVAILABLE, results: [], radiusKm: null, query, providerErrors: 0 }
    }

    let providerErrors = 0

    // One radius step: query every provider, normalise, drop failures, tag
    // distance. Provider errors are counted (→ partial/failed), never thrown up.
    const fetchAtRadius = async (radiusKm, ctx) => {
      const settled = await Promise.all(providers.map(async (p) => {
        try {
          const raw = await p.search(query, { radiusKm, origin, signal })
          const list = Array.isArray(raw) ? raw : []
          return list
            .map((c) => normalizePlace(c, p.name))
            .filter(Boolean)
            .map((place) => ({ ...place, distanceM: distanceM(origin, place) ?? place.distanceM ?? null }))
        } catch (err) {
          if (err?.name === 'AbortError') throw err
          providerErrors++
          return []
        }
      }))
      return settled.flat()
    }

    let expanded
    try {
      expanded = await expandingSearch({
        fetchAtRadius,
        minResults,
        signal,
        epoch: myEpoch,
        currentEpoch: () => epoch
      })
    } catch (err) {
      if (err instanceof SupersededError) {
        return { state: RESULT_STATE.SUPERSEDED, results: [], radiusKm: null, query, providerErrors }
      }
      if (err instanceof AbortError || err?.name === 'AbortError') {
        return { state: RESULT_STATE.SUPERSEDED, results: [], radiusKm: null, query, providerErrors }
      }
      // An unexpected orchestration error is a hard failure, honestly reported.
      return { state: RESULT_STATE.FAILED, results: [], radiusKm: null, query, providerErrors: providerErrors || 1 }
    }

    // A newer search finished after us: drop, don't render.
    if (epoch !== myEpoch) {
      return { state: RESULT_STATE.SUPERSEDED, results: [], radiusKm: null, query, providerErrors }
    }

    const ranked = rankPlaces(expanded.results, query)
    const allFailed = providerErrors >= providers.length && ranked.length === 0

    let state
    if (allFailed) state = RESULT_STATE.FAILED
    else if (ranked.length === 0) state = RESULT_STATE.EMPTY
    else if (providerErrors > 0) state = RESULT_STATE.PARTIAL
    else state = RESULT_STATE.OK

    return { state, results: ranked, radiusKm: expanded.radiusKm, query, providerErrors }
  }

  return { run, providerCount: providers.length }
}
