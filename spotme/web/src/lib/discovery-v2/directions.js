/**
 * Discovery V2 — directions, honestly.
 *
 * The one rule: never present a guess as a fact. If no routing provider is
 * configured, directions are UNSUPPORTED — we do not draw a straight line and
 * call it a route, and we do not multiply crow-flies distance by a made-up
 * factor and call it an ETA. A straight-line figure MAY be shown, but only
 * labelled as straight-line distance, never as travel time or driving distance.
 *
 * When a real routing provider IS present, its result is normalised and passed
 * through unembellished. Its ETA is only surfaced when the provider actually
 * returned a duration; a missing duration stays missing.
 */
import { distanceM } from './search.js'

/** Directions outcome states. */
export const DIRECTIONS_STATE = Object.freeze({
  UNSUPPORTED: 'unsupported', // no routing provider — straight-line info only
  OK: 'ok', // a real route from a provider
  FAILED: 'failed' // provider was asked and errored
})

/**
 * The honest straight-line fallback. Carries distance ONLY, explicitly labelled,
 * and NO duration/ETA — because we cannot know travel time without routing.
 *
 * @param {{lat:number,lon:number}} from
 * @param {{lat:number,lon:number}} to
 * @returns {object}
 */
export function straightLine (from, to) {
  const meters = distanceM(from, to)
  return Object.freeze({
    state: DIRECTIONS_STATE.UNSUPPORTED,
    kind: 'straight-line', // NOT a driving route
    straightLineM: meters,
    // Explicitly null and named so a renderer cannot mistake absence for zero.
    durationS: null,
    routeDistanceM: null,
    label: meters != null ? 'straight-line distance' : 'distance unavailable',
    provider: null
  })
}

/**
 * Get directions between two points.
 *
 * @param {{lat:number,lon:number}} from
 * @param {{lat:number,lon:number}} to
 * @param {object} [opts]
 * @param {object} [opts.provider]  optional routing provider:
 *        `{ name, route(from, to) → Promise<{durationS?, distanceM?, geometry?}>}`
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object>}
 */
export async function getDirections (from, to, opts = {}) {
  const provider = opts.provider
  if (!provider || typeof provider.route !== 'function') {
    // No router: honest straight-line, clearly labelled, no invented ETA.
    return straightLine(from, to)
  }
  try {
    const r = await provider.route(from, to, { signal: opts.signal })
    const durationS = typeof r?.durationS === 'number' && Number.isFinite(r.durationS) ? r.durationS : null
    const routeDistanceM = typeof r?.distanceM === 'number' && Number.isFinite(r.distanceM) ? r.distanceM : null
    return Object.freeze({
      state: DIRECTIONS_STATE.OK,
      kind: 'route',
      straightLineM: distanceM(from, to),
      // Only real, provider-supplied values — never synthesised.
      durationS,
      routeDistanceM,
      geometry: r?.geometry || null,
      // If the provider gave no duration, say so; do not manufacture an ETA.
      label: durationS != null ? 'estimated travel time' : 'route (no ETA available)',
      provider: provider.name || 'routing'
    })
  } catch {
    // Asked and failed — fall back to the honest straight line, flagged failed.
    const sl = straightLine(from, to)
    return Object.freeze({ ...sl, state: DIRECTIONS_STATE.FAILED, provider: provider.name || 'routing' })
  }
}
