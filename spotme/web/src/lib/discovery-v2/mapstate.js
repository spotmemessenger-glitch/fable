/**
 * Discovery V2 — map/result single source of truth.
 *
 * The map and the result list are two views of ONE state, never two copies that
 * drift. Everything — the result set, which item is selected/hovered, the map
 * centre and zoom — lives in this one store; the map and the list both read from
 * it and both write through it. Selecting a row highlights its marker and vice
 * versa because they are literally the same `selectedId`, not two ids kept in
 * sync by hand.
 *
 * Pure and framework-free: a tiny subscribe/notify store with immutable
 * snapshots, so it can drive any renderer and be tested without a DOM.
 */

function freezeSnapshot (s) {
  return Object.freeze({
    results: Object.freeze(s.results.slice()),
    selectedId: s.selectedId,
    hoveredId: s.hoveredId,
    center: s.center ? Object.freeze({ ...s.center }) : null,
    zoom: s.zoom,
    radiusKm: s.radiusKm,
    state: s.state
  })
}

/**
 * @param {object} [initial]
 * @returns {object} the store
 */
export function createMapState (initial = {}) {
  const state = {
    results: [],
    selectedId: null,
    hoveredId: null,
    center: initial.center || null,
    zoom: initial.zoom ?? 14,
    radiusKm: null,
    state: 'idle'
  }
  const subscribers = new Set()

  function notify () {
    const snap = freezeSnapshot(state)
    for (const fn of subscribers) fn(snap)
  }

  /** Replace the result set from a search envelope. Prunes a now-absent
   *  selection/hover so the two views can never point at a vanished item. */
  function setResults (envelope = {}) {
    state.results = Array.isArray(envelope.results) ? envelope.results.slice() : []
    state.radiusKm = envelope.radiusKm ?? state.radiusKm
    state.state = envelope.state || state.state
    const ids = new Set(state.results.map((r) => r.id))
    if (state.selectedId != null && !ids.has(state.selectedId)) state.selectedId = null
    if (state.hoveredId != null && !ids.has(state.hoveredId)) state.hoveredId = null
    notify()
  }

  /** Select by id — the SINGLE write both the list and the map call. Selecting
   *  a present item also recentres the map on it (map follows selection). */
  function select (id) {
    if (id != null && !state.results.some((r) => r.id === id)) return
    state.selectedId = id ?? null
    const sel = state.results.find((r) => r.id === state.selectedId)
    if (sel && sel.lat != null && sel.lon != null) {
      state.center = { lat: sel.lat, lon: sel.lon }
    }
    notify()
  }

  function hover (id) {
    if (id != null && !state.results.some((r) => r.id === id)) return
    state.hoveredId = id ?? null
    notify()
  }

  function setView (center, zoom) {
    if (center && center.lat != null && center.lon != null) {
      state.center = { lat: center.lat, lon: center.lon }
    }
    if (typeof zoom === 'number' && Number.isFinite(zoom)) state.zoom = zoom
    notify()
  }

  return {
    setResults,
    select,
    hover,
    setView,
    /** The current immutable snapshot — the one truth both views read. */
    snapshot: () => freezeSnapshot(state),
    /** The selected result object (not just its id), or null. */
    selected: () => state.results.find((r) => r.id === state.selectedId) || null,
    subscribe (fn) { subscribers.add(fn); return () => subscribers.delete(fn) }
  }
}
