/**
 * Spot Me vision — the honesty vocabulary, inherited from the camera
 * engine (which inherited it from qr-scan.js): where this module cannot do
 * something, the API answers UNAVAILABLE with a machine-readable reason —
 * never a degraded imitation pretending to be the feature. A "document
 * scanner" that crops a centered rectangle when it found no page would
 * score well in a demo and mangle the first real receipt a user trusts it
 * with.
 *
 * Every capability answer in this module is one of:
 *
 *   { available: true, ...facts }                      — real, use it
 *   { available: false, reason, detail? }              — and here is WHY
 *
 * The set is vision's own (not the camera's) because the failures are
 * vision's own; the two vocabularies share only the spelling of
 * FLAG_DISABLED, which both fences assert against.
 */

export const VISION_UNAVAILABLE = Object.freeze({
  /** The governing flag (or an ancestor) is off. The dark-launch answer. */
  FLAG_DISABLED: 'FLAG_DISABLED',
  /** No decoder can read the requested barcode formats here: BarcodeDetector
   *  is absent/unsupporting and the jsQR fallback reads only qr_code. */
  NO_DETECTOR: 'NO_DETECTOR',
  /** The frame pump delivers GPU-side frames and no pixel-readback path
   *  (OffscreenCanvas / injected converter) exists to get bytes for a
   *  software decoder. */
  NO_PIXEL_ACCESS: 'NO_PIXEL_ACCESS',
  /** The document detector found no plausible page quad — honest refusal,
   *  never a guessed centre crop. `detail` says how close it got. */
  NO_QUAD_FOUND: 'NO_QUAD_FOUND',
  /** OCR needs a registered ITextRecognizer engine; none is registered.
   *  (tesseract.js is a named OWNER dependency decision — ADR-014b §5;
   *  cloud OCR is one op of the endpoint, behind VISION_CLOUD_ENABLED.) */
  NO_TEXT_RECOGNIZER: 'NO_TEXT_RECOGNIZER',
  /** Photo translation needs a registered ITranslator port adapter; none is
   *  registered. (The #51 translation-platform adapter is written at
   *  integration time — documented, not imported here.) */
  NO_TRANSLATOR: 'NO_TRANSLATOR',
  /** A cloud leg was asked for while VISION_CLOUD_ENABLED (or the server's
   *  own VISION_AI_ENABLED) is dark. The D1 boundary holding. */
  CLOUD_DISABLED: 'CLOUD_DISABLED',
  /** Input exceeds a stated cap (dimensions, bytes, page count, text). */
  INPUT_TOO_LARGE: 'INPUT_TOO_LARGE',
  /** Input is not a shape this API accepts; detail names the field. */
  BAD_INPUT: 'BAD_INPUT',
  /** The daily per-user budget for a cloud op is spent (server-metered). */
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  /** The assistant refused the request category (medical safety layer);
   *  detail carries the category and the user-facing message. */
  REFUSED: 'REFUSED',
  /** The operation was tried for real and failed; detail says how. */
  FAILED: 'FAILED',
})

/** An affirmative answer, with whatever facts ride along. */
export function available (facts = {}) {
  return Object.freeze({ available: true, ...facts })
}

/** A refusal with a reason. Unknown reasons throw — an unnamed refusal is
 *  a shrug, and shrugs are what this vocabulary exists to eliminate. */
export function unavailable (reason, detail) {
  if (!Object.prototype.hasOwnProperty.call(VISION_UNAVAILABLE, reason)) {
    throw new Error(`unknown vision unavailability reason: ${reason}`)
  }
  const out = { available: false, reason }
  if (detail !== undefined) out.detail = detail
  return Object.freeze(out)
}
