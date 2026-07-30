/**
 * Proves the language proxy is no longer an open bar.
 *
 * The audited state, reproduced live on 2026-07-31: five concurrent POSTs to
 * /api/translate carrying `origin: https://evil.example.com` and no credential
 * were all answered 200, with `Access-Control-Allow-Origin: *` and no
 * `Retry-After`. One `?op=read` is a Claude completion; one `{target:"ta"}` is
 * a Gemini call, a Sarvam call and often a GPT-4o call. The URL is in the
 * public bundle.
 *
 * Everything here runs offline. No vendor key is set, and every assertion is
 * against a path that answers BEFORE any engine would be reached — so this
 * file can never bill anyone, and a regression that lets an unauthenticated
 * request through will fail here rather than on an invoice.
 */
import { createHmac } from 'node:crypto'

process.env.JWT_ACCESS_SECRET = 'test-secret-for-the-guard'

const { verifyAccessToken, applyCors, hitLimit, resetLimits, gateVendorProxy } =
  await import('../api/_auth.js')
const { default: handler } = await import('../api/translate.js')
const { default: voiceHandler } = await import('../api/voice.js')

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

/* ------------------------------------------------------------- fixtures */

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')

function mint (payload, { secret = process.env.JWT_ACCESS_SECRET, alg = 'HS256' } = {}) {
  const head = b64({ alg, typ: 'JWT' })
  const body = b64({ sub: 'user_1', exp: Math.floor(Date.now() / 1000) + 900, ...payload })
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

/** The slice of an Express/Vercel response these paths actually touch. */
function fakeRes () {
  const res = {
    headers: {}, code: 0, body: null, ended: false,
    get headersSent () { return this.code !== 0 || this.ended },
    setHeader (k, v) { this.headers[k.toLowerCase()] = v; return this },
    removeHeader (k) { delete this.headers[k.toLowerCase()]; return this },
    status (n) { this.code = n; return this },
    json (b) { this.body = b; return this },
    end () { this.ended = true; return this }
  }
  res.status = (n) => { res.code = n; return { json: (b) => { res.body = b }, end: () => { res.ended = true } } }
  return res
}

const post = (url, body, headers = {}) => ({ method: 'POST', url, headers, body })

/* ------------------------------------------------------- 1. token proof */

check('a well-formed token from the right secret is accepted', () =>
  verifyAccessToken(mint({}))?.sub === 'user_1')

check('a token signed with someone else\'s secret is rejected', () =>
  verifyAccessToken(mint({}, { secret: 'not-our-secret' })) === null)

check('THE FORGERY: alg:"none" is refused rather than trusted', () => {
  const head = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ sub: 'attacker' })).toString('base64url')
  return verifyAccessToken(`${head}.${body}.`) === null
})

check('a payload edited after signing is rejected', () => {
  const [head, , sig] = mint({}).split('.')
  const forged = b64({ sub: 'somebody-else', exp: Math.floor(Date.now() / 1000) + 900 })
  return verifyAccessToken(`${head}.${forged}.${sig}`) === null
})

check('an expired token is rejected', () =>
  verifyAccessToken(mint({ exp: Math.floor(Date.now() / 1000) - 1 })) === null)

check('a token with no subject is rejected', () => {
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ exp: Math.floor(Date.now() / 1000) + 900 })
  const sig = createHmac('sha256', process.env.JWT_ACCESS_SECRET).update(`${head}.${body}`).digest('base64url')
  return verifyAccessToken(`${head}.${body}.${sig}`) === null
})

check('garbage is rejected without throwing', () =>
  verifyAccessToken('') === null && verifyAccessToken('a.b.c') === null &&
  verifyAccessToken(null) === null && verifyAccessToken('not-a-jwt') === null)

/* --------------------------------------------------------- 2. the meter */

check('requests are allowed up to the limit and refused after it', () => {
  resetLimits()
  const allowed = []
  for (let i = 0; i < 4; i++) allowed.push(hitLimit('k', 3, 60_000).allowed)
  return JSON.stringify(allowed) === JSON.stringify([true, true, true, false])
})

check('a refusal carries a Retry-After the caller can obey', () => {
  resetLimits()
  hitLimit('k', 1, 60_000)
  const { allowed, retryAfter } = hitLimit('k', 1, 60_000)
  return allowed === false && retryAfter > 0 && retryAfter <= 60
})

check('the window reopens once it has passed', () => {
  resetLimits()
  const now = Date.now()
  hitLimit('k', 1, 1000, now)
  return hitLimit('k', 1, 1000, now + 500).allowed === false &&
         hitLimit('k', 1, 1000, now + 1500).allowed === true
})

check('one user burning their budget does not throttle another', () => {
  resetLimits()
  hitLimit('read:alice', 1, 60_000)
  return hitLimit('read:alice', 1, 60_000).allowed === false &&
         hitLimit('read:bob', 1, 60_000).allowed === true
})

/* ---------------------------------------------------------- 3. the CORS */

check('a known origin is reflected, never wildcarded', () => {
  const res = fakeRes()
  applyCors({ headers: { origin: 'https://spotme-messenger.vercel.app' } }, res)
  return res.headers['access-control-allow-origin'] === 'https://spotme-messenger.vercel.app'
})

check('THE AUDIT CASE: evil.example.com gets no allow-origin at all', () => {
  const res = fakeRes()
  applyCors({ headers: { origin: 'https://evil.example.com' } }, res)
  return res.headers['access-control-allow-origin'] === undefined
})

check('a wildcard set upstream by Nest is stripped for an unknown origin', () => {
  const res = fakeRes()
  res.setHeader('Access-Control-Allow-Origin', '*')   // NestFactory({cors:true})
  applyCors({ headers: { origin: 'https://evil.example.com' } }, res)
  return res.headers['access-control-allow-origin'] === undefined
})

check('the packaged Capacitor app can still call the proxy', () => {
  const res = fakeRes()
  applyCors({ headers: { origin: 'capacitor://localhost' } }, res)
  return res.headers['access-control-allow-origin'] === 'capacitor://localhost'
})

check('the Authorization header is allowed through preflight', () => {
  const res = fakeRes()
  applyCors({ headers: {} }, res)
  return /authorization/i.test(res.headers['access-control-allow-headers'] || '')
})

/* ----------------------------------------------------------- 4. the gate */

check('no credential means no vendor call', () => {
  resetLimits()
  const res = fakeRes()
  return gateVendorProxy(post('/api/translate', {}, {}), res) === null && res.code === 401
})

check('a forged bearer token means no vendor call', () => {
  resetLimits()
  const res = fakeRes()
  const req = post('/api/translate', {}, { authorization: `Bearer ${mint({}, { secret: 'wrong' })}` })
  return gateVendorProxy(req, res) === null && res.code === 401
})

check('a real token passes and identifies the caller', () => {
  resetLimits()
  const res = fakeRes()
  const req = post('/api/translate', {}, { authorization: `Bearer ${mint({})}` })
  return gateVendorProxy(req, res) === 'user_1' && res.code === 0
})

check('a signed-in caller is still metered', () => {
  resetLimits()
  const req = post('/api/translate', {}, { authorization: `Bearer ${mint({})}` })
  gateVendorProxy(req, fakeRes(), { op: 'read', limit: 1 })
  const res = fakeRes()
  return gateVendorProxy(req, res, { op: 'read', limit: 1 }) === null &&
         res.code === 429 && Number(res.headers['retry-after']) > 0
})

/* ------------------------------------- 5. the handler, end to end, offline */

await checkAsync('THE HOLE: an anonymous POST is refused before any engine runs', async () => {
  resetLimits()
  const res = fakeRes()
  await handler(post('/api/translate', { q: 'hello', target: 'ta' }, { origin: 'https://evil.example.com' }), res)
  return res.code === 401 && res.headers['access-control-allow-origin'] === undefined
})

await checkAsync('an anonymous ?op=read is refused too — that one is a Claude call', async () => {
  resetLimits()
  const res = fakeRes()
  await handler(post('/api/translate?op=read', { q: 'ne epadi iruka' }, {}), res)
  return res.code === 401
})

await checkAsync('preflight still works, with a real origin instead of *', async () => {
  const res = fakeRes()
  const req = { method: 'OPTIONS', url: '/api/translate', headers: { origin: 'http://localhost:5173' }, body: null }
  await handler(req, res)
  return res.ended === true && res.headers['access-control-allow-origin'] === 'http://localhost:5173'
})

await checkAsync('PROBE B7: source:"en&textType=html" is refused, not forwarded to Azure', async () => {
  resetLimits()
  const res = fakeRes()
  const req = post('/api/translate',
    { q: '<b>bold</b> hello', source: 'en&textType=html', target: 'fr' },
    { authorization: `Bearer ${mint({})}` })
  await handler(req, res)
  return res.code === 400 && res.body?.error === 'bad language code'
})

await checkAsync('PROBE B6: target:"fr&to=de" cannot multiply the bill', async () => {
  resetLimits()
  const res = fakeRes()
  const req = post('/api/translate', { q: 'hello', target: 'fr&to=de' },
    { authorization: `Bearer ${mint({})}` })
  await handler(req, res)
  return res.code === 400 && res.body?.error === 'bad language code'
})

await checkAsync('the codes the real client sends are all still accepted', async () => {
  // No vendor keys in this process, so a valid pair falls through the engines
  // and answers 502 "all engines failed" — which proves it got PAST validation.
  // Anything rejected by the allow-list would answer 400 instead.
  for (const [source, target] of [[null, 'ta'], ['en', 'ta'], ['ta-Latn', 'en'], ['pt-BR', 'fr'], [null, 'en']]) {
    resetLimits()
    const res = fakeRes()
    const req = post('/api/translate', { q: 'hello', source: source || undefined, target },
      { authorization: `Bearer ${mint({})}` })
    await handler(req, res)
    if (res.code === 400) return false
  }
  return true
})

/* ------------------------------------------- 6. /api/voice — same hole */

/* ELEVENLABS_API_KEY is unset in this process, so a call that gets PAST the
 * gate dies at elHeaders() with a 500. That is the discriminator: 401 means
 * refused at the door, 500 means it reached the vendor step. Neither spends. */

await checkAsync('THE HOLE: an anonymous ?op=stt is refused', async () => {
  resetLimits()
  const res = fakeRes()
  await voiceHandler(post('/api/voice?op=stt', { audio: 'data:audio/webm;base64,AAAA' },
    { origin: 'https://evil.example.com' }), res)
  return res.code === 401 && res.headers['access-control-allow-origin'] === undefined
})

await checkAsync('an anonymous ?op=clone is refused — that one creates a paid voice', async () => {
  resetLimits()
  const res = fakeRes()
  await voiceHandler(post('/api/voice?op=clone', { audio: 'data:audio/webm;base64,AAAA', name: 'x' }, {}), res)
  return res.code === 401
})

await checkAsync('a forged token cannot reach ElevenLabs either', async () => {
  resetLimits()
  const res = fakeRes()
  const req = post('/api/voice?op=tts', { text: 'hi', voiceId: 'abcdefgh12345678' },
    { authorization: `Bearer ${mint({}, { secret: 'wrong' })}` })
  await voiceHandler(req, res)
  return res.code === 401
})

await checkAsync('a real token gets through the gate to the vendor step', async () => {
  resetLimits()
  const res = fakeRes()
  const req = post('/api/voice?op=tts', { text: 'hi', voiceId: 'abcdefgh12345678' },
    { authorization: `Bearer ${mint({})}` })
  await voiceHandler(req, res)
  return res.code !== 401 && res.code !== 429
})

await checkAsync('clone is metered far tighter than stt, because it burns voice slots', async () => {
  resetLimits()
  const req = (op, body) => post(`/api/voice?op=${op}`, body, { authorization: `Bearer ${mint({})}` })
  const clone = { audio: 'data:audio/webm;base64,AAAA', name: 'x' }
  let cloneLimited = 0
  for (let i = 0; i < 8; i++) {
    const res = fakeRes()
    await voiceHandler(req('clone', clone), res)
    if (res.code === 429) cloneLimited++
  }
  // stt shares neither the bucket nor the ceiling.
  const sttRes = fakeRes()
  await voiceHandler(req('stt', { audio: 'data:audio/webm;base64,AAAA' }), sttRes)
  return cloneLimited === 3 && sttRes.code !== 429
})

await checkAsync('an unknown op is rejected without costing anyone their budget', async () => {
  resetLimits()
  const res = fakeRes()
  await voiceHandler(post('/api/voice?op=nonsense', {}, {}), res)
  return res.code === 400
})

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  language proxy — auth, rate limit, CORS')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
