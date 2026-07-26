/**
 * Spot Me — web push.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SENDS, AND WHAT IT DELIBERATELY DOES NOT
 *
 * A push here carries NO PAYLOAD AT ALL. Not the message, not the sender's
 * name — nothing. The phone is told only "open Spot Me, there is something for
 * you", and the message itself is fetched peer-to-peer once the app is up.
 *
 * That is a privacy decision first and a convenience second. A push payload
 * passes through Apple's or Google's push service, so anything put in one is
 * handed to them. The rest of this codebase refuses to let a server read
 * messages; it would be incoherent to mail the text to Google for the sake of
 * a nicer lock screen.
 *
 * It is also why this file needs no crypto library. A push WITH a payload must
 * be encrypted to the subscription's keys (ECDH + HKDF + AES-GCM); a push
 * without one needs only a signed VAPID token, which is a plain ES256 JWT and
 * a few lines of WebCrypto. No dependency, which matters because this project
 * deploys with no install step.
 *
 * WHAT THE SERVER LEARNS — stated plainly, because it is not nothing
 *
 * To route a push it must store which push endpoint belongs to which Spot Me
 * id, and it sees who is poking whom and when. That is metadata: contact graph
 * and timing, not content. Anyone who cannot accept that can leave
 * notifications off and lose nothing but the alert.
 *
 * ---------------------------------------------------------------------------
 * ROUTES  (one function, action in the body — one file, one deploy)
 *
 *   GET  /api/push                        -> { publicKey, enabled }
 *   POST /api/push {action:'subscribe', userId, subscription}
 *   POST /api/push {action:'unsubscribe', userId}
 *   POST /api/push {action:'notify', toUserId}   -> wake that device
 *
 * The public key is SERVED rather than baked into the bundle so rotating the
 * keypair does not require a rebuild — which matters the first time a private
 * key leaks and has to be replaced in a hurry.
 * ------------------------------------------------------------------------- */

const TTL_SECONDS = 24 * 60 * 60            // how long the push service may hold it
const JWT_LIFETIME_SECONDS = 12 * 60 * 60
const SUB_TTL_SECONDS = 90 * 24 * 60 * 60   // a device untouched for 90 days
const KEY_PREFIX = 'push:sub:'
/** Cheap ceiling on how often one device may be poked. */
const NOTIFY_WINDOW_SECONDS = 30

const b64urlToBytes = (s) =>
  Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')

const bytesToB64url = (bytes) => Buffer.from(bytes)
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const safeJson = (text) => { try { return JSON.parse(text) } catch { return null } }

/** Spot Me ids are hex from randomHex — anything else is not one. */
const isId = (value) => typeof value === 'string' && /^[a-f0-9]{4,64}$/i.test(value)

/**
 * Only real push services.
 *
 * Without this check the notify route is an open relay: any caller could have
 * this server POST to a URL of their choosing, with our IP and our signature.
 */
function isPushEndpoint (endpoint) {
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:') return false
    return /(^|\.)(googleapis\.com|mozilla\.com|windows\.com|apple\.com)$/.test(url.hostname)
  } catch { return false }
}

/* ------------------------------------------------------------------ upstash */

async function redis (command) {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command)
    })
    if (!response.ok) return null
    const json = await response.json().catch(() => null)
    return json?.result ?? null
  } catch { return null }
}

/* -------------------------------------------------------------------- vapid */

/**
 * Sign the VAPID token proving this server owns the advertised public key.
 *
 * Key generators hand out raw base64url values; WebCrypto wants a JWK, so the
 * uncompressed public point (0x04 ‖ x ‖ y) is split back into its coordinates.
 */
async function vapidHeader (endpoint) {
  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  const subject = process.env.VAPID_SUBJECT || 'mailto:spotmemessenger@gmail.com'
  if (!publicKey || !privateKey) return null

  const pub = b64urlToBytes(publicKey)
  if (pub.length !== 65 || pub[0] !== 4) return null

  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToB64url(pub.subarray(1, 33)),
    y: bytesToB64url(pub.subarray(33, 65)),
    d: bytesToB64url(b64urlToBytes(privateKey)),
    ext: true
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])

  const header = bytesToB64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = bytesToB64url(Buffer.from(JSON.stringify({
    // Scoped to the one push service this token is sent to, so a token
    // captured in transit cannot be replayed against a different provider.
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + JWT_LIFETIME_SECONDS,
    sub: subject
  })))
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(`${header}.${claims}`))

  return `vapid t=${header}.${claims}.${bytesToB64url(new Uint8Array(signature))},k=${publicKey}`
}

/* ------------------------------------------------------------------ handler */

export default async function handler (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'OPTIONS') { res.status(204).end(); return }

  const hasKeys = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)

  if (req.method === 'GET') {
    // Unconfigured must be a quiet no, not an error: the client then simply
    // never offers push, and every other feature carries on.
    res.status(200).json({
      publicKey: process.env.VAPID_PUBLIC_KEY || null,
      enabled: hasKeys && Boolean(process.env.UPSTASH_REDIS_REST_URL)
    })
    return
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return }

  const body = (typeof req.body === 'string' ? safeJson(req.body) : req.body) || {}

  if (body.action === 'subscribe') {
    const { userId, subscription } = body
    if (!isId(userId) || !isPushEndpoint(subscription?.endpoint || '')) {
      res.status(400).json({ error: 'bad subscription' })
      return
    }
    // Only the endpoint is kept. The p256dh/auth keys exist to encrypt a
    // payload, and there is never a payload — storing them would be hoarding
    // material for a capability this deliberately does not have.
    const stored = await redis(['SET', KEY_PREFIX + userId,
      JSON.stringify({ endpoint: subscription.endpoint, ts: Date.now() }),
      'EX', String(SUB_TTL_SECONDS)])
    res.status(stored === null ? 503 : 200).json({ ok: stored !== null })
    return
  }

  if (body.action === 'unsubscribe') {
    if (!isId(body.userId)) { res.status(400).json({ error: 'bad id' }); return }
    await redis(['DEL', KEY_PREFIX + body.userId])
    res.status(200).json({ ok: true })
    return
  }

  if (body.action === 'notify') {
    const target = body.toUserId
    if (!isId(target)) { res.status(400).json({ error: 'bad id' }); return }
    if (!hasKeys) { res.status(200).json({ sent: false, reason: 'not-configured' }); return }

    /* One poke per target per window. Without this, anyone who learns an id
     * could ring that phone continuously — the push service would throttle us
     * eventually, but the victim's battery goes first. */
    const fresh = await redis(['SET', `push:rate:${target}`, '1',
      'NX', 'EX', String(NOTIFY_WINDOW_SECONDS)])
    if (fresh === null) { res.status(200).json({ sent: false, reason: 'throttled' }); return }

    const raw = await redis(['GET', KEY_PREFIX + target])
    const record = typeof raw === 'string' ? safeJson(raw) : raw
    if (!record?.endpoint) { res.status(200).json({ sent: false, reason: 'no-subscription' }); return }

    const authorization = await vapidHeader(record.endpoint)
    if (!authorization) { res.status(500).json({ sent: false, reason: 'bad-keys' }); return }

    const pushed = await fetch(record.endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        TTL: String(TTL_SECONDS),
        Urgency: 'high',
        // No body at all — see the header. The length must still be declared.
        'Content-Length': '0'
      }
    }).catch(() => null)

    // 404/410 mean the browser threw the subscription away (uninstalled, or
    // permission revoked). Keeping it would retry a dead endpoint forever.
    if (pushed && (pushed.status === 404 || pushed.status === 410)) {
      await redis(['DEL', KEY_PREFIX + target])
      res.status(200).json({ sent: false, reason: 'expired' })
      return
    }
    res.status(200).json({ sent: Boolean(pushed?.ok), status: pushed?.status ?? 0 })
    return
  }

  res.status(400).json({ error: 'unknown action' })
}
