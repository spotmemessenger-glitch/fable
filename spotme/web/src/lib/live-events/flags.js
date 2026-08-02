/**
 * Live Nearby Events — layered compile-time feature flags.
 *
 * Same discipline as Discovery V2 (src/lib/discovery-v2/flags.js), a SEPARATE
 * gate because Live Nearby Events is its own flagship surface, not a Discovery
 * sub-feature. Everything is a plain module constant (NOT localStorage / URL /
 * env), all default false, so a production build with the master gate down
 * tree-shakes the whole subsystem out of dist — the fence test proves it.
 *
 * `MASTER` is the hard top gate: while false the engine is inert and every
 * sub-flag is ANDed to false (`resolveFlags`). No sub-flag can light a feature
 * on its own. Turning Live Nearby Events on is one deliberate edit to `MASTER`.
 *
 * While disabled there is ZERO provider or network activity: the engine that
 * `index.js` builds under the shipped config never constructs a search runner,
 * never holds a provider, never opens a socket.
 */

/**
 * @typedef {object} EventsFlags
 * @property {boolean} MASTER          master gate — false ⇒ engine inert
 * @property {boolean} discovery       adaptive-radius event discovery
 * @property {boolean} ranking         transparent time/distance ranking
 * @property {boolean} mapSync         event/map single-source-of-truth sync
 * @property {boolean} directions      place/map/directions linking
 * @property {boolean} detail          event detail state
 */

/** @type {Readonly<EventsFlags>} */
export const SHIPPED_FLAGS = Object.freeze({
  MASTER: false,
  discovery: false,
  ranking: false,
  mapSync: false,
  directions: false,
  detail: false
})

export const FEATURE_KEYS = Object.freeze(
  Object.keys(SHIPPED_FLAGS).filter((k) => k !== 'MASTER')
)

/**
 * Resolve an effective flag set — each feature ANDed with MASTER. Overrides are
 * for TESTS ONLY; the app calls with no argument and gets the shipped config.
 * @param {Partial<EventsFlags>} [overrides]
 * @returns {EventsFlags}
 */
export function resolveFlags (overrides = {}) {
  const merged = { ...SHIPPED_FLAGS, ...overrides }
  const master = merged.MASTER === true
  const out = { MASTER: master }
  for (const key of FEATURE_KEYS) out[key] = master && merged[key] === true
  return Object.freeze(out)
}

export function isFullyDark (flags = SHIPPED_FLAGS) {
  return !flags.MASTER && FEATURE_KEYS.every((k) => flags[k] !== true)
}

/**
 * Throw if a SHIPPED path is handed anything but a fully dark flag set.
 * @param {EventsFlags} [flags]
 * @throws {Error}
 */
export function assertShippedDark (flags = SHIPPED_FLAGS) {
  const lit = ['MASTER', ...FEATURE_KEYS].filter((k) => flags[k] === true)
  if (lit.length) {
    throw new Error(`Live Nearby Events must ship dark; enabled flags: ${lit.join(', ')}`)
  }
  return true
}
