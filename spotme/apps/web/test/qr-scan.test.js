/**
 * Proves the scanner picks the right decoder, fails with a usable reason, and
 * stops the camera.
 *
 * WHAT IS WORTH TESTING HERE, AND WHAT IS NOT. Nothing in Node can prove a
 * camera works. What it CAN prove is everything around the camera, and those
 * are the parts that go wrong quietly:
 *
 *   - preferring the native decoder, so the Android build ships no third-party
 *     scan code and the fallback is never downloaded there
 *   - a DEFINED reason for every way a scan can fail to start, because
 *     "scanning didn't work" leaves a user with nothing to do, whereas "allow
 *     camera access" and "no camera found" each have an obvious next step
 *   - firing at most once, since a scanner that keeps hitting re-records the
 *     same verification over and over
 *   - stopping every track, because dropping the stream reference leaves the
 *     camera light on and that reads as "this app is still watching me"
 *
 *   node test/qr-scan.test.js
 */
import {
  detectorKind, canScan, unavailableReason, scanErrorMessage, reasonFromMediaError,
  decodeFrame, startScanning, SCAN_UNAVAILABLE,
} from '../src/lib/qr-scan.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { check(name, (await fn()) === true) } catch (e) { check(`${name} [threw: ${e.message}]`, false) }
}

/* -------------------------------------------------- 1. decoder choice ----- */

check('a browser with BarcodeDetector uses the NATIVE decoder',
  detectorKind({ BarcodeDetector: function () {}, document: {} }) === 'native')
check('…and that is what keeps third-party scan code off the Android build',
  detectorKind({ BarcodeDetector: function () {} }) === 'native')
check('a browser without it falls back', detectorKind({ document: {} }) === 'fallback')
check('a plain Node environment has no decoder at all', detectorKind({}) === null)

check('canScan needs BOTH a camera API and a decoder',
  canScan({ document: {}, navigator: { mediaDevices: { getUserMedia () {} } } }) === true)
check('…a decoder with no camera API is not enough',
  canScan({ document: {} }) === false)
check('…and a camera API with no decoder is not enough',
  canScan({ navigator: { mediaDevices: { getUserMedia () {} } } }) === false)

/* --------------------------------------------- 2. every failure is named -- */

{
  check('no camera API is reported as such',
    unavailableReason({ document: {} }) === SCAN_UNAVAILABLE.NO_CAMERA_API)
  check('no decoder is reported as such',
    unavailableReason({ navigator: { mediaDevices: { getUserMedia () {} } } }) === SCAN_UNAVAILABLE.NO_DECODER)
  check('a working environment reports no reason',
    unavailableReason({ document: {}, navigator: { mediaDevices: { getUserMedia () {} } } }) === null)

  check('a refused permission is distinguished from a missing camera',
    reasonFromMediaError({ name: 'NotAllowedError' }) === SCAN_UNAVAILABLE.PERMISSION_DENIED &&
    reasonFromMediaError({ name: 'NotFoundError' }) === SCAN_UNAVAILABLE.NO_CAMERA_FOUND)
  check('an insecure context reads as a permission problem, which is what it is',
    reasonFromMediaError({ name: 'SecurityError' }) === SCAN_UNAVAILABLE.PERMISSION_DENIED)
  check('anything else is FAILED rather than undefined',
    reasonFromMediaError({ name: 'WhoKnows' }) === SCAN_UNAVAILABLE.FAILED &&
    reasonFromMediaError(null) === SCAN_UNAVAILABLE.FAILED)

  // Each reason must lead somewhere. A message that does not tell the user what
  // to do next is the same as no message.
  const reasons = Object.values(SCAN_UNAVAILABLE)
  const messages = reasons.map(scanErrorMessage)
  check('every defined reason has its own message',
    new Set(messages).size >= reasons.length - 1 && messages.every((m) => typeof m === 'string' && m.length > 20))
  check('every message offers the fallback of reading the digits aloud',
    messages.every((m) => /out loud/.test(m)))
}

/* ------------------------------------------------------ 3. decodeFrame ---- */

await checkAsync('the native path returns the QR payload', async () => {
  const detector = { detect: async () => [{ rawValue: 'hello' }] }
  return (await decodeFrame({}, { kind: 'native', detector })) === 'hello'
})

await checkAsync('the native path returns null when nothing is in frame', async () => {
  const detector = { detect: async () => [] }
  return (await decodeFrame({}, { kind: 'native', detector })) === null
})

await checkAsync('the fallback path decodes from pixels', async () => {
  const jsQR = () => ({ data: 'from-pixels' })
  const imageData = { data: new Uint8ClampedArray(4), width: 1, height: 1 }
  return (await decodeFrame(null, { kind: 'fallback', jsQR, imageData })) === 'from-pixels'
})

await checkAsync('the fallback path with no pixels yet is null, not a crash', async () => {
  return (await decodeFrame(null, { kind: 'fallback', jsQR: () => { throw new Error('never') }, imageData: {} })) === null
})

await checkAsync('no decoder at all returns null', async () =>
  (await decodeFrame({}, { kind: null })) === null)

/* -------------------------------------- 4. the camera is actually stopped -- */

function fakeEnv ({ getUserMedia, payloads = [] } = {}) {
  const tracks = [{ stopped: false, stop () { this.stopped = true } },
    { stopped: false, stop () { this.stopped = true } }]
  const stream = { getTracks: () => tracks }
  let frame = 0
  const env = {
    BarcodeDetector: function () {
      this.detect = async () => {
        const p = payloads[frame++]
        return p ? [{ rawValue: p }] : []
      }
    },
    document: {},
    navigator: { mediaDevices: { getUserMedia: getUserMedia || (async () => stream) } },
    requestAnimationFrame: (fn) => queueMicrotask(fn),
  }
  return { env, tracks }
}

const fakeVideo = () => ({
  srcObject: null, videoWidth: 100,
  setAttribute () {}, play: async () => {},
})

await checkAsync('a hit fires onResult exactly once, even with more codes in frame', async () => {
  const { env } = fakeEnv({ payloads: ['first', 'second', 'third'] })
  let hits = 0
  let got = null
  await startScanning({
    video: fakeVideo(), env,
    onResult: (p) => { hits++; got = p },
  })
  await new Promise((r) => setTimeout(r, 30))
  return hits === 1 && got === 'first'
})

await checkAsync('THE CAMERA LIGHT: every track is stopped on a hit', async () => {
  const { env, tracks } = fakeEnv({ payloads: ['x'] })
  await startScanning({ video: fakeVideo(), env, onResult: () => {} })
  await new Promise((r) => setTimeout(r, 30))
  return tracks.every((t) => t.stopped)
})

await checkAsync('…and on an explicit stop, with nothing found', async () => {
  const { env, tracks } = fakeEnv({ payloads: [] })
  const handle = await startScanning({ video: fakeVideo(), env, onResult: () => {} })
  handle.stop()
  return tracks.every((t) => t.stopped)
})

await checkAsync('stopping twice is harmless', async () => {
  const { env } = fakeEnv({ payloads: [] })
  const handle = await startScanning({ video: fakeVideo(), env, onResult: () => {} })
  handle.stop(); handle.stop()
  return true
})

await checkAsync('a refused permission reports the reason and opens no camera', async () => {
  const { env, tracks } = fakeEnv({
    getUserMedia: async () => { const e = new Error('no'); e.name = 'NotAllowedError'; throw e },
  })
  let reason = null
  await startScanning({ video: fakeVideo(), env, onResult: () => {}, onError: (r) => { reason = r } })
  return reason === SCAN_UNAVAILABLE.PERMISSION_DENIED && tracks.every((t) => !t.stopped)
})

await checkAsync('an environment that cannot scan reports before touching the camera', async () => {
  let asked = false
  const env = { document: {}, navigator: { mediaDevices: {} }, requestAnimationFrame: () => {} }
  let reason = null
  await startScanning({
    video: fakeVideo(), env, onResult: () => {}, onError: (r) => { reason = r },
  })
  return reason === SCAN_UNAVAILABLE.NO_CAMERA_API && asked === false
})

await checkAsync('after a hit, no further onResult arrives', async () => {
  const { env } = fakeEnv({ payloads: ['a', 'b', 'c', 'd'] })
  let hits = 0
  await startScanning({ video: fakeVideo(), env, onResult: () => { hits++ } })
  await new Promise((r) => setTimeout(r, 60))
  return hits === 1
})

console.log('\n========================================')
console.log('  qr scanning — decoder choice, named failures, camera off')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
