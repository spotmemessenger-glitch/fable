/**
 * Live Nearby Events — provider-neutral event contracts.
 *
 * REUSE, not reinvention. This layer builds on the APPROVED Discovery V2
 * contracts (PR #60): the result-state lifecycle, the query model, the
 * secret-rejection guard and the place normaliser all come from
 * ../discovery-v2/contracts.js. Events add only what places don't have — time,
 * timezone, an event lifecycle, and source attribution — and normalise every
 * provider's shape into ONE stable Spot Me event record the rest of the
 * subsystem speaks.
 *
 * The same boundary rule applies: `normalizeEvent` copies only whitelisted
 * fields into a fresh frozen record, so a provider's raw payload (attribution
 * tokens, tracking ids, billing metadata, credential echoes) never rides along.
 *
 * TRUST. We do not invent events, attendance, popularity, prices, availability
 * or venue details. A field the provider did not supply stays null — never
 * guessed. `popularity` is accepted ONLY when a provider explicitly supplies a
 * bounded, attributable figure (see normalizeEvent); otherwise it is null.
 */
import {
  RESULT_STATE as PLACE_RESULT_STATE, normalizePlace, assertNoSecrets, normalizeQuery
} from '../discovery-v2/contracts.js'

/**
 * Result lifecycle — the Discovery V2 states plus LOADING (events surface an
 * explicit in-flight state while a live query is running).
 */
export const RESULT_STATE = Object.freeze({
  ...PLACE_RESULT_STATE,
  LOADING: 'loading'
})

/** Event lifecycle states. Temporal ones are DERIVED (see time.js); cancelled
 *  and postponed are asserted by the SOURCE and always win over the clock. */
export const EVENT_STATE = Object.freeze({
  UPCOMING: 'upcoming', // now < start
  HAPPENING_NOW: 'happening-now', // start <= now <= end
  ENDED: 'ended', // now > end
  CANCELLED: 'cancelled', // source says cancelled
  POSTPONED: 'postponed' // source says postponed (start may be tbd)
})

/** Source-asserted lifecycle a provider may set explicitly. */
export const SOURCE_LIFECYCLE = Object.freeze(['scheduled', 'cancelled', 'postponed'])

const EVENT_CATEGORIES = Object.freeze([
  'music', 'nightlife', 'arts', 'theatre', 'film', 'food', 'sports',
  'community', 'family', 'education', 'festival', 'other'
])

function num (v) { return typeof v === 'number' && Number.isFinite(v) ? v : null }
function str (v) { return typeof v === 'string' && v.trim() ? v.trim() : null }
function clampLat (v) { const n = num(v); return n != null && n >= -90 && n <= 90 ? n : null }
function clampLon (v) { const n = num(v); return n != null && n >= -180 && n <= 180 ? n : null }

/** Accept an epoch-ms instant or an ISO-8601 string → epoch ms, else null. */
function toEpochMs (v) {
  if (num(v) != null) return v
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}

/**
 * A source-attribution record. Every event carries WHERE it came from so the UI
 * can credit the source and a user can judge trust. No credentials here — just
 * a public provider/source name and an optional public URL.
 *
 * @typedef {object} SourceAttribution
 * @property {string} provider   the adapter name (audit)
 * @property {string|null} source display name of the origin (e.g. a listings org)
 * @property {string|null} url    public URL for the listing, when supplied
 */

/**
 * The stable Spot Me event record. The ONLY event shape the rest of the
 * subsystem knows.
 *
 * @typedef {object} EventRecord
 * @property {string} id                 `${provider}:${providerId}`
 * @property {string} provider
 * @property {string} title
 * @property {string|null} description
 * @property {string} category           one of EVENT_CATEGORIES
 * @property {number|null} startUTC       epoch ms (null ⇒ tbd, e.g. postponed)
 * @property {number|null} endUTC         epoch ms or null
 * @property {string|null} timezone       IANA tz id (e.g. "Asia/Kolkata")
 * @property {string} lifecycle           SOURCE_LIFECYCLE value
 * @property {object|null} place          a normalised Discovery V2 Place, or null
 * @property {number|null} lat            event coords (from place/venue)
 * @property {number|null} lon
 * @property {number|null} distanceM      filled by search (device-local origin)
 * @property {number|null} popularity     0..1, ONLY if the source supplied it
 * @property {SourceAttribution} attribution
 * @property {number|null} fetchedAt      when this record was retrieved (freshness)
 */

/**
 * Normalise a provider-shaped event candidate into an {@link EventRecord}.
 * Returns null when the minimum (id, title, usable coordinates) is missing.
 *
 * @param {object} candidate  provider-adapter-mapped fields
 * @param {string} providerName
 * @param {object} [opts]
 * @param {number} [opts.fetchedAt]  retrieval instant (freshness); defaults null
 * @returns {EventRecord|null}
 */
export function normalizeEvent (candidate, providerName, opts = {}) {
  if (!candidate || typeof candidate !== 'object') return null
  const provider = str(providerName) || str(candidate.provider) || 'unknown'
  const providerId = str(candidate.providerId) || str(candidate.id)
  const title = str(candidate.title) || str(candidate.name)
  if (!providerId || !title) return null

  // Coordinates may come from an embedded place/venue or directly on the event.
  const place = candidate.place ? normalizePlace(candidate.place, provider) : null
  const lat = place ? place.lat : clampLat(candidate.lat)
  const lon = place ? place.lon : clampLon(candidate.lon)
  if (lat == null || lon == null) return null

  const category = EVENT_CATEGORIES.includes(candidate.category) ? candidate.category : 'other'
  const lifecycle = SOURCE_LIFECYCLE.includes(candidate.lifecycle) ? candidate.lifecycle : 'scheduled'
  const startUTC = toEpochMs(candidate.startUTC ?? candidate.start ?? candidate.startTime)
  const endUTC = toEpochMs(candidate.endUTC ?? candidate.end ?? candidate.endTime)

  // popularity is trusted ONLY as an explicit, bounded number from the source.
  const rawPop = num(candidate.popularity)
  const popularity = rawPop != null ? Math.max(0, Math.min(1, rawPop)) : null

  return Object.freeze({
    id: `${provider}:${providerId}`,
    provider,
    title,
    description: str(candidate.description),
    category,
    startUTC,
    endUTC,
    timezone: str(candidate.timezone),
    lifecycle,
    place,
    lat,
    lon,
    distanceM: num(candidate.distanceM),
    popularity,
    attribution: Object.freeze({
      provider,
      source: str(candidate.source) || str(candidate.sourceName),
      url: str(candidate.url) || str(candidate.eventUrl)
    }),
    fetchedAt: num(opts.fetchedAt)
  })
}

/**
 * The event-provider contract. Duck-typed so the registry skips a malformed
 * adapter rather than crashing. Shape:
 * `{ name, searchEvents(query, ctx) → Promise<candidate[]> }`. Must not expose
 * credentials as own-properties (assertNoSecrets enforces).
 *
 * @param {object} provider
 * @returns {boolean}
 */
export function isValidEventProvider (provider) {
  return Boolean(provider) && typeof provider === 'object' &&
    typeof provider.name === 'string' && provider.name.trim().length > 0 &&
    typeof provider.searchEvents === 'function'
}

export const EVENT_CATEGORY_LIST = EVENT_CATEGORIES
// Re-exported so events callers have one import site.
export { assertNoSecrets, normalizeQuery }
