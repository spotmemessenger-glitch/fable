/**
 * A4 — the Moments composer refuses a doomed upload BEFORE bytes leave,
 * with the real numbers in the message.
 *
 * MAX_UPLOAD_BYTES (50 MB) is enforced server-side after the whole upload
 * arrives. The composer's old client check refused correctly but wrote the
 * message below the fold; the shared precheck now runs first, with size AND
 * duration, and its message carries the actual size and the actual limit.
 * Server-side validation is unchanged — these checks never replace it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const SRC = new URL('../src/', import.meta.url).href
const { precheckAttachment, videoDuration } = await import(`${SRC}lib/media-precheck.js`)

const MOMENTS_CAP = 50 * 1024 * 1024
const fakeFile = (bytes, type, name = 'clip.mp4') => ({ size: bytes, type, name })

test('an oversize video is refused with BOTH real numbers, before any request', async () => {
  const r = await precheckAttachment(fakeFile(209.21 * 1048576, 'video/mp4'), {
    maxBytes: MOMENTS_CAP, label: 'a post'
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'too-large')
  assert.match(r.message, /209\.2 MB/)   // the file's actual size
  assert.match(r.message, /50\.0 MB/)    // the actual limit
  assert.match(r.message, /a post/)      // Moments wording, not chat wording
})

test('a video under the cap passes (duration unreadable degrades, never refuses)', async () => {
  // No DOM here, so videoDuration cannot measure — the check must degrade to
  // size-only rather than refusing what it could not read.
  const r = await precheckAttachment(fakeFile(39.9 * 1048576, 'video/mp4'), {
    maxBytes: MOMENTS_CAP, label: 'a post'
  })
  assert.equal(r.ok, true)
})

test('images are unaffected: a 12 MB photo passes the same gate', async () => {
  const r = await precheckAttachment(fakeFile(12 * 1048576, 'image/jpeg', 'photo.jpg'), {
    maxBytes: MOMENTS_CAP, label: 'a post'
  })
  assert.equal(r.ok, true)
})

test('an oversize IMAGE is refused too — the cap is the cap', async () => {
  const r = await precheckAttachment(fakeFile(51 * 1048576, 'image/jpeg', 'huge.jpg'), {
    maxBytes: MOMENTS_CAP, label: 'a post'
  })
  assert.equal(r.ok, false)
  assert.match(r.message, /51\.0 MB/)
})

test('an empty file names the iCloud failure mode instead of uploading zero bytes', async () => {
  const r = await precheckAttachment(fakeFile(0, 'video/mp4'), { maxBytes: MOMENTS_CAP, label: 'a post' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'empty')
})

test('videoDuration resolves null rather than hanging when nothing can decode', async () => {
  // document does not exist in this runtime; the helper must catch, not throw.
  const d = await videoDuration(fakeFile(1024, 'video/mp4'), 200)
  assert.equal(d, null)
})

test('the composer wires the precheck on BOTH paths: fresh pick and re-upload', async () => {
  // Structural: the view must gate the pick handler AND upload() itself, so a
  // photo that grew in the editor is re-validated before bytes leave.
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const src = readFileSync(fileURLToPath(new URL('../src/views/moments.js', import.meta.url)), 'utf8')
  const gateCalls = (src.match(/precheckAndReport/g) || []).length
  assert.ok(gateCalls >= 3, `expected the gate defined + called on pick + called in upload(); found ${gateCalls} references`)
  assert.match(src, /maxBytes: MAX_VIDEO_BYTES/)
})
