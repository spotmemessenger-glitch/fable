/**
 * Discovery V2 — transparent, deterministic ranking.
 *
 * NOT "AI ranking". There is no model here and nothing opaque: a result's score
 * is an explicit weighted sum of a few honest signals — proximity, provider
 * rating, name/category match to the query, and open-now — with the weights
 * declared as constants a reviewer can read and a test can pin. The same inputs
 * always produce the same order (ties broken by id) so results never shuffle
 * under the user between renders.
 *
 * PRIVACY / NON-DISCRIMINATION. Ranking reads ONLY place attributes and the
 * query. It does not read, infer, or weight any sensitive trait of a person,
 * and there is no personalisation term — personalisation is a future pillar and
 * is deliberately absent, not merely disabled. `scoreBreakdown` exposes every
 * component so a user (or an auditor) can see exactly why one place outranks
 * another.
 */

/** The weights. Sum need not be 1; scores are relative, not probabilities. */
export const RANKING_WEIGHTS = Object.freeze({
  proximity: 0.45, // closer is better (device-local distance)
  rating: 0.25, // provider rating, when present
  textMatch: 0.20, // query text/category match
  openNow: 0.10 // open right now, when known
})

/** Distance at which the proximity signal decays to ~0 (metres). */
export const PROXIMITY_FALLOFF_M = 50_000

function clamp01 (n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/** Proximity → [0,1], 1 at the origin, decaying linearly to 0 at falloff. */
function proximitySignal (distanceM) {
  if (typeof distanceM !== 'number' || !Number.isFinite(distanceM) || distanceM < 0) return 0
  return clamp01(1 - distanceM / PROXIMITY_FALLOFF_M)
}

/** Rating (0..5) → [0,1]; null rating is a neutral 0 contribution, not a guess. */
function ratingSignal (rating) {
  if (typeof rating !== 'number' || !Number.isFinite(rating)) return 0
  return clamp01(rating / 5)
}

/** Text/category overlap → [0,1]. Simple, explainable token containment. */
function textMatchSignal (place, query) {
  const q = (query?.text || '').toLowerCase().trim()
  const cat = query?.category || null
  let score = 0
  if (cat && place.category === cat) score += 0.5
  if (q) {
    const hay = `${place.name || ''} ${place.category || ''} ${place.address || ''}`.toLowerCase()
    const tokens = q.split(/\s+/).filter(Boolean)
    if (tokens.length) {
      const hits = tokens.filter((t) => hay.includes(t)).length
      score += 0.5 * (hits / tokens.length)
    }
  } else if (!cat) {
    // No text and no category ⇒ nothing to match on; stay neutral, don't punish.
    return 0.5
  }
  return clamp01(score)
}

function openNowSignal (place, query) {
  // Only rewards a KNOWN-open place when the user asked for open-now; unknown
  // openness contributes nothing (we never invent it).
  if (!query?.filters?.openNow) return 0
  return place.openNow === true ? 1 : 0
}

/**
 * Full score breakdown for one place — every weighted component, transparent.
 *
 * @param {object} place  a normalised Place (may carry openNow)
 * @param {object} query  a normalised SearchQuery
 * @returns {{score:number, components:object}}
 */
export function scoreBreakdown (place, query = {}) {
  const signals = {
    proximity: proximitySignal(place.distanceM),
    rating: ratingSignal(place.rating),
    textMatch: textMatchSignal(place, query),
    openNow: openNowSignal(place, query)
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
 * Rank places, most relevant first. Pure and stable: ties (equal score) break
 * by id so the order is total and reproducible. Returns NEW objects carrying
 * `score`/`rankReason`; inputs are not mutated.
 *
 * @param {Array} places
 * @param {object} query
 * @returns {Array}
 */
export function rankPlaces (places, query = {}) {
  if (!Array.isArray(places)) return []
  const scored = places
    .filter((p) => p && p.id != null)
    .map((p) => {
      const { score, components } = scoreBreakdown(p, query)
      return { ...p, score, rankReason: components }
    })
  scored.sort((a, b) => (b.score - a.score) || String(a.id).localeCompare(String(b.id)))
  return scored
}
