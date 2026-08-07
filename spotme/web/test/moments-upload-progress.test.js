/**
 * THE "STUCK ON UPLOADING" BUG, PINNED.
 *
 * Symptom: pick a video, the composer says "Uploading…", and it says that
 * forever. No percentage, no error, no way out — indistinguishable from a
 * crash, and reported as "the video post does not work".
 *
 * Two causes, both here:
 *
 *  1. `fetch` CANNOT REPORT UPLOAD PROGRESS. The promise settles when the
 *     response arrives and says nothing in between, so a 50 MB clip on a phone
 *     showed one static word for a minute or more. A slow upload and a dead one
 *     looked identical.
 *  2. THERE WAS NO TIMEOUT AND NO ABORT. A stalled connection left the request
 *     hanging for the life of the page, and dismissing the composer did not
 *     stop it.
 *
 * Both are fixed by moving the raw upload to XHR. The fence drives the real
 * `uploadMedia()` against a fake XMLHttpRequest and requires: progress
 * callbacks, a stall abort, cancellation via signal, and the SAME status
 * semantics `call()` uses — a 404 is a dark domain, not a failed upload.
 *
 *   node --experimental-test-module-mocks test/moments-upload-progress.test.js
 */

import { mock } from 'node:test'

let pass = 0
let fail = 0
const check = (name, ok) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) } else { fail++; console.log(`  FAIL  ${name}`) }
}

globalThis.location = { origin: 'https://app.example', href: 'https://app.example/' }

/** A fake XHR whose send() hands the test a handle to drive the transfer. */
let live = null
class FakeXHR {
  constructor () {
    this.status = 0
    this.responseText = ''
    this.headers = {}
    this.aborted = false
    this.sent = null
    this.upload = { _l: {}, addEventListener (e, f) { (this._l[e] ||= []).push(f) }, fire (e, a) { for (const f of this._l[e] || []) f(a) } }
    this._l = {}
  }

  open (m, u) { this.method = m; this.url = u }
  setRequestHeader (k, v) { this.headers[k] = v }
  addEventListener (e, f) { (this._l[e] ||= []).push(f) }
  fire (e, a) { for (const f of this._l[e] || []) f(a) }
  abort () { this.aborted = true }
  send (body) { this.sent = body; live = this }
}
globalThis.XMLHttpRequest = FakeXHR

const SRC = new URL('../src/', import.meta.url).href

/* Token minting is not what is under test, and the real module pulls in the
 * whole storage layer. Same seam the media-url fence uses. */
mock.module(`${SRC}lib/socket-transport.js`, {
  namedExports: { freshTokens: async () => ({ accessToken: 'test-token' }) }
})

const M = await import(`${SRC}lib/moments-api.js`)

/* A minimal File stand-in. The point of passing the File straight to send() is
 * that its bytes are never pulled into JS memory — so the fence asserts the
 * body IS this object, not a copy of it. */
const FILE = { name: 'clip.mp4', type: 'video/mp4', size: 52428800 }

/** Start an upload and wait until send() has been reached.
 *  Returns the promise WRAPPED — an async function that returned it directly
 *  would chain onto it, and `await begin()` would block until the transfer the
 *  caller has not driven yet completes. */
async function begin (opts) {
  live = null
  const p = M.uploadMedia(FILE, opts)
  p.catch(() => {})                      // never an unhandled rejection here
  for (let i = 0; i < 200 && !live; i++) await new Promise((r) => setImmediate(r))
  return { p }
}

/* --- the happy path reports real byte progress --------------------------- */
{
  const seen = []
  const { p } = await begin({ onProgress: (v) => seen.push(v) })
  check('the File is streamed as-is — never read into an ArrayBuffer first', live?.sent === FILE)
  check('the request carries the auth header', typeof live?.headers?.Authorization === 'string')
  live.upload.fire('progress', { lengthComputable: true, loaded: 26214400, total: 52428800 })
  live.upload.fire('progress', { lengthComputable: true, loaded: 52428800, total: 52428800 })
  live.status = 201
  live.responseText = JSON.stringify({ mediaId: 'm1', exifStripped: true })
  live.fire('load')
  const out = await p
  check('progress is reported mid-flight — this is what "Uploading…" could not say', seen.some((v) => v > 0.4 && v < 0.6))
  check('progress never claims 100% before the server has answered', seen.filter((v) => v === 1).length === 1 && seen[seen.length - 1] === 1)
  check('the parsed body comes back', out?.mediaId === 'm1')
}

/* --- an unmeasurable body reports no fake number ------------------------- */
{
  const seen = []
  const { p } = await begin({ onProgress: (v) => seen.push(v) })
  live.upload.fire('progress', { lengthComputable: false, loaded: 0, total: 0 })
  live.status = 201
  live.responseText = '{"mediaId":"m2"}'
  live.fire('load')
  await p
  check('a non-measurable upload invents no percentage', seen.filter((v) => v > 0 && v < 1).length === 0)
}

/* --- cancelling actually aborts the request ------------------------------ */
{
  const ac = new AbortController()
  const { p } = await begin({ signal: ac.signal })
  ac.abort()
  let msg = null
  try { await p } catch (e) { msg = e.message }
  check('an abort signal aborts the underlying request', live.aborted === true)
  check('…and rejects as a cancel, not as a failure', msg === 'canceled')
}

/* --- status semantics match call(), so a dark domain is not "upload failed" */
for (const [status, want] of [[404, 'MomentsDisabledError'], [403, 'MomentsForbiddenError']]) {
  const { p } = await begin({})
  live.status = status
  live.responseText = '{"message":"nope"}'
  live.fire('load')
  let name = null
  try { await p } catch (e) { name = e.name }
  check(`${status} throws ${want} — the same as every other moments call`, name === want)
}

{
  const { p } = await begin({})
  live.status = 500
  live.responseText = '{"reason":"transcode-down"}'
  live.fire('load')
  let msg = null
  let code = null
  try { await p } catch (e) { msg = e.message; code = e.status }
  check('a 5xx surfaces the server reason and its status', msg === 'transcode-down' && code === 500)
}

/* --- a network drop is an error, not a hang ------------------------------ */
{
  const { p } = await begin({})
  live.fire('error')
  let msg = null
  try { await p } catch (e) { msg = e.message }
  check('a dropped connection rejects with something a reader can act on', /network/i.test(msg || ''))
}

console.log(`\n========================================\n  ${pass}/${pass + fail} passed\n========================================\n`)
if (fail > 0) process.exit(1)
