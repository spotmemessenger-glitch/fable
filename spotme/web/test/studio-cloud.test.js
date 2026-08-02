/**
 * Creative Studio cloud AI — the client adapter's zero-egress dark state and
 * the /api/studio-ai endpoint SHELL. Everything runs offline against fakes;
 * no vendor key exists here and every asserted path answers before any
 * provider could be reached.
 *
 * The claims: (1) with the flag off the adapter rejects BEFORE fetch — zero
 * egress is observed, not assumed; (2) the endpoint answers 501 whenever the
 * server env flag is absent — the owner's D1 boundary is server-enforced;
 * (3) strict input caps; (4) the daily budget (D5) closes; (5) a provider
 * failure logs op + byte count, NEVER payload bytes.
 *
 *   node test/studio-cloud.test.js
 */
import { createHmac } from 'node:crypto'
import { createCloudClient } from '../src/lib/studio/studio-cloud.js'
import { resolveFlags } from '../src/lib/studio/flags.js'

process.env.JWT_ACCESS_SECRET = 'studio-test-secret'
delete process.env.STUDIO_AI_ENABLED

const {
  default: handler, validateStudioBody, providerFor, buildProviderRequest,
  normalizeProviderResponse, hitDailyBudget, resetDailyBudgets
} = await import('../api/studio-ai.js')
const { resetLimits } = await import('../api/_auth.js')

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

/* ------------------------------------------------------------- fixtures */

const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
function mint (sub = 'user_1') {
  const head = b64u({ alg: 'HS256', typ: 'JWT' })
  const body = b64u({ sub, exp: Math.floor(Date.now() / 1000) + 900 })
  const sig = createHmac('sha256', process.env.JWT_ACCESS_SECRET).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

function fakeRes () {
  const res = { headers: {}, code: 0, body: null, ended: false }
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v }
  res.removeHeader = (k) => { delete res.headers[k.toLowerCase()] }
  res.status = (n) => { res.code = n; return { json: (b) => { res.body = b }, end: () => { res.ended = true } } }
  return res
}

const IMG = `data:image/png;base64,${'A'.repeat(400)}`
const MASK = `data:image/png;base64,${'B'.repeat(80)}`
const post = (op, body, token = mint()) => ({
  method: 'POST',
  url: `/api/studio-ai?op=${op}`,
  headers: { authorization: `Bearer ${token}` },
  body
})

/* --------------------------------------------------- client: zero egress */

await checkAsync('DARK STATE: adapter rejects locally and fetch is NEVER called', async () => {
  let fetched = 0
  const client = createCloudClient({
    flags: resolveFlags({}),
    fetchImpl: async () => { fetched++; return { ok: true, json: async () => ({}) } }
  })
  const calls = [
    () => client.inpaint({ image: IMG, mask: MASK, w: 100, h: 100 }),
    () => client.styleTransfer({ image: IMG, styleId: 'sketch', w: 100, h: 100 }),
    () => client.stickerFromPhoto({ image: IMG, w: 100, h: 100 }),
    () => client.captionSuggest({ image: IMG, w: 100, h: 100 })
  ]
  for (const call of calls) {
    try {
      await call()
      return false
    } catch (e) {
      if (!/STUDIO_CLOUD_AI_ENABLED is off/.test(e.message)) return false
    }
  }
  return fetched === 0 && client.enabled() === false
})

/* A hand-built flag set: resolveFlags can never produce this while the
 * defaults ship dark, which is exactly why the test constructs it by hand. */
const LIT = Object.freeze({ ...resolveFlags({}), STUDIO_CLOUD_AI_ENABLED: true })

await checkAsync('lit adapter calls the right op route with auth headers', async () => {
  let seen = null
  const client = createCloudClient({
    flags: LIT,
    getAuthHeaders: async () => ({ authorization: 'Bearer tok', 'content-type': 'application/json' }),
    fetchImpl: async (url, init) => {
      seen = { url, init }
      return { ok: true, status: 200, json: async () => ({ image: 'data:image/png;base64,xx' }) }
    }
  })
  const out = await client.styleTransfer({ image: IMG, styleId: 'sketch', w: 64, h: 64 })
  return seen.url === '/api/studio-ai?op=style' &&
    seen.init.headers.authorization === 'Bearer tok' &&
    JSON.parse(seen.init.body).styleId === 'sketch' &&
    out.image.startsWith('data:image/png')
})

await checkAsync('adapter maps the server 501 to the owner-gate explanation', async () => {
  const client = createCloudClient({
    flags: LIT,
    fetchImpl: async () => ({ ok: false, status: 501, json: async () => ({ error: 'disabled', disabled: true }) })
  })
  try {
    await client.captionSuggest({ image: IMG, w: 32, h: 32 })
    return false
  } catch (e) {
    return /owner has not activated/.test(e.message)
  }
})

await checkAsync('adapter enforces caps before any fetch (oversize, bad dims)', async () => {
  let fetched = 0
  const client = createCloudClient({ flags: LIT, fetchImpl: async () => { fetched++ } })
  const huge = `data:image/png;base64,${'A'.repeat(8_100_000)}`
  const a = await client.inpaint({ image: huge, mask: MASK, w: 100, h: 100 }).then(() => false, (e) => /cap/.test(e.message))
  const b = await client.inpaint({ image: IMG, mask: MASK, w: 100, h: 9999 }).then(() => false, (e) => /dimensions/.test(e.message))
  return a && b && fetched === 0
})

/* ------------------------------------------------------- endpoint: gates */

await checkAsync('endpoint: unknown op is 400 before anything else', async () => {
  const res = fakeRes()
  await handler(post('mystery', {}), res)
  return res.code === 400
})

await checkAsync('endpoint: no credential is 401 — same bar as every vendor proxy', async () => {
  const res = fakeRes()
  await handler({ method: 'POST', url: '/api/studio-ai?op=caption', headers: {}, body: {} }, res)
  return res.code === 401
})

await checkAsync('THE OWNER GATE: env flag absent ⇒ 501 disabled, body untouched', async () => {
  resetLimits()
  const res = fakeRes()
  await handler(post('inpaint', { anything: 'at all' }), res)
  return res.code === 501 && res.body?.disabled === true
})

await checkAsync('with the env flag set, validation runs: missing image is 400', async () => {
  process.env.STUDIO_AI_ENABLED = '1'
  resetLimits()
  resetDailyBudgets()
  const res = fakeRes()
  await handler(post('caption', { w: 64, h: 64 }), res)
  return res.code === 400 && /image required/.test(res.body?.error)
})

await checkAsync('oversize image is refused by the cap', async () => {
  resetLimits()
  resetDailyBudgets()
  const res = fakeRes()
  await handler(post('caption', { image: `data:image/png;base64,${'A'.repeat(8_100_000)}`, w: 64, h: 64 }), res)
  return res.code === 400 && /size cap/.test(res.body?.error)
})

await checkAsync('bad dimensions are refused', async () => {
  resetLimits()
  resetDailyBudgets()
  const res = fakeRes()
  await handler(post('style', { image: IMG, styleId: 'sketch', w: 64, h: 99999 }), res)
  return res.code === 400 && /16\.\.4096/.test(res.body?.error)
})

await checkAsync('a non-allow-listed style id is refused', async () => {
  resetLimits()
  resetDailyBudgets()
  const res = fakeRes()
  await handler(post('style', { image: IMG, styleId: 'evil', w: 64, h: 64 }), res)
  return res.code === 400 && /styleId/.test(res.body?.error)
})

await checkAsync('D5: the daily budget closes and answers 429 with Retry-After', async () => {
  process.env.STUDIO_AI_DAILY_OPS = '2'
  resetLimits()
  resetDailyBudgets()
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ b64_json: 'eA==' }] }) })
  process.env.OPENAI_API_KEY = 'test-key-not-real'
  const r1 = fakeRes(); await handler(post('sticker', { image: IMG, w: 64, h: 64 }), r1)
  const r2 = fakeRes(); await handler(post('sticker', { image: IMG, w: 64, h: 64 }), r2)
  const r3 = fakeRes(); await handler(post('sticker', { image: IMG, w: 64, h: 64 }), r3)
  delete process.env.OPENAI_API_KEY
  delete process.env.STUDIO_AI_DAILY_OPS
  return r1.code === 200 && r2.code === 200 && r3.code === 429 && r3.headers['retry-after'] === '86400'
})

await checkAsync('NO BYTE LOGGING: a provider failure logs op + size, never payload', async () => {
  resetLimits()
  resetDailyBudgets()
  process.env.OPENAI_API_KEY = 'test-key-not-real'
  const marker = 'QQQQUNIQUEPAYLOADQQQQ'
  const image = `data:image/png;base64,${marker.repeat(4)}`
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'upstream detail', json: async () => ({}) })
  const logged = []
  const origError = console.error
  const origLog = console.log
  console.error = (...a) => logged.push(a.join(' '))
  console.log = (...a) => logged.push(a.join(' '))
  const res = fakeRes()
  try {
    await handler(post('sticker', { image, w: 64, h: 64 }), res)
  } finally {
    console.error = origError
    console.log = origLog
    delete process.env.OPENAI_API_KEY
  }
  const all = logged.join('\n')
  return res.code === 502 && !all.includes(marker) && /studio-ai sticker/.test(all) &&
    !JSON.stringify(res.body).includes('upstream detail')
})

/* ------------------------------------------------- provider construction */

check('providerFor: defaults per op, env override wins', () => {
  const env = { STUDIO_AI_PROVIDER_STYLE: 'azure-openai' }
  return providerFor('inpaint', {}) === 'openai' && providerFor('caption', {}) === 'gemini' &&
    providerFor('style', env) === 'azure-openai'
})

check('buildProviderRequest: openai inpaint is multipart with image AND mask', () => {
  const payload = validateStudioBody('inpaint', { image: IMG, mask: MASK, prompt: 'x', w: 64, h: 64 })
  const req = buildProviderRequest('inpaint', 'openai', payload, { OPENAI_API_KEY: 'k' })
  return req.multipart === true && req.url.includes('openai.com') &&
    req.fields.image?.b64?.length > 0 && req.fields.mask?.b64?.length > 0 &&
    req.headers.authorization === 'Bearer k'
})

check('buildProviderRequest: gemini caption carries inlineData and the lang', () => {
  const payload = validateStudioBody('caption', { image: IMG, lang: 'ta', w: 64, h: 64 })
  const req = buildProviderRequest('caption', 'gemini', payload, { GEMINI_API_KEY: 'k' })
  const text = req.body.contents[0].parts[1].text
  return req.headers['x-goog-api-key'] === 'k' &&
    req.body.contents[0].parts[0].inlineData.data.length > 0 && /"ta"/.test(text)
})

check('buildProviderRequest: a missing key throws rather than sending', () => {
  const payload = validateStudioBody('sticker', { image: IMG, w: 64, h: 64 })
  try {
    buildProviderRequest('sticker', 'openai', payload, {})
    return false
  } catch (e) {
    return /no openai key/.test(e.message)
  }
})

check('normalize: gemini caption JSON, openai b64_json, and no-image → 502 error', () => {
  const cap = normalizeProviderResponse('caption', 'gemini', {
    candidates: [{ content: { parts: [{ text: '{"captions":["a","b","c"]}' }] } }]
  })
  const img = normalizeProviderResponse('sticker', 'openai', { data: [{ b64_json: 'eA==' }] })
  let refused = false
  try {
    normalizeProviderResponse('sticker', 'openai', { data: [] })
  } catch (e) {
    refused = e.status === 502
  }
  return cap.captions.length === 3 && img.image.startsWith('data:image/png;base64,') && refused
})

check('the daily budget helper is exact at its boundary', () => {
  resetDailyBudgets()
  process.env.STUDIO_AI_DAILY_OPS = '1'
  const a = hitDailyBudget('u9')
  const b = hitDailyBudget('u9')
  delete process.env.STUDIO_AI_DAILY_OPS
  return a.allowed === true && b.allowed === false && b.limit === 1
})

delete process.env.STUDIO_AI_ENABLED

const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  studio cloud — adapter + endpoint shell')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
