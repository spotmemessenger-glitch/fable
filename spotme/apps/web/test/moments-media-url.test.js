/**
 * THE EMPTY-STORY BUG, PINNED.
 *
 * Symptom, on the deployed app only: posting a story produced a story with no
 * picture in it, and every photo and video in the feed rendered blank. The post
 * was created correctly; the media simply never appeared.
 *
 * Cause: the local storage adapter hands back a PATH — `/api/v2/media/local?…`
 * — and the client assigned it straight to `img.src` / `video.src`. That is
 * correct only when the app and the API share an origin. They do not: the app
 * is static on Vercel, the API is on Railway, and `vercel.json` carries no
 * `/api` rewrite, so the path resolved against the STATIC host, which serves no
 * media. Nothing failed loudly either — a SPA host answers those paths with
 * `index.html`, so the request "succeeded" and only the decode failed.
 *
 * It could not be reproduced in development, and that is the point: the Vite
 * dev server proxies `/api` to the backend, which makes the relative URL
 * correct there and only there.
 *
 * So the fence is behavioural, not a spelling check: drive the real
 * `assetUrl()` against a server answering exactly as the local adapter does,
 * and require an ABSOLUTE url pointed at the API. The S3 adapter's already
 * absolute presigned URL must come back untouched.
 *
 *   node --experimental-test-module-mocks test/moments-media-url.test.js
 */
import { mock } from 'node:test'

const SRC = new URL('../src/', import.meta.url).href

/* No `location` at all — module scope in api.js then resolves API_BASE to the
 * hosted backend, which is precisely the split-host shape under test. */
mock.module(`${SRC}lib/socket-transport.js`, {
  namedExports: { freshTokens: async () => ({ accessToken: 'test-token' }) }
})

const { API_BASE } = await import(`${SRC}lib/api.js`)
const M = await import(`${SRC}lib/moments-api.js`)

let pass = 0
let fail = 0
const check = (name, ok) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) } else { fail++; console.log(`  FAIL  ${name}`) }
}

/** Answer one `/media/:id/url` call with the given body. */
const serve = (body) => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    clone () { return this },
    async json () { return body },
    async text () { return JSON.stringify(body) }
  })
}

check('API_BASE is cross-origin in this shape — the deployed topology',
  typeof API_BASE === 'string' && /^https?:\/\//.test(API_BASE))

/* --- the local adapter's answer: a bare path ----------------------------- */
serve({
  url: '/api/v2/media/local?key=moments%2Fu1%2Fmm-1&expires=1&sig=abc&ct=video%2Fmp4',
  posterUrl: '/api/v2/media/local?key=moments%2Fu1%2Fmm-1p&expires=1&sig=def&ct=image%2Fjpeg',
  kind: 'video', mimeType: 'video/mp4', width: 720, height: 1280, durationSeconds: 6
})
const local = await M.assetUrl('mm-1')

check('a path-relative media url comes back ABSOLUTE — never assigned to src as a path',
  /^https?:\/\//.test(local.url))

check('…and it points at the API origin, not at whatever host the page is on',
  local.url.startsWith(`${API_BASE}/api/v2/media/local`))

check('the poster is absolutised too — a relative poster is the same bug, silently',
  local.posterUrl.startsWith(`${API_BASE}/api/v2/media/local`))

check('the query survives intact — key, expiry and signature are what authorise the GET',
  local.url.includes('key=moments%2Fu1%2Fmm-1') &&
  local.url.includes('sig=abc') &&
  local.url.includes('ct=video%2Fmp4'))

check('the rest of the asset bundle is passed through untouched',
  local.kind === 'video' && local.mimeType === 'video/mp4' &&
  local.width === 720 && local.height === 1280)

/* --- the S3 adapter's answer: already absolute, and NOT to our origin ----- */
const presigned = 'https://bucket.r2.cloudflarestorage.com/moments/u1/mm-2?X-Amz-Signature=zzz'
serve({ url: presigned, posterUrl: null, kind: 'image', mimeType: 'image/jpeg' })
const s3 = await M.assetUrl('mm-2')

check('an already-absolute presigned url is returned EXACTLY as given',
  s3.url === presigned)

check('a null poster stays null rather than becoming the API origin',
  s3.posterUrl === null)

console.log('\n========================================')
console.log(`  ${pass}/${pass + fail} passed`)
console.log('========================================\n')

if (fail) process.exit(1)
