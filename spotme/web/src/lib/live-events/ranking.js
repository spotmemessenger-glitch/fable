/**
 * Live Nearby Events — transparent, deterministic ranking.
 *
 * Not "AI". A score is an explicit weighted sum of four honest signals — time,
 * distance, query relevance, and supported popularity — with the weights as
 * readable constants and every component exposed via `scoreBreakdown`. Same
 * inputs ⇒ same order (ties broken by id), so the list never reshuffles under
 * the user.
 *
 * TIME is the events-specific signal: happening-now and soon-upcoming rank
 * highest; already-ended rank lowest. POPULARITY contributes ONLY when the
 * source explicitly supplied a bounded figure (contracts.js) — a null
 * popularity is a neutral zero, never an invented crowd.
 *
 * No personalisation and no sensitive-trait inference: ranking reads the event
 * and the query, nothing about the person.
 */
import { EVENT_STATE } from './contracts.js'
import { deriveEventState } from './time.js'

export const RANKING_WEIGHTS = Object.freeze({
  time: 0.40, // happening-now / soon > later > ended
  distance: 0.30, // nearer is better (device-local distance)
  relevance: 0.20, // query text/category match
  popularity: 0.10 // ONLY if the source supplied it
})

/** Distance at which the proximity signal decays to ~0 (metres). */
export const PROXIMITY_FALLOFF_M = 100_000
/** Upcoming events within this horizon get full-to-decaying time credit. */
export const TIME_HORIZON_MS = 72 * 60 * 60 * 1000

function clamp01 (n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/** Time signal ∈ [0,1]: now=1, decays over the horizon, ended≈0. */
function timeSignal (event, now) {
  const state = deriveEventState(event, now)
  if (state === EVENT_STATE.HAPPENING_NOW) return 1
  if (state === EVENT_STATE.ENDED || state === EVENT_STATE.CANCELLED) return 0
  if (state === EVENT_STATE.POSTPONED) return 0.1 // real but undated
  // UPCOMING: sooner is better, linear decay across the horizon.
  if (typeof event.startUTC === 'number' && typeof now === 'number') {
    const ahead = event.startUTC - now
    if (ahead <= 0) return 1
    return clamp01(1 - ahead / TIME_HORIZON_MS)
  }
  return 0.2 // upcoming, tbd start
}

function distanceSignal (distanceM) {
  if (typeof distanceM !== 'number' || !Number.isFinite(distanceM) || distanceM < 0) return 0
  return clamp01(1 - distanceM / PROXIMITY_FALLOFF_M)
}

function relevanceSignal (event, query) {
  const q = (query?.text || '').toLowerCase().trim()
  const cat = query?.category || null
  let score = 0
  if (cat && event.category === cat) score += 0.5
  if (q) {
    const hay = `${event.title || ''} ${event.category || ''} ${event.description || ''}`.toLowerCase()
    const tokens = q.split(/\s+/).filter(Boolean)
    if (tokens.length) score += 0.5 * (tokens.filter((t) => hay.includes(t)).length / tokens.length)
  } else if (!cat) {
    return 0.5 // nothing to match on ⇒ neutral
  }
  return clamp01(score)
}

/** Popularity ONLY from an explicit, source-supplied 0..1 figure. */
function popularitySignal (event) {
  return typeof event.popularity === 'number' && Number.isFinite(event.popularity)
    ? clamp01(event.popularity)
    : 0
}

/**
 * Full, transparent score breakdown for one event.
 * @param {object} event
 * @param {object} query
 * @param {number} now
 * @returns {{score:number, components:object}}
 */
export function scoreBreakdown (event, query = {}, now = 0) {
  const signals = {
    time: timeSignal(event, now),
    distance: distanceSignal(event.distanceM),
    relevance: relevanceSignal(event, query),
    popularity: popularitySignal(event)
  }
  let score = 0
  const components = {}
  for (const key of Object.keys(RANKING_WEIGHTS)) {
    const weighted = RANKING_WEIGHTS[key] * signals[key]
    components[key] = { signal: signals[key], weight: RANKING_WEIGHTS[key], weighted }
    score += weighted
  }
  return { score, components }
}

/**
 * Rank events, most relevant first. Pure, stable (ties break by id). Returns
 * NEW objects carrying `score`/`rankReason`; inputs are not mutated.
 *
 * @param {Array} events
 * @param {object} query
 * @param {number} now
 * @returns {Array}
 */
export function rankEvents (events, query = {}, now = 0) {
  if (!Array.isArray(events)) return []
  const scored = events
    .filter((e) => e && e.id != null)
    .map((e) => {
      const { score, components } = scoreBreakdown(e, query, now)
      return { ...e, score, rankReason: components }
    })
  scored.sort((a, b) => (b.score - a.score) || String(a.id).localeCompare(String(b.id)))
  return scored
}
