/**
 * Live Nearby Events — engine assembly and the INERT gate.
 *
 * The single entry point the app would import to "turn on" Live Nearby Events,
 * built so importing it while dark does nothing observable. Flags default
 * all-false (flags.js); `createEventsEngine` reads them and, when the master
 * gate is down, returns an INERT engine — every method a no-op returning an
 * unavailable/empty shape. NO provider is held, NO search runner is built, NO
 * network is touched: zero activity while disabled.
 *
 * Flipping `flags.js` MASTER is the single deliberate act that lights the
 * subsystem up; the fence test proves nothing in the app reaches this while
 * dark, and that the subsystem is tree-shaken out of dist.
 */
import { SHIPPED_FLAGS, resolveFlags } from './flags.js'
import { RESULT_STATE } from './contracts.js'
import { createEventSearch } from './search.js'
import { createEventDetail } from './detail.js'
import { eventMapMarker, eventDirections, selectEventOnMap } from './linking.js'
import { straightLine } from '../discovery-v2/directions.js'
import { createMapState } from '../discovery-v2/mapstate.js'

/** The inert engine: shape-compatible, does nothing, reveals nothing. */
function inertEngine () {
  const noResults = { state: RESULT_STATE.UNAVAILABLE, results: [], radiusKm: null }
  return Object.freeze({
    enabled: false,
    async search () { return { ...noResults } },
    markers () { return [] },
    async directions (from, to) { return straightLine(from, to) },
    async openDetail () { return { event: null, status: 'unavailable' } },
    mapState: null,
    detail: null
  })
}

/**
 * Construct the Live Nearby Events engine.
 *
 * @param {object} [opts]
 * @param {Partial<import('./flags.js').EventsFlags>} [opts.flags]  TEST-only
 *        overrides; production passes nothing → shipped dark config.
 * @param {Array} [opts.providers]         event-provider adapters
 * @param {object} [opts.detailProvider]   optional detail-enrichment adapter
 * @param {object} [opts.routingProvider]  optional routing adapter
 * @param {(id:string)=>boolean} [opts.isBlocked]
 * @returns {object} an engine (inert while dark)
 */
export function createEventsEngine (opts = {}) {
  const flags = resolveFlags(opts.flags || SHIPPED_FLAGS)
  if (!flags.MASTER) return inertEngine()

  const search = flags.discovery
    ? createEventSearch({ providers: opts.providers || [], isBlocked: opts.isBlocked })
    : null
  const mapState = flags.mapSync ? createMapState(opts.mapInit || {}) : null
  const detail = flags.detail ? createEventDetail() : null

  return Object.freeze({
    enabled: true,
    flags,
    mapState,
    detail,
    async search (rawQuery, runOpts) {
      if (!search) return { state: RESULT_STATE.UNAVAILABLE, results: [], radiusKm: null }
      const env = await search.run(rawQuery, runOpts)
      if (mapState) mapState.setResults(env)
      return env
    },
    markers (events) {
      return (Array.isArray(events) ? events : []).map(eventMapMarker).filter(Boolean)
    },
    async directions (event, from, dOpts) {
      if (!flags.directions) return straightLine(from, null)
      return eventDirections(event, from, { provider: opts.routingProvider, ...dOpts })
    },
    async openDetail (event, dOpts) {
      if (!detail) return { event: event || null, status: 'ready' }
      if (mapState) selectEventOnMap(mapState, event)
      return detail.open(event, { provider: opts.detailProvider, ...dOpts })
    }
  })
}

export { SHIPPED_FLAGS, resolveFlags, assertShippedDark, isFullyDark } from './flags.js'
export { RESULT_STATE, EVENT_STATE } from './contracts.js'
