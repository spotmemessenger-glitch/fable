/**
 * Proves api/push.js signs a real, verifiable VAPID token.
 *
 * A fresh keypair is generated here rather than using the project's, so no
 * private key is written to disk or into the repo.
 */
import handler from '../api/push.js'

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const pair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const rawPub = await crypto.subtle.exportKey('raw', pair.publicKey)
const jwkPriv = await crypto.subtle.exportKey('jwk', pair.privateKey)

process.env.VAPID_PUBLIC_KEY = b64url(rawPub)
process.env.VAPID_PRIVATE_KEY = jwkPriv.d
process.env.VAPID_SUBJECT = 'mailto:test@example.com'
process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.local'
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token'

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123'
const pushCalls = []
const json = (body) => ({ ok: true, json: async () => body })

globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://fake-upstash.local')) {
    const cmd = JSON.parse(init.body)
    if (cmd[0] === 'GET') {
      return json({ result: JSON.stringify({ endpoint: ENDPOINT, ts: Date.now() }) })
    }
    return json({ result: 'OK' })
  }
  pushCalls.push({ url: String(url), headers: init.headers })
  return { ok: true, status: 201 }
}

function fakeRes () {
  const r = { code: 0, body: null, headers: {} }
  r.setHeader = (k, v) => { r.headers[k] = v }
  r.status = (c) => { r.code = c; return r }
  r.json = (b) => { r.body = b; return r }
  r.end = () => r
  return r
}

const results = {}
const check = (name, ok) => { results[name] = ok === true }

/* ------------------------------------------------------------------ GET */
let res = fakeRes()
await handler({ method: 'GET', body: null }, res)
check('config reports enabled when keys and store are present', res.body?.enabled === true)
check('config serves the public key, so rotation needs no rebuild',
  res.body?.publicKey === process.env.VAPID_PUBLIC_KEY)

/* ------------------------------------------------------------ subscribe */
res = fakeRes()
await handler({ method: 'POST', body: { action: 'subscribe', userId: 'abc123', subscription: { endpoint: ENDPOINT } } }, res)
check('a valid subscription is accepted', res.body?.ok === true)

res = fakeRes()
await handler({ method: 'POST', body: { action: 'subscribe', userId: 'abc123', subscription: { endpoint: 'https://evil.example.com/hook' } } }, res)
check('a non-push endpoint is refused (no open relay)', res.code === 400)

res = fakeRes()
await handler({ method: 'POST', body: { action: 'subscribe', userId: 'not a hex id!', subscription: { endpoint: ENDPOINT } } }, res)
check('a malformed user id is refused', res.code === 400)

/* --------------------------------------------------------------- notify */
res = fakeRes()
await handler({ method: 'POST', body: { action: 'notify', toUserId: 'abc123' } }, res)
check('notify reports the push was sent', res.body?.sent === true)
check('exactly one push was issued', pushCalls.length === 1)

const call = pushCalls[0]
check('the push went to the stored endpoint', call?.url === ENDPOINT)
check('the push carries no payload', call?.headers['Content-Length'] === '0')
check('the push declares a TTL', Number(call?.headers.TTL) > 0)

/* ------------------------------------------------- the crypto that matters */
const auth = call?.headers.Authorization || ''
const m = auth.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+),k=(.+)$/)
check('the Authorization header is a well-formed VAPID token', Boolean(m))

if (m) {
  const [, h, p, sig, k] = m
  check('the advertised key is our public key', k === process.env.VAPID_PUBLIC_KEY)
  const header = JSON.parse(Buffer.from(h, 'base64url'))
  const claims = JSON.parse(Buffer.from(p, 'base64url'))
  check('the token is ES256 as the spec requires', header.alg === 'ES256' && header.typ === 'JWT')
  check('the token is scoped to that push service only',
    claims.aud === 'https://fcm.googleapis.com')
  check('the token expires', claims.exp > Math.floor(Date.now() / 1000))
  check('the token expires within 24h, per the spec',
    claims.exp - Math.floor(Date.now() / 1000) <= 24 * 60 * 60)
  check('the token names a contact subject', String(claims.sub).startsWith('mailto:'))

  // The real test: does the signature verify against the public key?
  const verified = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey,
    Buffer.from(sig, 'base64url'), Buffer.from(`${h}.${p}`))
  check('THE SIGNATURE VERIFIES against the public key', verified)

  // And a tampered token must fail, or the check above proves nothing.
  const tampered = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey,
    Buffer.from(sig, 'base64url'), Buffer.from(`${h}.${p}x`))
  check('a tampered token fails verification', tampered === false)
}

/* ------------------------------------------------------------- throttle */
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://fake-upstash.local')) {
    const cmd = JSON.parse(init.body)
    // NX SET returns null when the key already exists — the rate limit biting.
    if (cmd[0] === 'SET' && cmd[1].startsWith('push:rate:')) return json({ result: null })
    return json({ result: null })
  }
  pushCalls.push({ url: String(url), headers: init.headers })
  return { ok: true, status: 201 }
}
res = fakeRes()
await handler({ method: 'POST', body: { action: 'notify', toUserId: 'abc123' } }, res)
check('a second poke inside the window is throttled', res.body?.reason === 'throttled')
check('the throttled poke sent no push', pushCalls.length === 1)

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  web push — server')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
