/**
 * Live Nearby Events — place / map / directions linking.
 *
 * The glue between an event and the map surfaces, built entirely on the
 * APPROVED Discovery V2 primitives (PR #60): the map single-source-of-truth
 * store and the HONEST directions layer (no invented ETA, no straight-line
 * masquerading as a route). Events contribute only the mapping from an event to
 * a place/marker.
 *
 * Directions honesty carries straight through: with no routing provider the
 * user gets a labelled straight-line distance, never a fabricated travel time.
 */
import { getDirections, straightLine } from '../discovery-v2/directions.js'

/**
 * The place an event happens at — its embedded normalised Place if present,
 * else a minimal place-shaped object from the event's own coordinates. Never
 * invents an address or venue name the source didn't provide.
 *
 * @param {object} event
 * @returns {object|null}
 */
export function eventPlace (event) {
  if (!event) return null
  if (event.place) return event.place
  if (typeof event.lat !== 'number' || typeof event.lon !== 'number') return null
  return Object.freeze({
    id: `${event.id}:venue`,
    provider: event.provider,
    name: event.title || 'Event venue',
    lat: event.lat,
    lon: event.lon,
    category: 'other',
    address: null,
    rating: null,
    distanceM: event.distanceM ?? null,
    raw: Object.freeze({})
  })
}

/**
 * A map marker for an event — id, coordinates, title, lifecycle state. Carries
 * no user data; the event's location is its own public venue location.
 *
 * @param {object} event
 * @returns {object|null}
 */
export function eventMapMarker (event) {
  if (!event || typeof event.lat !== 'number' || typeof event.lon !== 'number') return null
  return Object.freeze({
    id: event.id,
    lat: event.lat,
    lon: event.lon,
    title: event.title || 'Event',
    state: event.state || null,
    category: event.category || 'other'
  })
}

/**
 * Directions from a device-local origin to an event's venue, via the honest
 * Discovery V2 directions layer.
 *
 * @param {object} event
 * @param {{lat:number,lon:number}} from  device-local origin
 * @param {object} [opts]  { provider, signal } — optional routing provider
 * @returns {Promise<object>}
 */
export async function eventDirections (event, from, opts = {}) {
  const place = eventPlace(event)
  if (!place) return straightLine(from, null)
  return getDirections(from, { lat: place.lat, lon: place.lon }, opts)
}

/**
 * Reflect an event selection into a Discovery V2 map-state store, so the list,
 * the markers and the map centre all move together through the one store.
 *
 * @param {object} mapState  a createMapState() store
 * @param {object} event
 */
export function selectEventOnMap (mapState, event) {
  if (!mapState || !event) return
  mapState.select(event.id)
}
