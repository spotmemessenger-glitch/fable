/**
 * Discovery V2 — engine assembly and the INERT gate.
 *
 * This is the only module the app would ever import to "turn on" Discovery V2,
 * and it is built so that importing it while dark does nothing observable. The
 * flags default all-false (flags.js); `createDiscoveryEngine` reads them and,
 * when the master gate is down, returns an INERT engine — every method is a
 * no-op returning an unavailable/empty shape. No providers are contacted, no
 * state store is created, no presence is read.
 *
 * So a stray `import` cannot switch the feature on: the guarded construction
 * happens here, and the fence test proves nothing in the app calls it while
 * MASTER is false. Flipping MASTER is the single deliberate act that lights the
 * subsystem up.
 */
import { SHIPPED_FLAGS, resolveFlags } from './flags.js'
import { RESULT_STATE } from './contracts.js'
import { createSearch } from './search.js'
import { createMapState } from './mapstate.js'
import { getDirections, straightLine } from './directions.js'
import { toPeopleMarkers } from './people.js'
import { deriveIntent } from './intent.js'
import { maxDisplacementM } from '../geo-approx.js'

/** The inert engine: shape-compatible, does nothing, reveals nothing. */
function inertEngine () {
  const noResults = { state: RESULT_STATE.UNAVAILABLE, results: [], radiusKm: null }
  return Object.freeze({
    enabled: false,
    async search () { return { ...noResults } },
    peopleMarkers () { return [] },
    async directions (from, to) { return straightLine(from, to) },
    intent (text) { return { text: text || '', category: null, filters: {} } },
    mapState: null
  })
}

/**
 * Construct the Discovery V2 engine.
 *
 * @param {object} [opts]
 * @param {Partial<import('./flags.js').DiscoveryFlags>} [opts.flags]  TEST-only
 *        overrides; production passes nothing and gets the shipped dark config.
 * @param {Array} [opts.providers]        place-search adapters
 * @param {object} [opts.routingProvider] optional routing adapter
 * @param {(id:string)=>boolean} [opts.isBlocked]
 * @param {string} [opts.selfId]
 * @returns {object} an engine (inert while dark)
 */
export function createDiscoveryEngine (opts = {}) {
  // In shipped code opts.flags is undefined → SHIPPED_FLAGS (all false).
  const flags = resolveFlags(opts.flags || SHIPPED_FLAGS)
  if (!flags.MASTER) return inertEngine()

  const search = flags.placeSearch
    ? createSearch({ providers: opts.providers || [] })
    : null
  const mapState = flags.mapSync ? createMapState(opts.mapInit || {}) : null

  return Object.freeze({
    enabled: true,
    flags,
    mapState,
    async search (rawQuery, runOpts) {
      if (!search) return { state: RESULT_STATE.UNAVAILABLE, results: [], radiusKm: null }
      const q = flags.queryIntent
        ? { ...rawQuery, ...deriveIntent(rawQuery?.text || '', { baseQuery: rawQuery }) }
        : rawQuery
      const env = await search.run(q, runOpts)
      if (mapState) mapState.setResults(env)
      return env
    },
    peopleMarkers (announcements) {
      if (!flags.peopleDiscovery) return []
      return toPeopleMarkers(announcements, {
        isBlocked: opts.isBlocked,
        selfId: opts.selfId,
        maxDisplacementM: maxDisplacementM()
      })
    },
    async directions (from, to, dOpts) {
      if (!flags.directions) return straightLine(from, to)
      return getDirections(from, to, { provider: opts.routingProvider, ...dOpts })
    },
    intent (text, iOpts) {
      if (!flags.queryIntent) return { text: text || '', category: null, filters: {} }
      return deriveIntent(text, iOpts)
    }
  })
}

// Re-exports so consumers/tests have one entry point.
export { SHIPPED_FLAGS, resolveFlags, assertShippedDark, isFullyDark } from './flags.js'
export { RESULT_STATE } from './contracts.js'
