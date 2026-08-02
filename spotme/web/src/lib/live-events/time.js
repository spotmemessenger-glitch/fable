/**
 * Live Nearby Events — time, timezone, lifecycle and freshness.
 *
 * All temporal reasoning is on UTC instants (epoch ms), so it is timezone-safe
 * and deterministic; timezone is metadata for DISPLAY only. Every function that
 * depends on "now" takes it as an argument — nothing here reads the wall clock
 * itself, which is how the tests pin behaviour without faking globals.
 *
 * State rules, in order:
 *   1. The SOURCE wins: a cancelled/postponed listing is that, whatever the
 *      clock says — we never override a provider's lifecycle with time maths.
 *   2. Otherwise state is derived from now vs start/end (with a bounded default
 *      duration when the source gave no end).
 *
 * Freshness/expiry keeps the surface honest: ended events past a retention
 * window are removed, and records older than a TTL are considered stale.
 */
import { EVENT_STATE } from './contracts.js'

/** When a source gives no end time, assume this much for happening-now. */
export const DEFAULT_EVENT_DURATION_MS = 3 * 60 * 60 * 1000
/** Ended events older than this are pruned from the surface. */
export const DEFAULT_RETENTION_MS = 6 * 60 * 60 * 1000
/** A fetched record older than this is considered stale. */
export const DEFAULT_TTL_MS = 15 * 60 * 1000

function isNum (n) { return typeof n === 'number' && Number.isFinite(n) }

/** The effective end instant: explicit end, else start + default duration. */
export function effectiveEndUTC (event) {
  if (isNum(event?.endUTC)) return event.endUTC
  if (isNum(event?.startUTC)) return event.startUTC + DEFAULT_EVENT_DURATION_MS
  return null
}

/**
 * Derive the lifecycle state of an event at instant `now` (epoch ms).
 * @param {object} event  a normalised EventRecord
 * @param {number} now    epoch ms
 * @returns {string} an EVENT_STATE value
 */
export function deriveEventState (event, now) {
  if (!event) return EVENT_STATE.ENDED
  if (event.lifecycle === 'cancelled') return EVENT_STATE.CANCELLED
  if (event.lifecycle === 'postponed') return EVENT_STATE.POSTPONED
  if (!isNum(now)) return EVENT_STATE.UPCOMING
  if (!isNum(event.startUTC)) return EVENT_STATE.UPCOMING // scheduled but tbd
  if (now < event.startUTC) return EVENT_STATE.UPCOMING
  const end = effectiveEndUTC(event)
  if (end != null && now <= end) return EVENT_STATE.HAPPENING_NOW
  return EVENT_STATE.ENDED
}

/** Attach the derived `state` to an event (new object; input not mutated). */
export function withState (event, now) {
  return { ...event, state: deriveEventState(event, now) }
}

/** True when a record was fetched recently enough to trust. */
export function isFresh (event, now, ttlMs = DEFAULT_TTL_MS) {
  if (!isNum(event?.fetchedAt) || !isNum(now)) return true // unknown ⇒ don't drop
  return now - event.fetchedAt <= ttlMs
}

/** True when an ended event has aged past the retention window. */
export function isExpired (event, now, retentionMs = DEFAULT_RETENTION_MS) {
  if (!isNum(now)) return false
  if (event?.lifecycle === 'cancelled' || event?.lifecycle === 'postponed') return false
  const end = effectiveEndUTC(event)
  if (end == null) return false
  return now > end + retentionMs
}

/**
 * Remove events that should no longer be shown: expired (ended + past
 * retention) and, when requested, stale (older than TTL).
 *
 * @param {Array} events
 * @param {number} now
 * @param {object} [opts]
 * @param {number} [opts.retentionMs]
 * @param {number} [opts.ttlMs]
 * @param {boolean} [opts.dropStale=false]  also drop not-fresh records
 * @returns {Array}
 */
export function pruneStaleEvents (events, now, opts = {}) {
  const retentionMs = isNum(opts.retentionMs) ? opts.retentionMs : DEFAULT_RETENTION_MS
  const ttlMs = isNum(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS
  const dropStale = opts.dropStale === true
  if (!Array.isArray(events)) return []
  return events.filter((e) => {
    if (isExpired(e, now, retentionMs)) return false
    if (dropStale && !isFresh(e, now, ttlMs)) return false
    return true
  })
}

/**
 * Best-effort local-time parts for DISPLAY, using the event's IANA timezone.
 * Deterministic given (instant, timezone). Falls back to a UTC ISO string when
 * the zone is unknown or Intl is unavailable — never guesses an offset.
 *
 * @param {number} epochMs
 * @param {string|null} timezone  IANA id
 * @returns {{iso:string, timezone:string}}
 */
export function displayTime (epochMs, timezone) {
  if (!isNum(epochMs)) return { iso: '', timezone: 'UTC' }
  const date = new Date(epochMs)
  if (timezone) {
    try {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
      })
      return { iso: fmt.format(date), timezone }
    } catch { /* unknown zone → fall through to UTC */ }
  }
  return { iso: date.toISOString(), timezone: 'UTC' }
}
