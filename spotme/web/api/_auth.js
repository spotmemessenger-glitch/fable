/**
 * Spot Me — the gate in front of the paid language services.
 *
 * WHY THIS EXISTS
 * `/api/translate` was an open, unauthenticated, unthrottled LLM proxy with
 * `Access-Control-Allow-Origin: *`. Five concurrent POSTs carrying
 * `origin: https://evil.example.com` and no credentials were all answered 200
 * (security audit, 2026-07-31). One `?op=read` buys the caller a Claude
 * completion; one `{target:"ta"}` buys a Gemini call, a Sarvam call and, on
 * disagreement, a GPT-4o call. The endpoint URL ships inside the public web
 * bundle, so the whole internet could spend the owner's vendor credit and the
 * first signal would have been an invoice or a hard upstream 429 that takes
 * translation down for real users.
 *
 * WHY THE GUARD LIVES IN THE HANDLER AND NOT IN THE SERVER THAT MOUNTS IT
 * The same handler runs in two places: the NestJS bridge mounts it with
 * `express.all` (backend/src/main.ts), and Vercel builds it as a serverless
 * function (`.vercel/output/functions/api/translate.func` exists today). A
 * guard bolted onto either mount point leaves the other one wide open. Putting
 * it where every caller already routes through is both the smaller diff and
 * the only version that actually closes the hole.
 *
 * The underscore prefix keeps Vercel from turning this file into a route of
 * its own; @vercel/nft still traces it into the bundles that import it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/* The same secret the rest of the API verifies with — see
 * backend/src/auth/strategies/jwt.strategies.ts, whose dev fallback is
 * mirrored here deliberately. Diverging would mean a token the room socket
 * accepts and translation rejects, which reads to a user as "translation is
 * broken" rather than "you are signed out". If JWT_ACCESS_SECRET is unset in
 * production every guarded route in the product is equally weak; that is one
 * problem, not two. */
const secret = () => process.env.JWT_ACCESS_SECRET || 'dev-only-secret'

const b64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')

/**
 * Verify an HS256 access token and return its payload, or null.
 *
 * Deliberately not a JWT library: this handler is deployed as a standalone
 * serverless bundle with no dependencies of its own, and the verification a
 * symmetric token needs is a signature compare and an expiry check.
 *
 * `alg` is pinned to HS256 rather than read from the header. Trusting the
 * header is the classic JWT forgery: `alg:"none"` makes every token valid, and
 * `alg:"HS256"` against an RS256 deployment lets the public key be used as the
 * HMAC secret.
 */
export function verifyAccessToken (token, now = Date.now()) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return null
  const [head, body, sig] = parts
  let header
  try { header = JSON.parse(b64url(head).toString('utf8')) } catch { return null }
  if (header?.alg !== 'HS256') return null

  const expected = createHmac('sha256', secret()).update(`${head}.${body}`).digest()
  const actual = b64url(sig)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null

  let payload
  try { payload = JSON.parse(b64url(body).toString('utf8')) } catch { return null }
  if (!payload?.sub) return null
  if (typeof payload.exp === 'number' && now >= payload.exp * 1000) return null
  return payload
}

/* --------------------------------------------------------------- origins */

/** Where the app is actually served from. Anything else gets no ACAO header,
 *  which is what stops a page on another origin from reading the response.
 *  Capacitor's WebView reports its own scheme, so the packaged Android/iOS
 *  build needs those three entries or in-app translation dies silently. */
const KNOWN_ORIGINS = [
  'https://spotme-messenger.vercel.app',
  'http://localhost:5173', 'http://localhost:5174',
  'http://127.0.0.1:5173', 'http://127.0.0.1:5174',
  'capacitor://localhost', 'ionic://localhost',
  'http://localhost', 'https://localhost'
]

/** Extra origins for a preview deploy or a renamed host, without a code change. */
export function allowedOrigins () {
  const extra = String(process.env.SPOTME_ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
  return new Set([...KNOWN_ORIGINS, ...extra])
}

/**
 * Reflect the caller's origin only when we know it.
 *
 * `removeHeader` is not defensive clutter: NestFactory.create(AppModule,
 * {cors:true}) installs a CORS middleware that runs BEFORE these bridged
 * routes and sets `Access-Control-Allow-Origin: *`. Without stripping it, an
 * unknown origin would inherit the wildcard we are here to remove.
 */
export function applyCors (req, res) {
  const origin = req.headers?.origin
  if (origin && allowedOrigins().has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  } else {
    res.removeHeader?.('Access-Control-Allow-Origin')
  }
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization')
}

/* ----------------------------------------------------------- rate limits */

/* ponytail: fixed window in process memory. Correct on Railway, which runs one
 * long-lived process; on a multi-instance or serverless deploy each instance
 * counts separately, so the effective ceiling is limit x instances. Move the
 * counter to the Redis this backend already has (ioredis is a dependency) if
 * the proxy is ever scaled out. */
const buckets = globalThis.__spotmeRateBuckets || (globalThis.__spotmeRateBuckets = new Map())
const MAX_BUCKETS = 10_000

/**
 * Count one request against `key`. Returns { allowed, retryAfter } in seconds.
 * Exported bare so it can be tested without an HTTP round trip.
 */
export function hitLimit (key, limit, windowMs, now = Date.now()) {
  const bucket = buckets.get(key)
  if (!bucket || now >= bucket.resetAt) {
    // Sweep only when the map is actually large; the common path stays O(1).
    if (buckets.size > MAX_BUCKETS) {
      for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k)
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { allowed: true, retryAfter: 0 }
  }
  bucket.count += 1
  if (bucket.count > limit) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) }
  }
  return { allowed: true, retryAfter: 0 }
}

/** Test seam — the buckets are process-global by design. */
export function resetLimits () { buckets.clear() }

/* -------------------------------------------------------------- the gate */

/**
 * Authenticate and meter one request. Returns the caller's user id, or null
 * having already written the 401/429 — so a handler reads:
 *
 *     const userId = gateVendorProxy(req, res, { op, limit })
 *     if (!userId) return
 *
 * Failures are deliberately terse. A caller who is not signed in learns that
 * and nothing else about which vendors sit behind this URL.
 */
export function gateVendorProxy (req, res, { op = 'default', limit = 60, windowMs = 60_000 } = {}) {
  const header = req.headers?.authorization || ''
  const token = /^Bearer (.+)$/i.exec(header)?.[1]
  const payload = token ? verifyAccessToken(token) : null
  if (!payload) {
    res.status(401).json({ error: 'sign in required' })
    return null
  }
  const { allowed, retryAfter } = hitLimit(`${op}:${payload.sub}`, limit, windowMs)
  if (!allowed) {
    res.setHeader('Retry-After', String(retryAfter))
    res.status(429).json({ error: 'too many requests — slow down' })
    return null
  }
  return String(payload.sub)
}
