/**
 * Spot Me — reading a QR code off the camera.
 *
 * TWO DECODERS, AND THE NATIVE ONE IS PREFERRED. `BarcodeDetector` ships in
 * Chromium, which means it is present in the Android WebView this app is
 * packaged into — so on the primary target the scan path runs no third-party
 * code at all. `jsQR` (Apache-2.0, no dependencies) is the fallback for Safari
 * and Firefox on the web build, and is imported LAZILY so the browsers that
 * never need it never download it.
 *
 * WHY THIS IS ITS OWN MODULE. `views/verify.js` should not contain a camera
 * loop, a decoder feature-test and a frame pump; and more usefully, splitting
 * them means the decision logic can be tested on Node with no camera, no DOM
 * and no permissions prompt. The parts that genuinely need hardware are the
 * parts left in `startScanning`, and they are deliberately thin.
 *
 * NOTHING HAPPENS ON IMPORT. No permission is requested, no camera opened, no
 * module loaded — `detectorKind()` only feature-tests, and the fallback import
 * is inside the function that needs it.
 */

/** Why a scan cannot start. Defined rather than a bare false, because each one
 *  needs a different sentence in front of the user. */
export const SCAN_UNAVAILABLE = Object.freeze({
  NO_CAMERA_API: 'NO_CAMERA_API',
  NO_DECODER: 'NO_DECODER',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NO_CAMERA_FOUND: 'NO_CAMERA_FOUND',
  FAILED: 'FAILED',
})

/**
 * Which decoder this browser can use: 'native', 'fallback', or null.
 *
 * `env` is injectable so the choice is testable without pretending to be a
 * browser. Production passes nothing and reads globalThis.
 */
export function detectorKind (env = globalThis) {
  if (typeof env.BarcodeDetector === 'function') return 'native'
  // jsQR is pure JS and runs anywhere; the only requirement is a canvas to
  // pull pixels from, which is the same requirement the camera path has.
  if (typeof env.document !== 'undefined') return 'fallback'
  return null
}

/** Can a scan be attempted at all? Split from the reason so a caller can ask
 *  the cheap question first. */
export function canScan (env = globalThis) {
  return Boolean(env.navigator?.mediaDevices?.getUserMedia) && detectorKind(env) !== null
}

export function unavailableReason (env = globalThis) {
  if (!env.navigator?.mediaDevices?.getUserMedia) return SCAN_UNAVAILABLE.NO_CAMERA_API
  if (detectorKind(env) === null) return SCAN_UNAVAILABLE.NO_DECODER
  return null
}

/** What to tell the user when a scan cannot start. */
export function scanErrorMessage (reason) {
  switch (reason) {
    case SCAN_UNAVAILABLE.NO_CAMERA_API:
      return 'This browser will not give Spot Me a camera, so the code cannot be scanned here. Compare the digits out loud instead.'
    case SCAN_UNAVAILABLE.NO_DECODER:
      return 'This browser cannot read QR codes. Compare the digits out loud instead.'
    case SCAN_UNAVAILABLE.PERMISSION_DENIED:
      return 'Spot Me needs camera access to scan the code. You can allow it in your browser settings, or compare the digits out loud instead.'
    case SCAN_UNAVAILABLE.NO_CAMERA_FOUND:
      return 'No camera was found on this device. Compare the digits out loud instead.'
    default:
      return 'The camera could not be started. Compare the digits out loud instead.'
  }
}

/** getUserMedia's errors are named, not coded. Mapped so the message above can
 *  be specific rather than a shrug. */
export function reasonFromMediaError (err) {
  const name = err?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return SCAN_UNAVAILABLE.PERMISSION_DENIED
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return SCAN_UNAVAILABLE.NO_CAMERA_FOUND
  return SCAN_UNAVAILABLE.FAILED
}

/**
 * Decode one frame. Returns the payload string, or null.
 *
 * `deps` is injectable for the same reason as `env` above: the branch between
 * the two decoders is worth testing, and neither decoder is worth mocking
 * inside a browser to do it.
 */
export async function decodeFrame (source, deps = {}) {
  const kind = deps.kind || detectorKind()
  if (kind === 'native') {
    const Detector = deps.BarcodeDetector || globalThis.BarcodeDetector
    const detector = deps.detector || new Detector({ formats: ['qr_code'] })
    const found = await detector.detect(source)
    return found?.[0]?.rawValue || null
  }
  if (kind === 'fallback') {
    const { data, width, height } = deps.imageData || {}
    if (!data || !width || !height) return null
    // Lazily imported so the browsers with a native decoder never fetch it.
    const jsQR = deps.jsQR || (await import('jsqr')).default
    return jsQR(data, width, height)?.data || null
  }
  return null
}

/**
 * Run the camera until a code is read or the caller stops.
 *
 * Returns `{ stop }`. `onResult` fires at most once — a QR scanner that keeps
 * firing after a hit re-records the same verification repeatedly, and the
 * teardown below is what stops the camera light staying on afterwards.
 */
export async function startScanning ({ video, canvas, onResult, onError, env = globalThis }) {
  const blocked = unavailableReason(env)
  if (blocked) { onError?.(blocked); return { stop () {} } }

  let stream
  try {
    // `environment` is the rear camera on a phone, which is the one pointed at
    // someone else's screen.
    stream = await env.navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }, audio: false,
    })
  } catch (err) {
    onError?.(reasonFromMediaError(err))
    return { stop () {} }
  }

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    // Every track, explicitly. Dropping the reference alone leaves the camera
    // light on until GC decides otherwise, which reads to a user as "this app
    // is still watching me".
    for (const track of stream.getTracks()) { try { track.stop() } catch { /* already gone */ } }
    try { video.srcObject = null } catch { /* detached */ }
  }

  video.srcObject = stream
  video.setAttribute('playsinline', '')       // iOS: otherwise it goes fullscreen
  try { await video.play() } catch { /* autoplay refused; the loop still tries */ }

  const kind = detectorKind(env)
  const detector = kind === 'native' ? new env.BarcodeDetector({ formats: ['qr_code'] }) : null
  const ctx2d = kind === 'fallback' ? canvas?.getContext('2d', { willReadFrequently: true }) : null

  const tick = async () => {
    if (stopped) return
    try {
      let payload = null
      if (kind === 'native') {
        payload = await decodeFrame(video, { kind, detector })
      } else if (ctx2d && video.videoWidth) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height)
        const imageData = ctx2d.getImageData(0, 0, canvas.width, canvas.height)
        payload = await decodeFrame(null, { kind, imageData })
      }
      if (payload && !stopped) {
        stop()                                 // BEFORE the callback: fire once.
        onResult?.(payload)
        return
      }
    } catch { /* a bad frame is ordinary — keep looking */ }
    if (!stopped) env.requestAnimationFrame(tick)
  }
  env.requestAnimationFrame(tick)

  return { stop }
}
