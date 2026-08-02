/**
 * Spot Me vision — the on-device engine SEAMS: an ITextRecognizer registry
 * and an ITranslator slot. Both ship EMPTY.
 *
 * These are the same shape as the camera portrait segmenter registry: a slot
 * a wiring PR fills with an owner-approved engine, and until it is filled the
 * capability answers UNAVAILABLE with a machine-readable reason — never a
 * degraded imitation. OCR that "reads" a blank string, or a "translator"
 * that echoes the source, would demo well and lie to the first user who
 * trusts it, so an empty seam refuses instead.
 *
 *   OCR        needs an ITextRecognizer — tesseract.js on-device is a named
 *              OWNER dependency decision (ADR-014b §5); the cloud leg is one
 *              op of vision-cloud.js, behind VISION_CLOUD_ENABLED.
 *   translate  needs BOTH an ITextRecognizer (to read the text) AND an
 *              ITranslator port (the #51 translation platform's adapter,
 *              written at integration time — documented, not imported here).
 *
 * Nothing here reaches the network, persists, or constructs anything on
 * import: a registry is a closed-over local, minted only when the live
 * factory asks for one.
 */

import { VISION_UNAVAILABLE, available, unavailable } from './availability.js'

/* --------------------------------------------- ITextRecognizer (OCR) ----- */

/** Contract check for a text-recognition engine. Returns a problem string,
 *  or null when the engine is shaped correctly. */
export function validateTextRecognizer (engine) {
  if (!engine || typeof engine !== 'object') return 'recognizer must be an object'
  if (typeof engine.name !== 'string' || !engine.name) return 'recognizer.name required'
  if (typeof engine.recognize !== 'function') return 'recognizer.recognize(image, opts) required'
  return null
}

/**
 * A single-engine registry. `recognize` runs the engine and NORMALIZES only
 * the envelope — the engine owns the text/box extraction; this slot owns the
 * honesty (no engine ⇒ NO_TEXT_RECOGNIZER, a throwing engine ⇒ FAILED, never
 * a fabricated result).
 */
export function createTextRecognizerRegistry () {
  let current = null
  return {
    register (engine) {
      const problem = validateTextRecognizer(engine)
      if (problem) return unavailable(VISION_UNAVAILABLE.FAILED, problem)
      current = engine
      return available({ engine: engine.name })
    },
    unregister () {
      const had = current
      current = null
      return available({ released: Boolean(had) })
    },
    current: () => current,
    availability () {
      return current
        ? available({ engine: current.name })
        : unavailable(VISION_UNAVAILABLE.NO_TEXT_RECOGNIZER,
          'register an ITextRecognizer: tesseract.js on-device (owner dep, ADR-014b §5) or the cloud OCR leg')
    },
    async recognize (image, opts = {}) {
      if (!current) return this.availability()
      try {
        const out = await current.recognize(image, opts)
        // The engine may answer the vocabulary itself; pass a well-formed
        // refusal straight through, wrap a raw result, refuse anything else.
        if (out && out.available === false) return out
        if (out && typeof out === 'object' && 'text' in out) {
          return available({ text: String(out.text), boxes: Array.isArray(out.boxes) ? out.boxes : [], engine: current.name })
        }
        return unavailable(VISION_UNAVAILABLE.FAILED, 'recognizer returned no text field')
      } catch (e) {
        return unavailable(VISION_UNAVAILABLE.FAILED, `recognizer threw: ${e?.message || e}`)
      }
    },
  }
}

/* ------------------------------------------------ ITranslator (port) ----- */

/** Contract check for a translation port (the #51 platform's adapter). */
export function validateTranslator (port) {
  if (!port || typeof port !== 'object') return 'translator must be an object'
  if (typeof port.name !== 'string' || !port.name) return 'translator.name required'
  if (typeof port.translate !== 'function') return 'translator.translate(text, opts) required'
  return null
}

/** A single-port slot for photo translation. Answers NO_TRANSLATOR while
 *  empty; a filled slot never invents a translation on failure. */
export function createTranslatorSlot () {
  let current = null
  return {
    register (port) {
      const problem = validateTranslator(port)
      if (problem) return unavailable(VISION_UNAVAILABLE.FAILED, problem)
      current = port
      return available({ translator: port.name })
    },
    unregister () {
      const had = current
      current = null
      return available({ released: Boolean(had) })
    },
    current: () => current,
    availability () {
      return current
        ? available({ translator: current.name })
        : unavailable(VISION_UNAVAILABLE.NO_TRANSLATOR,
          'register an ITranslator port: the #51 translation platform adapter, wired at integration time')
    },
    async translate (text, opts = {}) {
      if (!current) return this.availability()
      try {
        const out = await current.translate(String(text), opts)
        if (out && out.available === false) return out
        if (out && typeof out === 'object' && 'text' in out) {
          return available({ text: String(out.text), from: out.from, to: out.to, translator: current.name })
        }
        return unavailable(VISION_UNAVAILABLE.FAILED, 'translator returned no text field')
      } catch (e) {
        return unavailable(VISION_UNAVAILABLE.FAILED, `translator threw: ${e?.message || e}`)
      }
    },
  }
}
