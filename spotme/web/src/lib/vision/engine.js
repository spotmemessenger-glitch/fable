/**
 * Spot Me — AI Vision engine factory: the single front door for mission
 * CAM-2, the sibling of createCameraEngine.
 *
 * `createVision()` with shipped defaults returns the INERT STUB — and inert
 * means CONSTRUCTS NOTHING: no scanner probe, no registry, no cloud client,
 * no property of `env` so much as read. Every method answers
 * UNAVAILABLE(FLAG_DISABLED), async where the live method is async, so a
 * caller written against the live shape runs unchanged against the dark one
 * (shape parity is a fence assertion — a missing dark method is a crash at a
 * call site the live path would have served).
 *
 * The LIVE engine exists only when a reviewed wiring PR passes the lit flag
 * chain (docs/ai-camera/vision-activation.md). What lights up splits sharply:
 *
 *   scan            ON-DEVICE, pure math + platform APIs. Finished, real,
 *                   tested — the one leg that carries no owner dependency.
 *   ocr, translate  SEAMS. A registry a wiring PR fills with an owner-
 *                   approved engine/port; empty ⇒ the honest refusal.
 *   recognize,      CLOUD legs, every one behind VISION_CLOUD_ENABLED — the
 *   assistant,      D1 plaintext-boundary decision that is the owner's
 *   shopping        alone. Dark ⇒ CLOUD_DISABLED, with zero egress.
 *
 * NOTE — docscan (VISION_DOCSCAN_ENABLED) is a RESERVED flag with no wired
 * capability yet: its foundation landed unreviewed and failing its own
 * golden tests, so it is held on branch wip/ai-vision-docscan-unreviewed
 * (ADR-014b §4) rather than shipped as a working leg. The factory does not
 * expose it — an unbuilt capability is absent here, never a fake.
 *
 * `availability()` merges flag state with capability truth, flag winning —
 * because rollback must win arguments with a registered engine or a capable
 * browser.
 */

import { resolveFlags, isVisionEnabled } from './flags.js'
import { VISION_UNAVAILABLE, available, unavailable } from './availability.js'
import { scannerSupport, createBarcodeReader, scanFrames, SCAN_FORMATS } from './scan.js'
import { createTextRecognizerRegistry, createTranslatorSlot } from './seams.js'
import { createVisionCloudClient } from './vision-cloud.js'

const FEATURE_FLAG = Object.freeze({
  scan: 'VISION_SCAN_ENABLED',
  ocr: 'VISION_OCR_ENABLED',
  recognize: 'VISION_RECOGNIZE_ENABLED',
  translate: 'VISION_TRANSLATE_ENABLED',
  assistant: 'VISION_ASSISTANT_ENABLED',
  shopping: 'VISION_SHOPPING_ENABLED',
})

export function createVision ({ flags = {}, env = null, clock = null, fetchImpl = null, getAuthHeaders = null, apiBase = '' } = {}) {
  const resolved = resolveFlags(flags)
  if (!isVisionEnabled(resolved)) return inertVision(resolved)
  return liveVision(resolved, env || globalThis, { clock, fetchImpl, getAuthHeaders, apiBase })
}

/* --------------------------------------------------------- the stub ------ */

function inertVision (resolved) {
  const name = 'AI_VISION_ENABLED'
  const dark = () => unavailable(VISION_UNAVAILABLE.FLAG_DISABLED, name)
  const darkSync = () => dark()
  const darkAsync = () => async () => dark()
  return Object.freeze({
    enabled: false,
    flags: resolved,
    availability: darkSync,
    scan: Object.freeze({
      availability: darkAsync(), support: darkAsync(), createReader: darkAsync(),
      scanFrames: darkSync, formats: darkSync,
    }),
    ocr: Object.freeze({
      availability: darkSync, register: darkSync, unregister: darkSync,
      recognize: darkAsync(), current: () => null,
    }),
    translate: Object.freeze({
      availability: darkSync, registerTranslator: darkSync, translate: darkAsync(),
    }),
    recognize: Object.freeze({ availability: darkSync, run: darkAsync() }),
    assistant: Object.freeze({ availability: darkSync, ask: darkAsync() }),
    shopping: Object.freeze({ availability: darkSync, search: darkAsync() }),
    cloud: Object.freeze({
      enabled: () => false, ocr: darkAsync(), recognize: darkAsync(),
      translatePhoto: darkAsync(), assist: darkAsync(), shopping: darkAsync(),
    }),
  })
}

/* -------------------------------------------------------- the engine ----- */

function liveVision (resolved, env, { clock, fetchImpl, getAuthHeaders, apiBase }) {
  const recognizers = createTextRecognizerRegistry()
  const translators = createTranslatorSlot()
  const cloud = createVisionCloudClient({ flags: resolved, fetchImpl, getAuthHeaders, base: apiBase })
  const cloudOn = () => resolved.VISION_CLOUD_ENABLED === true

  const gate = (feature) => (resolved[FEATURE_FLAG[feature]]
    ? null
    : unavailable(VISION_UNAVAILABLE.FLAG_DISABLED, FEATURE_FLAG[feature]))
  const gatedSync = (feature, fn) => (...args) => gate(feature) || fn(...args)
  const gatedAsync = (feature, fn) => async (...args) => gate(feature) || fn(...args)

  const engine = {
    enabled: true,
    flags: resolved,

    /** Per-feature map, flag state MERGED over capability truth. Cloud legs
     *  report CLOUD_DISABLED here whenever the D1 flag is dark. */
    availability () {
      const map = {}
      map.scan = resolved.VISION_SCAN_ENABLED ? available({}) : gate('scan')
      map.ocr = resolved.VISION_OCR_ENABLED ? recognizers.availability() : gate('ocr')
      map.translate = resolved.VISION_TRANSLATE_ENABLED ? translators.availability() : gate('translate')
      for (const f of ['recognize', 'assistant', 'shopping']) {
        map[f] = !resolved[FEATURE_FLAG[f]]
          ? gate(f)
          : (cloudOn() ? available({ via: 'cloud' }) : unavailable(VISION_UNAVAILABLE.CLOUD_DISABLED))
      }
      return Object.freeze(map)
    },

    scan: Object.freeze({
      availability: gatedAsync('scan', async () => {
        const support = await scannerSupport(env)
        const any = support.native.present || support.fallback.formats.length > 0
        return any ? available({ support }) : unavailable(VISION_UNAVAILABLE.NO_DETECTOR)
      }),
      support: gatedAsync('scan', () => scannerSupport(env)),
      createReader: gatedAsync('scan', (opts = {}) => createBarcodeReader({ env, ...opts })),
      scanFrames: gatedSync('scan', (source, reader, opts = {}) => scanFrames(source, reader, { env, clock, ...opts })),
      formats: gatedSync('scan', () => SCAN_FORMATS),
    }),

    ocr: Object.freeze({
      availability: gatedSync('ocr', () => {
        const local = recognizers.availability()
        if (local.available) return local
        return cloudOn() ? available({ engine: 'cloud' }) : local
      }),
      register: gatedSync('ocr', (engine) => recognizers.register(engine)),
      unregister: gatedSync('ocr', () => recognizers.unregister()),
      current: () => recognizers.current(),
      recognize: gatedAsync('ocr', (image, opts) => (recognizers.current()
        ? recognizers.recognize(image, opts)
        : (cloudOn() ? cloud.ocr({ image }, opts) : recognizers.availability()))),
    }),

    translate: Object.freeze({
      availability: gatedSync('translate', () => {
        if (cloudOn()) return available({ via: 'cloud' })
        const rec = recognizers.availability()
        return rec.available ? translators.availability() : rec
      }),
      registerTranslator: gatedSync('translate', (port) => translators.register(port)),
      translate: gatedAsync('translate', async (image, opts = {}) => {
        if (cloudOn()) return cloud.translatePhoto({ image, to: opts.to }, opts)
        if (!recognizers.current()) return recognizers.availability()
        const read = await recognizers.recognize(image, opts)
        if (!read.available) return read
        const out = await translators.translate(read.text, opts)
        if (!out.available) return out
        return available({ text: out.text, source: read.text, boxes: read.boxes, to: out.to })
      }),
    }),

    recognize: Object.freeze({
      availability: gatedSync('recognize', () => (cloudOn()
        ? available({ via: 'cloud' })
        : unavailable(VISION_UNAVAILABLE.CLOUD_DISABLED))),
      run: gatedAsync('recognize', (image, opts = {}) => cloud.recognize({ image, categories: opts.categories }, opts)),
    }),

    assistant: Object.freeze({
      availability: gatedSync('assistant', () => (cloudOn()
        ? available({ via: 'cloud', medical: resolved.VISION_MEDICAL_INFO_ENABLED })
        : unavailable(VISION_UNAVAILABLE.CLOUD_DISABLED))),
      ask: gatedAsync('assistant', (image, opts = {}) => {
        // Medical is a child flag under assistant: its own gate, above the
        // cloud gate, so the safety category cannot light without it.
        if (opts.category === 'medical' && !resolved.VISION_MEDICAL_INFO_ENABLED) {
          return unavailable(VISION_UNAVAILABLE.REFUSED, { category: 'medical', message: 'medical info is disabled' })
        }
        return cloud.assist({ image, category: opts.category, prompt: opts.prompt }, opts)
      }),
    }),

    shopping: Object.freeze({
      availability: gatedSync('shopping', () => (cloudOn()
        ? available({ via: 'cloud' })
        : unavailable(VISION_UNAVAILABLE.CLOUD_DISABLED))),
      search: gatedAsync('shopping', (image, opts) => cloud.shopping({ image }, opts)),
    }),

    cloud,
  }
  return Object.freeze(engine)
}
