/**
 * Discovery V2 — layered compile-time feature flags.
 *
 * WHY COMPILE-TIME AND NOT localStorage. A runtime toggle (a stored setting, a
 * URL param, a debug handle) means the dark code SHIPS in the bundle and is one
 * assignment away from running in the field. These flags are plain module
 * constants instead, so a production build with everything false lets the
 * bundler tree-shake the whole subsystem OUT of dist — the fence test
 * (discovery-v2-not-shipped.test.js) proves both facts: shipped-dark, and
 * stripped from the built assets.
 *
 * LAYERED. `MASTER` is the top gate: while it is false the engine is inert
 * regardless of any sub-flag, and every feature flag is additionally gated on
 * it (see `resolveFlags`). A sub-flag can never switch a feature on by itself —
 * turning Discovery V2 on is a single, deliberate edit to `MASTER`, in a change
 * whose whole subject is that authorisation.
 *
 * The default export `SHIPPED_FLAGS` is what the app would see: all false.
 * `resolveFlags(overrides)` exists for TESTS ONLY — it lets a suite exercise a
 * feature in isolation without ever touching the shipped constant.
 */

/**
 * The shipped configuration. Every value is false. This object is what ships;
 * `assertShippedDark` proves it, and the bundler drops the guarded code.
 * @typedef {object} DiscoveryFlags
 * @property {boolean} MASTER              master gate — false ⇒ engine inert
 * @property {boolean} adaptiveRadius      adaptive 10→100km radius expansion
 * @property {boolean} placeSearch         provider-neutral place search
 * @property {boolean} ranking             transparent deterministic ranking
 * @property {boolean} mapSync             map/result single-source-of-truth sync
 * @property {boolean} directions          directions (honest, no invented ETA)
 * @property {boolean} peopleDiscovery     privacy-safe people markers
 * @property {boolean} queryIntent         structured query-intent interface
 */

/** @type {Readonly<DiscoveryFlags>} */
export const SHIPPED_FLAGS = Object.freeze({
  MASTER: false,
  adaptiveRadius: false,
  placeSearch: false,
  ranking: false,
  mapSync: false,
  directions: false,
  peopleDiscovery: false,
  queryIntent: false
})

/** The sub-flag names (everything except the master gate). */
export const FEATURE_KEYS = Object.freeze(
  Object.keys(SHIPPED_FLAGS).filter((k) => k !== 'MASTER')
)

/**
 * Resolve an effective flag set. Every feature is ANDed with `MASTER`, so no
 * override can light up a feature while the master gate is down. Overrides are
 * for tests; the app calls this with no argument and gets the shipped config.
 *
 * @param {Partial<DiscoveryFlags>} [overrides]
 * @returns {DiscoveryFlags}
 */
export function resolveFlags (overrides = {}) {
  const merged = { ...SHIPPED_FLAGS, ...overrides }
  const master = merged.MASTER === true
  /** @type {DiscoveryFlags} */
  const out = { MASTER: master }
  for (const key of FEATURE_KEYS) {
    // Master gate is a hard AND: a feature is on only if MASTER is also on.
    out[key] = master && merged[key] === true
  }
  return Object.freeze(out)
}

/** True when no feature — and not the master gate — is enabled. */
export function isFullyDark (flags = SHIPPED_FLAGS) {
  return !flags.MASTER && FEATURE_KEYS.every((k) => flags[k] !== true)
}

/**
 * Guard used by the fence test and by any build-time assertion: throws if the
 * flags handed to a SHIPPED path are anything but fully dark. A statement in a
 * PR that "it's all off" cannot enforce itself; this can.
 *
 * @param {DiscoveryFlags} [flags]
 * @throws {Error} if any flag is enabled
 */
export function assertShippedDark (flags = SHIPPED_FLAGS) {
  const lit = ['MASTER', ...FEATURE_KEYS].filter((k) => flags[k] === true)
  if (lit.length) {
    throw new Error(`Discovery V2 must ship dark; enabled flags: ${lit.join(', ')}`)
  }
  return true
}
