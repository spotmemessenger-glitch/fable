/**
 * Live Nearby Events — search orchestration.
 *
 * Reuses the APPROVED Discovery V2 machinery (PR #60): the adaptive-radius
 * engine (`expandingSearch` — 10→15→25→50→100 km, min-result stop, cancel,
 * epoch stale-guard) and the device-local haversine. Events add only the
 * event-specific steps: normalise + attach source attribution, dedup across
 * providers/radii, derive lifecycle state at `now`, prune stale/expired, apply
 * safety/blocking, then rank by time+distance+relevance+popularity.
 *
 * Resolves to ONE result state (ok/partial/empty/unavailable/failed/
 * superseded). NO FAKE PROVIDERS: with none configured the honest answer is
 * `unavailable`, never invented events. We never invent attendance, popularity,
 * prices, availability or venue details — only what a provider actually returns.
 *
 * PRIVACY: the search origin is the DEVICE-LOCAL fix, used only to bound the
 * radius and compute `distanceM`. It is passed to a provider solely because a
 * nearby lookup needs a centre; it is never stored on results, logged, or
 * attached anywhere (safety.assertNoOriginLeak guards this).
 */
import { RESULT_STATE, normalizeQuery, normalizeEvent, isValidEventProvider, assertNoSecrets } from './contracts.js'
import { expandingSearch, AbortError, SupersededError, DEFAULT_MIN_RESULTS } from '../discovery-v2/radius.js'
import { distanceM } from '../discovery-v2/search.js'
import { withState, pruneStaleEvents } from './time.js'
import { filterForSafety } from './safety.js'
import { rankEvents } from './ranking.js'

/**
 * Build an event-search runner over a fixed set of provider adapters. The epoch
 * counter lives in the closure so successive `run` calls supersede each other.
 *
 * @param {object} opts
 * @param {Array} [opts.providers]
 * @param {number} [opts.minResults]
 * @param {(id:string)=>boolean} [opts.isBlocked]
 * @returns {{run:Function, providerCount:number}}
 */
export function createEventSearch (opts = {}) {
  const providers = (opts.providers || []).filter((p) => {
    if (!isValidEventProvider(p)) return false
    assertNoSecrets(p) // credential-carrying adapter fails loud, not silent
    return true
  })
  const minResults = opts.minResults || DEFAULT_MIN_RESULTS
  const isBlocked = opts.isBlocked
  let epoch = 0

  /**
   * Run one event search. `now` is injectable for deterministic tests.
   * @param {object} rawQuery
   * @param {object} [runOpts]
   * @param {AbortSignal} [runOpts.signal]
   * @param {number} [runOpts.now]  epoch ms (defaults to Date.now())
   * @returns {Promise<object>}
   */
  async function run (rawQuery, runOpts = {}) {
    const myEpoch = ++epoch
    const query = normalizeQuery(rawQuery)
    const signal = runOpts.signal
    const now = typeof runOpts.now === 'number' ? runOpts.now : Date.now()
    const origin = query.origin // DEVICE-LOCAL

    if (providers.length === 0) {
      return { state: RESULT_STATE.UNAVAILABLE, results: [], radiusKm: null, query, providerErrors: 0 }
    }

    let providerErrors = 0

    const fetchAtRadius = async (radiusKm) => {
      const settled = await Promise.all(providers.map(async (p) => {
        try {
          const raw = await p.searchEvents(query, { radiusKm, origin, signal, now })
          const list = Array.isArray(raw) ? raw : []
          return list
            .map((c) => normalizeEvent(c, p.name, { fetchedAt: now }))
            .filter(Boolean)
            .map((ev) => ({ ...ev, distanceM: distanceM(origin, ev) ?? ev.distanceM ?? null }))
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
        fetchAtRadius, minResults, signal, epoch: myEpoch, currentEpoch: () => epoch
      })
    } catch (err) {
      if (err instanceof SupersededError || err instanceof AbortError || err?.name === 'AbortError') {
        return { state: RESULT_STATE.SUPERSEDED, results: [], radiusKm: null, query, providerErrors }
      }
      return { state: RESULT_STATE.FAILED, results: [], radiusKm: null, query, providerErrors: providerErrors || 1 }
    }

    if (epoch !== myEpoch) {
      return { state: RESULT_STATE.SUPERSEDED, results: [], radiusKm: null, query, providerErrors }
    }

    // Derive state → prune expired/stale → safety/blocking → rank.
    const stated = expanded.results.map((ev) => withState(ev, now))
    const fresh = pruneStaleEvents(stated, now)
    const safe = filterForSafety(fresh, { isBlocked })
    const ranked = rankEvents(safe, query, now)

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
