/**
 * Spot Me — AI Vision flags (mission CAM-2). Child tree of the AI Camera
 * platform root.
 *
 * EVERYTHING HERE SHIPS FALSE. Same posture as ../camera/flags.js, written
 * down as code: no runtime override, no localStorage read, no query param,
 * no env sniff. A flag flips only in a reviewed wiring PR that passes
 * explicit values into `createVision` (docs/ai-camera/vision-activation.md
 * has the ordered flip plan and the owner decisions each flip waits on).
 *
 * LAYERING. `AI_CAMERA_ENABLED` — imported from the camera module so the
 * platform master's shipped state has exactly ONE author — parents
 * `AI_VISION_ENABLED`, which parents every vision capability flag. Two
 * flags deserve their extra sentence:
 *
 *   VISION_CLOUD_ENABLED   parents EVERY provider leg. While it is false
 *                          no image, crop, or derived text can leave the
 *                          device from this module — the fence test proves
 *                          it with a throwing fetch. Flipping it is the D1
 *                          plaintext-boundary decision (images to cloud
 *                          providers) and belongs to the owner alone.
 *   VISION_MEDICAL_INFO_ENABLED
 *                          child of the ASSISTANT flag, not a sibling —
 *                          medical info must never light up without the
 *                          assistant safety layer under it, and it is
 *                          additionally owner-policy-gated (see
 *                          vision-activation.md).
 *
 * Turning the platform master off darkens camera AND vision in one move;
 * nothing here persists, so rollback needs no data migration.
 */

import { DEFAULT_FLAGS as CAMERA_DEFAULT_FLAGS } from '../camera/flags.js'

/** Every vision flag, all false. Frozen so a typo'd write throws in strict
 *  mode instead of minting a phantom flag. */
export const DEFAULT_FLAGS = Object.freeze({
  /** Platform master — owned by ../camera/flags.js; mirrored here so one
   *  resolve call answers the whole chain. Its default is IMPORTED, never
   *  restated, so the two modules cannot disagree about the shipped state. */
  AI_CAMERA_ENABLED: CAMERA_DEFAULT_FLAGS.AI_CAMERA_ENABLED,
  /** This module (mission CAM-2). */
  AI_VISION_ENABLED: false,
  /** Barcode/QR scanning over the camera FrameSource. */
  VISION_SCAN_ENABLED: false,
  /** Document capture: quad detection, rectification, enhancement, pages. */
  VISION_DOCSCAN_ENABLED: false,
  /** Text recognition seam (registry; engines are separate decisions). */
  VISION_OCR_ENABLED: false,
  /** Identify-what-you-see (plant/food/animal/landmark/product/coin). */
  VISION_RECOGNIZE_ENABLED: false,
  /** Photo translation: OCR → translator port → positioned overlay. */
  VISION_TRANSLATE_ENABLED: false,
  /** Solve/explain assistant legs (math, homework, essay, diagram). */
  VISION_ASSISTANT_ENABLED: false,
  /** Medical-info leg — child of ASSISTANT, additionally owner-policy-gated. */
  VISION_MEDICAL_INFO_ENABLED: false,
  /** Shopping/product-search leg. */
  VISION_SHOPPING_ENABLED: false,
  /** THE provider boundary: parents every cloud leg (D1, owner-gated). */
  VISION_CLOUD_ENABLED: false,
})

/** Child → parent. The platform master has no parent here (it is the root
 *  the camera module already owns). */
export const FLAG_PARENT = Object.freeze({
  AI_VISION_ENABLED: 'AI_CAMERA_ENABLED',
  VISION_SCAN_ENABLED: 'AI_VISION_ENABLED',
  VISION_DOCSCAN_ENABLED: 'AI_VISION_ENABLED',
  VISION_OCR_ENABLED: 'AI_VISION_ENABLED',
  VISION_RECOGNIZE_ENABLED: 'AI_VISION_ENABLED',
  VISION_TRANSLATE_ENABLED: 'AI_VISION_ENABLED',
  VISION_ASSISTANT_ENABLED: 'AI_VISION_ENABLED',
  VISION_MEDICAL_INFO_ENABLED: 'VISION_ASSISTANT_ENABLED',
  VISION_SHOPPING_ENABLED: 'AI_VISION_ENABLED',
  VISION_CLOUD_ENABLED: 'AI_VISION_ENABLED',
})

/**
 * Effective flags: raw value AND the whole parent chain — the same
 * resolution the camera module uses, over the vision tree.
 *
 * Unknown keys throw so a wiring PR that misspells a flag fails its tests
 * instead of silently shipping a feature dark (or worse, assuming it lit).
 * The return is frozen: effective flags are a snapshot, not a dial.
 */
export function resolveFlags (overrides = {}) {
  for (const key of Object.keys(overrides)) {
    if (!(key in DEFAULT_FLAGS)) throw new Error(`unknown vision flag: ${key}`)
    if (typeof overrides[key] !== 'boolean') throw new Error(`vision flag ${key} must be boolean`)
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
export function isVisionEnabled (flags = DEFAULT_FLAGS) {
  return flags.AI_CAMERA_ENABLED === true && flags.AI_VISION_ENABLED === true
}

/**
 * Throws unless every DEFAULT flag is false. The fence test runs this on
 * every suite run, so the shipped-dark promise is enforced by a failing
 * build rather than a sentence in a PR description.
 */
export function assertShippedDark (flags = DEFAULT_FLAGS) {
  const lit = Object.keys(flags).filter((k) => flags[k] !== false)
  if (lit.length) {
    throw new Error(`vision module must ship dark; found non-false defaults: ${lit.join(', ')}`)
  }
  return true
}
