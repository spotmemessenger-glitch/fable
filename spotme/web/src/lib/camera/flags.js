/**
 * Spot Me — AI Camera platform flags. THE flag root for the whole platform.
 *
 * EVERYTHING HERE SHIPS FALSE. This module is the single place where the
 * camera platform's dark-launch posture is written down as code, and
 * `assertShippedDark()` is the tripwire the fence test runs so a flag cannot
 * drift to true in passing. There is deliberately NO runtime override — no
 * localStorage read, no query param, no env sniff. A flag flips only in a
 * reviewed wiring PR that passes explicit values into `createCameraEngine`
 * (see docs/ai-camera/activation-guide.md for the ordered flip plan).
 *
 * LAYERING. Flags form a parent chain: a child is EFFECTIVE only when its
 * whole ancestry is true. `AI_CAMERA_ENABLED` is the platform master that
 * missions 2–4 (AI vision, AR/beauty, creative studio) will also parent to;
 * `CAMERA_ENGINE_ENABLED` gates this module; each capability flag parents to
 * the engine. So flipping a leaf does nothing until every ancestor is
 * deliberately on, and turning the master off turns the entire platform off
 * in one move — that is the rollback lever, and it needs no data migration
 * because this module persists nothing.
 */

/** Every platform flag, all false. Frozen so a typo'd write throws in strict
 *  mode instead of minting a phantom flag. */
export const DEFAULT_FLAGS = Object.freeze({
  /** Platform master — missions 2–4 parent to this too. */
  AI_CAMERA_ENABLED: false,
  /** This module (mission CAM-1). */
  CAMERA_ENGINE_ENABLED: false,
  /** Capability flags, each parented to the engine flag. */
  CAMERA_HDR_ENABLED: false,
  CAMERA_NIGHT_ENABLED: false,
  CAMERA_PORTRAIT_ENABLED: false,
  CAMERA_BURST_ENABLED: false,
  CAMERA_VIDEO_ENABLED: false,
  CAMERA_SLOWMO_ENABLED: false,
  CAMERA_TIMELAPSE_ENABLED: false,
  CAMERA_STABILIZATION_ENABLED: false,
  CAMERA_PRO_CONTROLS_ENABLED: false,
})

/** Child → parent. The master has no parent. Missions 2–4 add their roots
 *  here (parented to AI_CAMERA_ENABLED) rather than growing a second tree. */
export const FLAG_PARENT = Object.freeze({
  CAMERA_ENGINE_ENABLED: 'AI_CAMERA_ENABLED',
  CAMERA_HDR_ENABLED: 'CAMERA_ENGINE_ENABLED',
  CAMERA_NIGHT_ENABLED: 'CAMERA_ENGINE_ENABLED',
  CAMERA_PORTRAIT_ENABLED: 'CAMERA_ENGINE_ENABLED',
  CAMERA_BURST_ENABLED: 'CAMERA_ENGINE_ENABLED',
  CAMERA_VIDEO_ENABLED: 'CAMERA_ENGINE_ENABLED',
  CAMERA_SLOWMO_ENABLED: 'CAMERA_ENGINE_ENABLED',
  CAMERA_TIMELAPSE_ENABLED: 'CAMERA_ENGINE_ENABLED',
  CAMERA_STABILIZATION_ENABLED: 'CAMERA_ENGINE_ENABLED',
  CAMERA_PRO_CONTROLS_ENABLED: 'CAMERA_ENGINE_ENABLED',
})

/**
 * Effective flags: raw value AND the whole parent chain.
 *
 * Unknown keys in `overrides` throw — a wiring PR that misspells a flag must
 * fail its tests, not silently ship a feature dark (or worse, assume it lit).
 * The return is frozen: effective flags are a snapshot, not a dial.
 */
export function resolveFlags (overrides = {}) {
  for (const key of Object.keys(overrides)) {
    if (!(key in DEFAULT_FLAGS)) throw new Error(`unknown camera flag: ${key}`)
    if (typeof overrides[key] !== 'boolean') throw new Error(`camera flag ${key} must be boolean`)
  }
  const raw = { ...DEFAULT_FLAGS, ...overrides }
  const effective = {}
  for (const key of Object.keys(DEFAULT_FLAGS)) {
    let on = raw[key]
    // Walk the ancestry; any dark ancestor darkens the child. The chain is
    // acyclic by construction (a literal object above), so this terminates.
    for (let parent = FLAG_PARENT[key]; on && parent; parent = FLAG_PARENT[parent]) {
      on = raw[parent]
    }
    effective[key] = on
  }
  return Object.freeze(effective)
}

/** The one question the factory asks before constructing anything. */
export function isMasterEnabled (flags = DEFAULT_FLAGS) {
  return flags.AI_CAMERA_ENABLED === true && flags.CAMERA_ENGINE_ENABLED === true
}

/**
 * Throws unless every DEFAULT flag is false. Run by the fence test on every
 * suite run, so the shipped-dark promise is enforced by a failing build
 * rather than a sentence in a PR description.
 */
export function assertShippedDark (flags = DEFAULT_FLAGS) {
  const lit = Object.keys(flags).filter((k) => flags[k] !== false)
  if (lit.length) {
    throw new Error(`camera platform must ship dark; found non-false defaults: ${lit.join(', ')}`)
  }
  return true
}
