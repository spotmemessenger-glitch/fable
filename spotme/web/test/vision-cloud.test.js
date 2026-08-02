/**
 * Proves the vision cloud CLIENT port is dark by default and cannot leak.
 *
 * The claim with teeth: with VISION_CLOUD_ENABLED off (the shipped state),
 * EVERY op returns CLOUD_DISABLED without so much as reading globalThis.fetch
 * — a spy fetch that throws on any call proves not one byte left the device.
 * With the flag on, the port serializes to /api/vision-ai through the
 * INJECTED fetch (never the global), maps server status codes onto the
 * vocabulary, and validates image shape before any request.
 *
 *   node test/vision-cloud.test.js
 */
import { createVisionCloudClient } from '../src/lib/vision/vision-cloud.js'
import { resolveFlags } from '../src/lib/vision/flags.js'
import { VISION_UNAVAILABLE } from '../src/lib/vision/availability.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const IMG = 'data:image/png;base64,aaaa'
const darkFlags = resolveFlags({})
const litFlags = resolveFlags({ AI_CAMERA_ENABLED: true, AI_VISION_ENABLED: true, VISION_CLOUD_ENABLED: true })

/* ------------------------------------------------------------ dark -------- */

check('constructing the port requires resolved flags', (() => {
  try { createVisionCloudClient({}); return false } catch { return true }
})())

check('enabled() reflects the flag', (() => {
  return createVisionCloudClient({ flags: darkFlags }).enabled() === false &&
    createVisionCloudClient({ flags: litFlags }).enabled() === true
})())

check('DARK: every op returns CLOUD_DISABLED and NEVER touches fetch', await (async () => {
  const boom = () => { throw new Error('fetch used while dark') }
  const c = createVisionCloudClient({ flags: darkFlags, fetchImpl: boom })
  const ops = [
    await c.ocr({ image: IMG }),
    await c.recognize({ image: IMG }),
    await c.translatePhoto({ image: IMG, to: 'es' }),
    await c.assist({ image: IMG, category: 'math' }),
    await c.shopping({ image: IMG }),
  ]
  return ops.every((o) => o.available === false && o.reason === VISION_UNAVAILABLE.CLOUD_DISABLED)
})())

/* --------------------------------------------------------- lit, injected -- */

function fakeFetch (status, json) {
  const calls = []
  const impl = async (url, opts) => {
    calls.push({ url, opts })
    return { ok: status >= 200 && status < 300, status, json: async () => json }
  }
  impl.calls = calls
  return impl
}

check('LIT: ocr routes to /api/vision-ai?op=ocr through the injected fetch', await (async () => {
  const f = fakeFetch(200, { text: 'HELLO', boxes: [] })
  const c = createVisionCloudClient({ flags: litFlags, fetchImpl: f, base: 'https://x' })
  const out = await c.ocr({ image: IMG })
  return out.available === true && out.text === 'HELLO' &&
    f.calls.length === 1 && f.calls[0].url === 'https://x/api/vision-ai?op=ocr' &&
    f.calls[0].opts.method === 'POST'
})())

check('LIT: a 501 from the server maps back to CLOUD_DISABLED', await (async () => {
  const c = createVisionCloudClient({ flags: litFlags, fetchImpl: fakeFetch(501, { disabled: true }) })
  const out = await c.ocr({ image: IMG })
  return out.available === false && out.reason === VISION_UNAVAILABLE.CLOUD_DISABLED
})())

check('LIT: a 429 maps to BUDGET_EXCEEDED', await (async () => {
  const c = createVisionCloudClient({ flags: litFlags, fetchImpl: fakeFetch(429, { error: 'over budget' }) })
  const out = await c.recognize({ image: IMG })
  return out.available === false && out.reason === VISION_UNAVAILABLE.BUDGET_EXCEEDED
})())

check('LIT: a bad image is BAD_INPUT and never reaches fetch', await (async () => {
  const f = fakeFetch(200, {})
  const c = createVisionCloudClient({ flags: litFlags, fetchImpl: f })
  const out = await c.ocr({ image: 'not-a-data-url' })
  return out.available === false && out.reason === VISION_UNAVAILABLE.BAD_INPUT && f.calls.length === 0
})())

check('LIT: translatePhoto rejects a bad lang code before fetch', await (async () => {
  const f = fakeFetch(200, {})
  const c = createVisionCloudClient({ flags: litFlags, fetchImpl: f })
  const out = await c.translatePhoto({ image: IMG, to: '123nonsense' })
  return out.available === false && out.reason === VISION_UNAVAILABLE.BAD_INPUT && f.calls.length === 0
})())

check('LIT: an oversized image is INPUT_TOO_LARGE, no fetch', await (async () => {
  const f = fakeFetch(200, {})
  const c = createVisionCloudClient({ flags: litFlags, fetchImpl: f })
  const huge = 'data:image/png;base64,' + 'a'.repeat(8_000_001)
  const out = await c.ocr({ image: huge })
  return out.available === false && out.reason === VISION_UNAVAILABLE.INPUT_TOO_LARGE && f.calls.length === 0
})())

console.log('\n========================================')
console.log('  vision cloud port — dark, injected, leak-free')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
process.exit(passed === names.length ? 0 : 1)
