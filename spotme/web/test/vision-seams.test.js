/**
 * Proves the vision on-device seams (ITextRecognizer registry, ITranslator
 * slot) are honest empty slots: they refuse with a named reason until an
 * engine is registered, wrap a real engine's result, and NEVER fabricate a
 * recognition or a translation — the whole point of a seam over a fake.
 *
 *   node test/vision-seams.test.js
 */
import {
  createTextRecognizerRegistry, validateTextRecognizer,
  createTranslatorSlot, validateTranslator,
} from '../src/lib/vision/seams.js'
import { VISION_UNAVAILABLE } from '../src/lib/vision/availability.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

/* ------------------------------------------------ text recognizer -------- */

check('validateTextRecognizer rejects a shapeless engine',
  validateTextRecognizer(null) !== null &&
  validateTextRecognizer({ name: 'x' }) !== null &&
  validateTextRecognizer({ name: 'ocr', recognize: () => {} }) === null)

{
  const reg = createTextRecognizerRegistry()
  check('empty registry answers NO_TEXT_RECOGNIZER, not a blank string',
    reg.availability().reason === VISION_UNAVAILABLE.NO_TEXT_RECOGNIZER && reg.current() === null)

  const bad = reg.register({ name: '' })
  check('registering a malformed engine FAILS and leaves the slot empty',
    bad.available === false && bad.reason === VISION_UNAVAILABLE.FAILED && reg.current() === null)

  const ok = reg.register({ name: 'tesseract', recognize: async () => ({ text: 'HELLO', boxes: [{ x: 0, y: 0, w: 1, h: 1 }] }) })
  check('registering a valid engine succeeds and reports availability',
    ok.available === true && reg.availability().available === true && reg.current() !== null)
}

check('recognize() wraps a real engine result into the vocabulary', await (async () => {
  const reg = createTextRecognizerRegistry()
  reg.register({ name: 'ocr', recognize: async () => ({ text: 'RECEIPT', boxes: [] }) })
  const out = await reg.recognize({ w: 2, h: 2 })
  return out.available === true && out.text === 'RECEIPT' && out.engine === 'ocr'
})())

check('recognize() with no engine returns NO_TEXT_RECOGNIZER (no crash)', await (async () => {
  const reg = createTextRecognizerRegistry()
  const out = await reg.recognize({ w: 2, h: 2 })
  return out.available === false && out.reason === VISION_UNAVAILABLE.NO_TEXT_RECOGNIZER
})())

check('a throwing engine becomes FAILED, never a fabricated read', await (async () => {
  const reg = createTextRecognizerRegistry()
  reg.register({ name: 'boom', recognize: async () => { throw new Error('model died') } })
  const out = await reg.recognize({ w: 2, h: 2 })
  return out.available === false && out.reason === VISION_UNAVAILABLE.FAILED
})())

check('an engine returning no text field is FAILED, not silently empty', await (async () => {
  const reg = createTextRecognizerRegistry()
  reg.register({ name: 'weird', recognize: async () => ({ nope: 1 }) })
  const out = await reg.recognize({ w: 2, h: 2 })
  return out.available === false && out.reason === VISION_UNAVAILABLE.FAILED
})())

// Review-board MED-1: {text: undefined/null} must NOT become available with
// the string "undefined"/"null" — a malformed engine is FAILED, not a
// fabricated read. But a genuine empty read ('') is allowed.
check('{text: undefined} is FAILED, never a fabricated "undefined" string', await (async () => {
  const reg = createTextRecognizerRegistry()
  reg.register({ name: 'nully', recognize: async () => ({ text: undefined, boxes: [] }) })
  const out = await reg.recognize({ w: 2, h: 2 })
  return out.available === false && out.reason === VISION_UNAVAILABLE.FAILED
})())

check('{text: null} is FAILED too', await (async () => {
  const reg = createTextRecognizerRegistry()
  reg.register({ name: 'nully', recognize: async () => ({ text: null }) })
  const out = await reg.recognize({ w: 2, h: 2 })
  return out.available === false && out.reason === VISION_UNAVAILABLE.FAILED
})())

check('a genuine empty read ({text: ""}) IS available — an empty page is honest', await (async () => {
  const reg = createTextRecognizerRegistry()
  reg.register({ name: 'blankpage', recognize: async () => ({ text: '', boxes: [] }) })
  const out = await reg.recognize({ w: 2, h: 2 })
  return out.available === true && out.text === ''
})())

check('unregister frees the slot and returns to the honest refusal', (() => {
  const reg = createTextRecognizerRegistry()
  reg.register({ name: 'ocr', recognize: () => {} })
  const rel = reg.unregister()
  return rel.available === true && rel.released === true && reg.current() === null &&
    reg.availability().reason === VISION_UNAVAILABLE.NO_TEXT_RECOGNIZER
})())

/* ---------------------------------------------------- translator --------- */

check('validateTranslator rejects a shapeless port',
  validateTranslator(null) !== null &&
  validateTranslator({ name: 'p', translate: () => {} }) === null)

check('empty translator slot answers NO_TRANSLATOR', (() => {
  const slot = createTranslatorSlot()
  return slot.availability().reason === VISION_UNAVAILABLE.NO_TRANSLATOR
})())

check('a registered translator wraps its output', await (async () => {
  const slot = createTranslatorSlot()
  slot.register({ name: 'mt', translate: async () => ({ text: 'HOLA', from: 'en', to: 'es' }) })
  const out = await slot.translate('HELLO', { to: 'es' })
  return out.available === true && out.text === 'HOLA' && out.translator === 'mt'
})())

check('a throwing translator is FAILED, never an echoed source', await (async () => {
  const slot = createTranslatorSlot()
  slot.register({ name: 'mt', translate: async () => { throw new Error('down') } })
  const out = await slot.translate('HELLO', { to: 'es' })
  return out.available === false && out.reason === VISION_UNAVAILABLE.FAILED
})())

console.log('\n========================================')
console.log('  vision seams — honest empty slots, no fakes')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
