/**
 * Discovery V2 — provider-neutral contracts.
 *
 * The whole point of this module is that NO vendor leaks upward. A place
 * provider (any mapping/POI service) speaks its own shape; adapters normalise
 * that into the stable Spot Me models defined here, and the rest of Discovery
 * V2 only ever sees these. Swapping or adding a provider is an adapter change,
 * never a change to search, ranking, or the map.
 *
 * SECURITY: normalisation is also a boundary. `normalizePlace` copies only the
 * whitelisted fields into a fresh object — a provider's raw payload (which may
 * carry API-key echoes, attribution tokens, tracking ids, or nested billing
 * metadata) never rides along into app state, logs, or the wire.
 *
 * Nothing here does I/O, and nothing here is provider-specific.
 */

/** Result lifecycle states — every search resolves to exactly one. */
export const RESULT_STATE = Object.freeze({
  EMPTY: 'empty', // provider(s) answered, zero matches
  PARTIAL: 'partial', // some providers answered, some failed/timed out
  OK: 'ok', // full success with results
  UNAVAILABLE: 'unavailable', // no provider configured/reachable
  FAILED: 'failed', // all providers errored
  SUPERSEDED: 'superseded' // a newer query replaced this one (see search.js)
})

const CATEGORIES = Object.freeze([
  'food', 'drink', 'cafe', 'shopping', 'nightlife', 'outdoors',
  'culture', 'services', 'lodging', 'transport', 'other'
])

function num (v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function str (v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function clampLat (v) {
  const n = num(v)
  return n != null && n >= -90 && n <= 90 ? n : null
}

function clampLon (v) {
  const n = num(v)
  return n != null && n >= -180 && n <= 180 ? n : null
}

/**
 * The stable Spot Me place model. This is the ONLY place shape the rest of
 * Discovery V2 knows about.
 *
 * @typedef {object} Place
 * @property {string}  id        stable Spot Me id: `${provider}:${providerId}`
 * @property {string}  provider  which adapter produced it (audit, not display)
 * @property {string}  name
 * @property {number}  lat
 * @property {number}  lon
 * @property {string}  category  one of CATEGORIES
 * @property {string|null} address
 * @property {number|null} rating       0..5 or null when the provider has none
 * @property {number|null} distanceM    filled by search using the DEVICE-LOCAL
 *                                       origin; never sent to a provider
 * @property {object}  raw       intentionally EMPTY — normalisation drops it
 */

/**
 * Normalise a provider-shaped place into a {@link Place}. Returns null when the
 * candidate lacks the minimum (id, name, usable coordinates) — a provider that
 * hands back junk yields nothing, never a half-built place.
 *
 * @param {object} candidate  already field-mapped by a provider adapter
 * @param {string} providerName
 * @returns {Place|null}
 */
export function normalizePlace (candidate, providerName) {
  if (!candidate || typeof candidate !== 'object') return null
  const provider = str(providerName) || str(candidate.provider) || 'unknown'
  const providerId = str(candidate.providerId) || str(candidate.id)
  const name = str(candidate.name)
  const lat = clampLat(candidate.lat)
  const lon = clampLon(candidate.lon)
  if (!providerId || !name || lat == null || lon == null) return null

  const category = CATEGORIES.includes(candidate.category) ? candidate.category : 'other'
  const rating = num(candidate.rating)
  return Object.freeze({
    id: `${provider}:${providerId}`,
    provider,
    name,
    lat,
    lon,
    category,
    address: str(candidate.address),
    rating: rating != null ? Math.max(0, Math.min(5, rating)) : null,
    distanceM: num(candidate.distanceM),
    // Deliberately empty: the raw provider payload does NOT propagate.
    raw: Object.freeze({})
  })
}

/**
 * The provider contract every adapter must satisfy. Duck-typed (this returns a
 * boolean rather than throwing) so the registry can skip a malformed adapter
 * instead of taking the whole search down with it.
 *
 * A provider is `{ name, search(query, ctx) → Promise<candidate[]> }` and must
 * NOT expose credentials on the object — `assertNoSecrets` enforces that.
 *
 * @param {object} provider
 * @returns {boolean}
 */
export function isValidProvider (provider) {
  return Boolean(provider) &&
    typeof provider === 'object' &&
    typeof provider.name === 'string' && provider.name.trim().length > 0 &&
    typeof provider.search === 'function'
}

const SECRET_KEYS = /^(key|apikey|api_key|token|secret|password|authorization|bearer|credential)s?$/i

/**
 * Throw if a provider object carries secret-shaped own-properties. Credentials
 * belong in the adapter's closure or in injected config — never as enumerable
 * fields that could be serialised into logs, telemetry, or a debug handle.
 *
 * @param {object} provider
 * @throws {Error}
 */
export function assertNoSecrets (provider) {
  if (!provider || typeof provider !== 'object') return true
  for (const key of Object.keys(provider)) {
    if (SECRET_KEYS.test(key)) {
      throw new Error(`provider "${provider.name || '?'}" exposes a secret-shaped field: ${key}`)
    }
  }
  return true
}

/**
 * Normalise a raw user query into a stable search query model.
 *
 * @typedef {object} SearchQuery
 * @property {string}  text
 * @property {string|null} category
 * @property {object}  filters      opaque provider-neutral filters (openNow…)
 * @property {{lat:number, lon:number}|null} origin  DEVICE-LOCAL search centre
 */

/**
 * @param {object} raw
 * @returns {SearchQuery}
 */
export function normalizeQuery (raw = {}) {
  const text = str(raw.text) || ''
  const category = CATEGORIES.includes(raw.category) ? raw.category : null
  const filters = raw.filters && typeof raw.filters === 'object' ? { ...raw.filters } : {}
  let origin = null
  if (raw.origin) {
    const lat = clampLat(raw.origin.lat)
    const lon = clampLon(raw.origin.lon)
    if (lat != null && lon != null) origin = { lat, lon }
  }
  return Object.freeze({ text, category, filters: Object.freeze(filters), origin })
}

export const PLACE_CATEGORIES = CATEGORIES
