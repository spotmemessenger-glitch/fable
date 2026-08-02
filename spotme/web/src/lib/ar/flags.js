/**
 * Spot Me — AR & beauty flags (mission CAM-3). THE flag root for lib/ar/.
 *
 * EVERYTHING HERE SHIPS FALSE. Same discipline as ../camera/flags.js, and
 * deliberately the same shape: no runtime override — no localStorage read,
 * no query param, no env sniff. A flag flips only in a reviewed wiring PR
 * that passes explicit values into `createArBeauty` (see
 * docs/ai-camera/ar-activation.md for the ordered flip plan).
 *
 * LAYERING. This module does not grow a second tree: its root
 * `AR_BEAUTY_ENABLED` PARENTS TO THE CAMERA PLATFORM MASTER
 * (`AI_CAMERA_ENABLED`, owned by ../camera/flags.js), exactly as that file's
 * header reserves for missions 2–4. So the whole AR/beauty module goes dark
 * when the platform master goes dark — one rollback lever for the entire
 * camera platform — and no AR leaf can light while the camera itself ships
 * dark. `BEAUTY_ADVANCED_ENABLED` additionally parents to `BEAUTY_ENABLED`:
 * the landmark-gated tier cannot exist without the base tier.
 */

import { DEFAULT_FLAGS as CAMERA_DEFAULT_FLAGS } from '../camera/flags.js'

/** Every AR flag, all false. The platform master is MIRRORED from the
 *  camera flag root (its shipped value is false there too) so one resolve
 *  walk covers the whole ancestry. Frozen so a typo'd write throws. */
export const AR_DEFAULT_FLAGS = Object.freeze({
  /** Platform master — OWNED by ../camera/flags.js; mirrored, never forked. */
  AI_CAMERA_ENABLED: CAMERA_DEFAULT_FLAGS.AI_CAMERA_ENABLED,
  /** This module's master (mission CAM-3). */
  AR_BEAUTY_ENABLED: false,
  /** Capability flags, each parented to the module master. */
  AR_FACE_TRACKING_ENABLED: false,
  AR_GESTURES_ENABLED: false,
  AR_MASKS_ENABLED: false,
  AR_WORLD_ENABLED: false,
  BEAUTY_ENABLED: false,
  /** Landmark-gated beauty tier — child of BEAUTY_ENABLED, not a sibling. */
  BEAUTY_ADVANCED_ENABLED: false,
})

/** Child → parent. The platform master has no parent here (it is the root
 *  of the camera tree; this module attaches below it). */
export const AR_FLAG_PARENT = Object.freeze({
  AR_BEAUTY_ENABLED: 'AI_CAMERA_ENABLED',
  AR_FACE_TRACKING_ENABLED: 'AR_BEAUTY_ENABLED',
  AR_GESTURES_ENABLED: 'AR_BEAUTY_ENABLED',
  AR_MASKS_ENABLED: 'AR_BEAUTY_ENABLED',
  AR_WORLD_ENABLED: 'AR_BEAUTY_ENABLED',
  BEAUTY_ENABLED: 'AR_BEAUTY_ENABLED',
  BEAUTY_ADVANCED_ENABLED: 'BEAUTY_ENABLED',
})

/**
 * Effective flags: raw value AND the whole parent chain, camera master
 * included. Unknown keys THROW — a wiring PR that misspells a flag must
 * fail its tests, not silently ship a feature dark (or worse, lit).
 */
export function resolveArFlags (overrides = {}) {
  for (const key of Object.keys(overrides)) {
    if (!(key in AR_DEFAULT_FLAGS)) throw new Error(`unknown ar flag: ${key}`)
    if (typeof overrides[key] !== 'boolean') throw new Error(`ar flag ${key} must be boolean`)
  }
  const raw = { ...AR_DEFAULT_FLAGS, ...overrides }
  const effective = {}
  for (const key of Object.keys(AR_DEFAULT_FLAGS)) {
    let on = raw[key]
    // Acyclic by construction (a literal object above), so this terminates.
    for (let parent = AR_FLAG_PARENT[key]; on && parent; parent = AR_FLAG_PARENT[parent]) {
      on = raw[parent]
    }
    effective[key] = on
  }
  return Object.freeze(effective)
}

/** The one question the factory asks before constructing anything: BOTH the
 *  platform master and this module's master, through the resolved chain. */
export function isArMasterEnabled (flags = AR_DEFAULT_FLAGS) {
  return flags.AI_CAMERA_ENABLED === true && flags.AR_BEAUTY_ENABLED === true
}

/** Throws unless every default is false. The ar-fence test runs this on
 *  every suite run, so shipped-dark is enforced by a failing build. */
export function assertArShippedDark (flags = AR_DEFAULT_FLAGS) {
  const lit = Object.keys(flags).filter((k) => flags[k] !== false)
  if (lit.length) {
    throw new Error(`ar/beauty module must ship dark; found non-false defaults: ${lit.join(', ')}`)
  }
  return true
}
