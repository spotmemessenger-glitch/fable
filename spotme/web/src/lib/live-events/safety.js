/**
 * Live Nearby Events — privacy, blocking and safety boundaries.
 *
 * Events are public listings, so the privacy risk is the OPPOSITE direction
 * from people-presence: the danger is leaking the USER back out (their
 * device-local search origin) or surfacing content from a blocked or unsafe
 * source. This module enforces three things on the result set:
 *
 *   1. BLOCKING — an event attributed to a blocked provider/source/organiser is
 *      removed (via an injected `isBlocked`).
 *   2. SAFETY — an event the source flags unsafe/age-restricted is removed
 *      unless the caller explicitly permits it (default: remove).
 *   3. ORIGIN PRIVACY — the user's search origin must never be written onto an
 *      event record. `assertNoOriginLeak` is the mutation-style guard: if a
 *      future change ever attaches the precise origin to results, tests fail.
 *
 * Nothing here does I/O; it is a pure filter over already-normalised events.
 */

function isNum (n) { return typeof n === 'number' && Number.isFinite(n) }

/**
 * Apply blocking + safety filtering to a set of events.
 *
 * @param {Array} events
 * @param {object} [opts]
 * @param {(id:string)=>boolean} [opts.isBlocked]  block predicate over
 *        provider / attribution.source / organiserId
 * @param {boolean} [opts.allowRestricted=false]   surface age-restricted/unsafe
 * @returns {Array}
 */
export function filterForSafety (events, opts = {}) {
  const isBlocked = typeof opts.isBlocked === 'function' ? opts.isBlocked : () => false
  const allowRestricted = opts.allowRestricted === true
  if (!Array.isArray(events)) return []
  return events.filter((e) => {
    if (!e) return false
    // Blocking: any identifier the event is attributed to.
    const ids = [e.provider, e.attribution?.source, e.organiserId, e.organizerId].filter(Boolean)
    if (ids.some((id) => isBlocked(id))) return false
    // Safety: source-asserted restriction/unsafe flags.
    if (!allowRestricted && (e.restricted === true || e.unsafe === true)) return false
    return true
  })
}

/**
 * Mutation-style guard for tests and defensive call sites: the user's precise
 * search origin must not appear anywhere on the event records. Throws on leak.
 *
 * @param {Array} events
 * @param {{lat:number, lon:number}|null} origin  the device-local search centre
 * @returns {boolean}
 */
export function assertNoOriginLeak (events, origin) {
  if (!origin || !isNum(origin.lat) || !isNum(origin.lon)) return true
  // A leak looks like the user's origin copied onto a record — either both
  // origin coordinates co-occurring on one event, or an origin-shaped field.
  for (const e of events || []) {
    if (e && String(e.originLat) === String(origin.lat) && String(e.originLon) === String(origin.lon)) {
      throw new Error(`event ${e.id} leaks the user's search origin`)
    }
    for (const k of Object.keys(e || {})) {
      if (/origin(lat|lon)|userlat|userlon|myposition/i.test(k)) {
        throw new Error(`event ${e.id} exposes an origin-shaped field: ${k}`)
      }
    }
  }
  return true
}
