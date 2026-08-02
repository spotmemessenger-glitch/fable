/**
 * Confidence taxonomy, the quality feedback loop, and the detection pipeline.
 *
 * Three skeletons the design calls first-class and the engine currently throws
 * away or leaves implicit:
 *   - confidence as a number, derived from the verification outcome (§6.1)
 *   - a rolling quality EWMA the router reads (§6.2) — the "missing piece"
 *   - the ordered detect pipeline whose guards must run BEFORE any model (§7)
 *
 * All pure. The one network step (provider detect) is injected, so this runs
 * offline; the wrong-script gate is the engine's own scriptOk, reused.
 *
 *   node test/translation-confidence-detect.test.js
 */
import {
  CONFIDENCE_BANDS, classifyConfidence, confidenceFor, VERIFICATION_BAND,
  updateQuality, sampleValue, createQualityStore, QUALITY_SEED, QUALITY_ALPHA, QUALITY_SAMPLE
} from '../src/lib/translation/confidence.js'
import {
  detectScript, hasIndicScript, englishGuard, runDetectionPipeline, scriptOk
} from '../src/lib/translation/detect.js'

const results = {}
const names = []
const check = (name, fn) => {
  names.push(name)
  try { results[name] = fn() === true } catch (e) { results[name] = false; results['  ' + name] = e.message }
}
const checkAsync = async (name, fn) => {
  names.push(name)
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results['  ' + name] = e.message }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps

/* ------------------------------------------------ 1. confidence taxonomy --- */

check('the bands are ordered high→low and cover [0,1] with no gap', () => {
  for (let i = 0; i < CONFIDENCE_BANDS.length - 1; i++) {
    // each band's floor is the next band's ceiling + a hair
    if (CONFIDENCE_BANDS[i].min <= CONFIDENCE_BANDS[i + 1].min) return false
  }
  return CONFIDENCE_BANDS[0].max === 1.00 && CONFIDENCE_BANDS[CONFIDENCE_BANDS.length - 1].min === 0.00
})

check('a numeric confidence classifies into the right band, boundaries included', () =>
  classifyConfidence(0.95) === 'confirmed' && classifyConfidence(0.90) === 'confirmed' &&
  classifyConfidence(0.89) === 'adjudicated' && classifyConfidence(0.70) === 'adjudicated' &&
  classifyConfidence(0.69) === 'single' && classifyConfidence(0.50) === 'single' &&
  classifyConfidence(0.49) === 'fallback' && classifyConfidence(0.30) === 'fallback' &&
  classifyConfidence(0.29) === 'degraded' && classifyConfidence(0) === 'degraded')

check('a non-numeric confidence is degraded, never a throw', () =>
  classifyConfidence(NaN) === 'degraded' && classifyConfidence(undefined) === 'degraded')

check('the verification outcome maps to a representative confidence', () =>
  confidenceFor('agree') === 0.95 && confidenceFor('adjudicated') === 0.78 &&
  confidenceFor('single') === 0.60 && confidenceFor('none') === 0.20)

check('the verification→band map covers exactly the engine outcomes', () =>
  Object.keys(VERIFICATION_BAND).sort().join(',') === 'adjudicated,agree,fallback,none,single')

/* ------------------------------------------------ 2. the quality EWMA ------ */

check('an agreement sample raises the score; a wrong-script sample lowers it', () => {
  const up = updateQuality(QUALITY_SEED, 'agree')     // 0.1*0.8 + 0.9*0.6 = 0.62
  const down = updateQuality(QUALITY_SEED, 'wrongScript') // 0.1*(-1) + 0.9*0.6 = 0.44
  return near(up, 0.62) && near(down, 0.44)
})

check('the score is always clamped into [0,1] even under a run of penalties', () => {
  let q = QUALITY_SEED
  for (let i = 0; i < 100; i++) q = updateQuality(q, 'wrongScript')
  let up = QUALITY_SEED
  for (let i = 0; i < 100; i++) up = updateQuality(up, 'adjudicationWin')
  return q >= 0 && q < 0.01 && up <= 1 && up > 0.99
})

check('sampleValue maps named signals and passes raw numbers through', () =>
  sampleValue('agree') === QUALITY_SAMPLE.agree && sampleValue('wrongScript') === -1.0 &&
  sampleValue(0.42) === 0.42 && sampleValue('unknown-signal') === 0)

check('the alpha and seed match the scorer and the design', () =>
  QUALITY_ALPHA === 0.1 && QUALITY_SEED === 0.6)

check('the quality store seeds unseen pairs and folds samples in', () => {
  const store = createQualityStore()
  const seeded = store.get('sarvam', 'ta|en')
  store.record('sarvam', 'ta|en', 'agree')
  const after = store.get('sarvam', 'ta|en')
  // an unrelated pair is untouched
  return seeded === QUALITY_SEED && after > seeded && store.get('sarvam', 'hi|en') === QUALITY_SEED
})

check('the store snapshot is aggregate scores only — no content', () => {
  const store = createQualityStore()
  store.record('gemini', 'ta|en', 'agree')
  const snap = store.snapshot()
  return typeof snap['gemini|ta|en'] === 'number' && Object.keys(snap).length === 1
})

/* ------------------------------------------------ 3. script detection ------ */

check('detectScript names the Indic block, Latin, or undetermined', () =>
  detectScript('வணக்கம்').script === 'Taml' &&
  detectScript('नमस्ते').script === 'Deva' &&
  detectScript('ಶೂನ್ಯ').script === 'Knda' &&
  detectScript('hello').script === 'Latn' &&
  detectScript('12345').script === 'Zyyy')

check('detectScript is not confident about input with no letters to judge', () =>
  detectScript('😂😂😂').confident === false && detectScript('வணக்கம்').confident === true)

check('hasIndicScript sees any Indic character and ignores Latin/emoji', () =>
  hasIndicScript('நான்') === true && hasIndicScript('hello') === false && hasIndicScript('😂') === false)

check('the wrong-script gate is the engine\'s own scriptOk, reused not copied', () =>
  // Same behaviour the guard test locks for api/translate.js.
  scriptOk('नल पॉइंटर अपवाद', 'kn') === false && scriptOk('ಶೂನ್ಯ ಸೂಚಕ', 'kn') === true &&
  scriptOk('😂😂😂', 'ta') === true)

/* ------------------------------------------------ 4. the ordered pipeline -- */

check('the English guard runs and is deterministic', () =>
  englishGuard('this is a normal english sentence') === true &&
  englishGuard('naan innaiku varen') === false &&
  englishGuard('en pondati') === false) // collides-with-Tamil tokens are excluded

await checkAsync('STEP 1 — obvious English stops the pipeline before any model', async () => {
  const d = await runDetectionPipeline('please send me the address now', { targetLang: 'ta' })
  return d.stage === 'english' && d.lang === 'en' && d.stop === true && d.needsProviderDetect === false
})

await checkAsync('STEP 3 — a non-Latin Indic script is decisive with NO detect call', async () => {
  let called = false
  const d = await runDetectionPipeline('நான் வருவேன்', { targetLang: 'en', providerDetect: async () => { called = true; return { language: 'x' } } })
  return d.stage === 'script' && d.script === 'Taml' && d.stop === true && called === false
})

await checkAsync('STEP 4 — romanized→English is the ONE ambiguous case that needs a detector', async () => {
  const noDetector = await runDetectionPipeline('naan varala', { targetLang: 'en' })
  // with no detector supplied, the pipeline reports it needs one rather than guessing
  return noDetector.stage === 'ambiguous' && noDetector.needsProviderDetect === true && noDetector.stop === false
})

await checkAsync('STEP 4 — a supplied detector resolves romanized Tamil and flags it', async () => {
  const d = await runDetectionPipeline('naan varala', {
    targetLang: 'en',
    providerDetect: async () => ({ language: 'ta-Latn', score: 0.87 })
  })
  return d.stage === 'provider' && d.lang === 'ta' && d.romanized === true && d.stop === true
})

await checkAsync('a declared non-English source or non-English target decides it with no network', async () => {
  let called = false
  const detect = async () => { called = true; return null }
  const declared = await runDetectionPipeline('varen', { targetLang: 'en', sourceLang: 'ta', providerDetect: detect })
  const targeted = await runDetectionPipeline('hello', { targetLang: 'ta', providerDetect: detect })
  return declared.stage === 'declared' && targeted.stage === 'target' && called === false
})

await checkAsync('emoji/digits-only has no language and never pays for a detect call', async () => {
  let called = false
  const d = await runDetectionPipeline('😂😂😂', { targetLang: 'en', providerDetect: async () => { called = true; return null } })
  return d.stage === 'no-language' && d.stop === true && called === false
})

/* --------------------------------------------------------------- report */
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  translation — confidence, quality, detection')
console.log('========================================')
for (const n of names) {
  console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
  if (!results[n] && results['  ' + n]) console.log(`        ${results['  ' + n]}`)
}
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
