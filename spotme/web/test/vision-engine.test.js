/**
 * Proves the createVision factory: INERT by default with full shape parity,
 * per-capability gating once lit, real wiring for the on-device legs, and
 * the D1 cloud boundary held (recognize/assistant/shopping answer
 * CLOUD_DISABLED until VISION_CLOUD_ENABLED, medical held under its own flag).
 *
 *   node test/vision-engine.test.js
 */
import { createVision } from '../src/lib/vision/engine.js'
import { VISION_UNAVAILABLE } from '../src/lib/vision/availability.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const IMG = 'data:image/png;base64,aaaa'
const barcodeEnv = { BarcodeDetector: function () {} }
const allOn = {
  AI_CAMERA_ENABLED: true, AI_VISION_ENABLED: true,
  VISION_SCAN_ENABLED: true, VISION_OCR_ENABLED: true,
  VISION_RECOGNIZE_ENABLED: true, VISION_TRANSLATE_ENABLED: true,
  VISION_ASSISTANT_ENABLED: true, VISION_SHOPPING_ENABLED: true,
}

/* --------------------------------------------------------- inert stub ---- */

{
  const v = createVision({ flags: {}, env: { get BarcodeDetector () { throw new Error('probed while dark') } } })
  check('DEFAULT factory is inert: enabled false, no env read', v.enabled === false)

  check('every capability of the inert stub answers FLAG_DISABLED', await (async () => {
    const answers = [
      v.availability(),
      await v.scan.availability(), await v.scan.createReader(), v.scan.formats(),
      v.ocr.availability(), v.ocr.register({}), await v.ocr.recognize(IMG),
      v.translate.availability(), await v.translate.translate(IMG),
      v.recognize.availability(), await v.recognize.run(IMG),
      v.assistant.availability(), await v.assistant.ask(IMG),
      v.shopping.availability(), await v.shopping.search(IMG),
      await v.cloud.ocr({ image: IMG }),
    ]
    return answers.every((a) => a && a.available === false && a.reason === VISION_UNAVAILABLE.FLAG_DISABLED)
  })())
}

check('inert and live share the SAME method shape (no dark-stub parity gap)', (() => {
  const dark = createVision({ flags: {} })
  const live = createVision({ flags: allOn, env: barcodeEnv })
  const shape = (o) => Object.keys(o).filter((k) => typeof o[k] === 'object' && o[k] !== null)
    .map((ns) => `${ns}:${Object.keys(o[ns]).sort().join(',')}`).sort().join('|')
  return shape(dark) === shape(live)
})())

/* --------------------------------------------------- live, on-device ----- */

check('scan.availability is available when a BarcodeDetector exists', await (async () => {
  const v = createVision({ flags: allOn, env: barcodeEnv })
  const a = await v.scan.availability()
  return a.available === true && a.support.native.present === true
})())

/* --------------------------------------------------------- gating -------- */

check('a dark leaf under a lit master is FLAG_DISABLED (rollback wins)', await (async () => {
  const v = createVision({ flags: { ...allOn, VISION_SCAN_ENABLED: false }, env: barcodeEnv })
  const a = await v.scan.availability()
  return a.available === false && a.reason === VISION_UNAVAILABLE.FLAG_DISABLED
})())

/* --------------------------------------------------------- seams --------- */

check('ocr is NO_TEXT_RECOGNIZER until an engine is registered, then available', (() => {
  const v = createVision({ flags: allOn, env: barcodeEnv })
  const before = v.ocr.availability()
  v.ocr.register({ name: 'tesseract', recognize: async () => ({ text: 'x', boxes: [] }) })
  const after = v.ocr.availability()
  return before.reason === VISION_UNAVAILABLE.NO_TEXT_RECOGNIZER && after.available === true
})())

check('translate reports NO_TEXT_RECOGNIZER first (needs OCR before a translator)', (() => {
  const v = createVision({ flags: allOn, env: barcodeEnv })
  return v.translate.availability().reason === VISION_UNAVAILABLE.NO_TEXT_RECOGNIZER
})())

/* --------------------------------------------- D1 cloud boundary --------- */

check('recognize/assistant/shopping answer CLOUD_DISABLED while VISION_CLOUD is off', await (async () => {
  const v = createVision({ flags: allOn, env: barcodeEnv })
  const legs = [v.recognize.availability(), v.assistant.availability(), v.shopping.availability(),
    await v.recognize.run(IMG), await v.shopping.search(IMG)]
  return legs.every((a) => a.available === false && a.reason === VISION_UNAVAILABLE.CLOUD_DISABLED)
})())

check('with VISION_CLOUD on, cloud legs route through the injected fetch', await (async () => {
  const calls = []
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ labels: ['cat'] }) } }
  const v = createVision({ flags: { ...allOn, VISION_CLOUD_ENABLED: true }, env: barcodeEnv, fetchImpl })
  const out = await v.recognize.run(IMG)
  return out.available === true && calls.length === 1 && calls[0].includes('op=recognize')
})())

check('medical assist is REFUSED unless VISION_MEDICAL_INFO_ENABLED, even with cloud on', await (async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ answer: 'x' }) })
  const v = createVision({ flags: { ...allOn, VISION_CLOUD_ENABLED: true }, env: barcodeEnv, fetchImpl })
  const out = await v.assistant.ask(IMG, { category: 'medical' })
  return out.available === false && out.reason === VISION_UNAVAILABLE.REFUSED
})())

check('availability() map reports every capability with the right verdict', (() => {
  const v = createVision({ flags: allOn, env: barcodeEnv })
  const m = v.availability()
  return m.scan.available === true &&
    m.ocr.reason === VISION_UNAVAILABLE.NO_TEXT_RECOGNIZER &&
    m.recognize.reason === VISION_UNAVAILABLE.CLOUD_DISABLED
})())

// Review-board MED-2: the summary map must AGREE with the namespace methods.
// With cloud on and no local OCR/translator, the methods report available
// (via cloud); the map must not under-report them as unavailable.
check('availability() map agrees with the methods for cloud-backed ocr/translate', (() => {
  const v = createVision({ flags: { ...allOn, VISION_CLOUD_ENABLED: true }, env: barcodeEnv, fetchImpl: async () => ({}) })
  const m = v.availability()
  return m.ocr.available === v.ocr.availability().available &&
    m.translate.available === v.translate.availability().available &&
    m.ocr.available === true && m.translate.available === true
})())

console.log('\n========================================')
console.log('  vision engine — inert dark, gated live, D1 held')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
process.exit(passed === names.length ? 0 : 1)
