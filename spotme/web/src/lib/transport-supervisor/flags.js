/**
 * Spot Me — Adaptive Communication Network FLAGS. Priority 2D, ADR-012/012b.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY FLAG BELOW IS FALSE. The production layer in this directory is built
 * and tested, and NONE of it runs: with the master flag off, the factory in
 * network.js constructs nothing — no timers, no loops, no storage, no radio.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * LAYERED, NOT FLAT. A sub-system must never outlive the whole: if the master
 * `ADAPTIVE_NETWORK_ENABLED` is false, every sub-flag is EFFECTIVELY false no
 * matter what its constant says, and the same holds down the tree (multi-hop
 * cannot be on while the mesh is off; the mesh cannot be on while offline
 * messaging is off). `resolveFlags()` computes that closure and is the ONLY
 * thing production code reads — never the raw constants — so the layering is
 * a property of the code path, not a convention. adaptive-flags.test.js
 * asserts both the shipped values (all false) and the layering logic.
 *
 * CONSTANTS, NOT localStorage. Same stance as the scaffold barrel: a flag you
 * can flip from a console is not off. Turning any of these on is a code
 * change in a wiring/activation PR (see docs/adaptive-network/
 * activation-guide.md), which is also where the seal-lift gate is enforced —
 * BLE/LAN/mesh CHAT cannot activate before P1 delivers sealed frames above
 * the transport (ADR-008 §12; seal-boundary.js still throws).
 *
 * The scaffold-era `ADAPTIVE_TRANSPORT_ENABLED` (index.js) is unchanged and
 * also false; it remains the wiring switch the scaffold defined. Activation
 * flips BOTH — this file's master and that constant — deliberately: two
 * independent offs, one documented on-path.
 */

/** Master. False ⇒ the entire adaptive network is inert: `createAdaptiveNetwork`
 *  returns a stub and constructs no timers, loops, stores, or radios. */
export const ADAPTIVE_NETWORK_ENABLED = false

/** The supervisor engine (monitoring loop, health, ranking, event log). */
export const TRANSPORT_SUPERVISOR_ENABLED = false

/** Automatic transport switching (migration executor driven by the selector).
 *  Layered under the supervisor: switching without monitoring is blind. */
export const AUTO_TRANSPORT_ENABLED = false

/** Offline messaging: durable outbox, store-and-forward, drain-on-reconnect. */
export const OFFLINE_MESSAGING_ENABLED = false

/** Bluetooth mesh production layer (acks, reputation, duty cycling). Layered
 *  under offline messaging — a mesh with no store-and-forward loses frames. */
export const BLUETOOTH_MESH_ENABLED = false

/** Multi-hop forwarding across the mesh. Layered under the mesh itself. */
export const MULTIHOP_ENABLED = false

/** Local-network transport (WebRTC host-candidate path). */
export const LOCAL_NETWORK_ENABLED = false

/** The shipped values, as one object. Frozen — this is the record of what this
 *  build turns on, which is nothing. */
export const DEFAULT_FLAGS = Object.freeze({
  ADAPTIVE_NETWORK_ENABLED,
  TRANSPORT_SUPERVISOR_ENABLED,
  AUTO_TRANSPORT_ENABLED,
  OFFLINE_MESSAGING_ENABLED,
  BLUETOOTH_MESH_ENABLED,
  MULTIHOP_ENABLED,
  LOCAL_NETWORK_ENABLED
})

/** Every flag name, for iteration in tests and reports. */
export const FLAG_NAMES = Object.freeze(Object.keys(DEFAULT_FLAGS))

/**
 * The layering tree: child -> parent. A flag is EFFECTIVE only if it is true
 * AND its parent is effective; the master's parent is itself (root). This is
 * data, so the report/docs and the resolver cannot disagree.
 */
export const FLAG_PARENT = Object.freeze({
  ADAPTIVE_NETWORK_ENABLED: null,
  TRANSPORT_SUPERVISOR_ENABLED: 'ADAPTIVE_NETWORK_ENABLED',
  AUTO_TRANSPORT_ENABLED: 'TRANSPORT_SUPERVISOR_ENABLED',
  OFFLINE_MESSAGING_ENABLED: 'ADAPTIVE_NETWORK_ENABLED',
  BLUETOOTH_MESH_ENABLED: 'OFFLINE_MESSAGING_ENABLED',
  MULTIHOP_ENABLED: 'BLUETOOTH_MESH_ENABLED',
  LOCAL_NETWORK_ENABLED: 'ADAPTIVE_NETWORK_ENABLED'
})

/**
 * Compute the EFFECTIVE value of every flag from a raw flag object.
 *
 * Pure and total: unknown keys in `raw` are ignored, missing keys default to
 * the shipped constants (all false), and the result is frozen. Cycles cannot
 * occur because FLAG_PARENT is a static tree, but the walk is depth-capped
 * anyway so a future editing mistake fails loudly instead of hanging.
 */
export function resolveFlags (raw = DEFAULT_FLAGS) {
  const merged = { ...DEFAULT_FLAGS }
  for (const k of FLAG_NAMES) {
    if (raw && typeof raw[k] === 'boolean') merged[k] = raw[k]
  }
  const effective = {}
  const effectiveOf = (name, depth = 0) => {
    if (depth > FLAG_NAMES.length) throw new Error(`flags: parent chain too deep at "${name}" — FLAG_PARENT is no longer a tree`)
    if (name in effective) return effective[name]
    const parent = FLAG_PARENT[name]
    const own = merged[name] === true
    effective[name] = parent == null ? own : (own && effectiveOf(parent, depth + 1))
    return effective[name]
  }
  for (const k of FLAG_NAMES) effectiveOf(k)
  return Object.freeze(effective)
}

/** True iff the master is effectively on for `flags` (raw or resolved). */
export function isMasterEnabled (flags = DEFAULT_FLAGS) {
  return resolveFlags(flags).ADAPTIVE_NETWORK_ENABLED === true
}

/**
 * Assert the shipped configuration is fully OFF. Used by the fence test; kept
 * here so "the build ships dark" is an executable claim, not a review note.
 */
export function assertShippedDark () {
  for (const k of FLAG_NAMES) {
    if (DEFAULT_FLAGS[k] !== false) {
      throw new Error(`flags: ${k} is not false — the adaptive network must ship dark (ADR-012b)`)
    }
  }
  return true
}
