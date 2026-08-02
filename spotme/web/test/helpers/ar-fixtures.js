/**
 * AR/beauty test fixtures: canonical face poses (all 21 named landmarks),
 * MediaPipe-convention hand poses (21 points), recorded noisy tracking
 * sequences, fixture tracker engines, and synthetic images.
 *
 * The POSES are geometric, in units of face/hand size, so every classifier
 * threshold in lib/ar/gestures.js is pinned against explicit anthropometry
 * rather than against magic pixels. The RECORDED sequences are committed
 * data (plus a seeded generator for long runs) — determinism over realism,
 * with jitter amplitudes taken from what a FaceDetector actually does
 * (±2–3 px on a 100 px face).
 */

/* ------------------------------------------------------------ faces ------ */

/** All 21 canonical landmarks for a face of width `s` centred at (cx, cy)
 *  (nose level), y growing DOWN. Offsets are in units of s. */
function faceLandmarkOffsets () {
  return {
    leftEye: [-0.21, -0.20],
    rightEye: [0.21, -0.20],
    leftEyeInner: [-0.10, -0.20],
    leftEyeOuter: [-0.32, -0.20],
    leftEyeTop: [-0.21, -0.235],
    leftEyeBottom: [-0.21, -0.165],
    rightEyeInner: [0.10, -0.20],
    rightEyeOuter: [0.32, -0.20],
    rightEyeTop: [0.21, -0.235],
    rightEyeBottom: [0.21, -0.165],
    noseTip: [0, 0.02],
    mouthLeft: [-0.165, 0.28],
    mouthRight: [0.165, 0.28],
    upperLipTop: [0, 0.24],
    lowerLipBottom: [0, 0.33],
    chin: [0, 0.52],
    jawLeft: [-0.36, 0.32],
    jawRight: [0.36, 0.32],
    leftCheek: [-0.28, 0.10],
    rightCheek: [0.28, 0.10],
    foreheadCenter: [0, -0.42],
  }
}

/**
 * A face fixture: `{box, landmarks, conf}` in pixels.
 * kinds: 'neutral' | 'smile' | 'blink-both' | 'blink-left' | 'blink-right'
 *        | 'boxes-only' (landmarks stripped — the Shape-Detection reality)
 */
export function facePose (kind = 'neutral', { cx = 160, cy = 120, size = 100, conf = 0.9 } = {}) {
  const offsets = faceLandmarkOffsets()
  if (kind === 'smile') {
    // Corners widen (0.33s → 0.42s) and LIFT (y 0.28 → 0.245) — both
    // signals gestures.js requires, matching smile anthropometry.
    offsets.mouthLeft = [-0.21, 0.245]
    offsets.mouthRight = [0.21, 0.245]
  }
  const closeEye = (side) => {
    offsets[`${side}EyeTop`] = [offsets[`${side}EyeTop`][0], -0.205]
    offsets[`${side}EyeBottom`] = [offsets[`${side}EyeBottom`][0], -0.195]
  }
  if (kind === 'blink-both' || kind === 'blink-left') closeEye('left')
  if (kind === 'blink-both' || kind === 'blink-right') closeEye('right')

  const landmarks = {}
  for (const [name, [dx, dy]] of Object.entries(offsets)) {
    landmarks[name] = { x: cx + dx * size, y: cy + dy * size }
  }
  const face = {
    box: { x: cx - size / 2, y: cy - size * 0.62, width: size, height: size * 1.24 },
    conf,
  }
  if (kind !== 'boxes-only') face.landmarks = landmarks
  return face
}

/* ----------------------------------------------- recorded sequences ------ */

/** A RECORDED 14-frame single-face box track (100 px face drifting right
 *  with detector jitter, one dropout at frame 8). Committed data. */
export const RECORDED_BOX_SEQUENCE = [
  [{ x: 110, y: 58, width: 100, height: 124 }],
  [{ x: 113, y: 60, width: 98, height: 122 }],
  [{ x: 111, y: 57, width: 102, height: 126 }],
  [{ x: 116, y: 59, width: 99, height: 123 }],
  [{ x: 114, y: 61, width: 101, height: 125 }],
  [{ x: 119, y: 58, width: 100, height: 124 }],
  [{ x: 117, y: 60, width: 103, height: 121 }],
  [{ x: 122, y: 59, width: 98, height: 125 }],
  [],                                             // detector dropout
  [{ x: 124, y: 60, width: 101, height: 123 }],
  [{ x: 123, y: 58, width: 100, height: 126 }],
  [{ x: 127, y: 61, width: 99, height: 122 }],
  [{ x: 125, y: 59, width: 102, height: 124 }],
  [{ x: 129, y: 60, width: 100, height: 124 }],
]

/** Deterministic PRNG — same generator the camera bench uses. */
export function mulberry32 (seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A seeded noisy landmark-face sequence: one face drifting `driftPerFrame`
 * px/frame with uniform ±`jitter` px noise on box and every landmark.
 * Returns an array of frames, each `{faces: [face], ts}`.
 */
export function noisyFaceSequence ({ frames = 30, seed = 7, jitter = 2.5, driftPerFrame = 1.5, kind = 'neutral' } = {}) {
  const rand = mulberry32(seed)
  const noise = () => (rand() * 2 - 1) * jitter
  const out = []
  for (let f = 0; f < frames; f++) {
    const face = facePose(kind, { cx: 160 + f * driftPerFrame, cy: 120 })
    face.box = { x: face.box.x + noise(), y: face.box.y + noise(), width: face.box.width + noise(), height: face.box.height + noise() }
    if (face.landmarks) {
      for (const p of Object.values(face.landmarks)) { p.x += noise(); p.y += noise() }
    }
    out.push({ faces: [face], ts: f * 33 })
  }
  return out
}

/* ------------------------------------------------- fixture trackers ------ */

/** An IFaceTracker that replays scripted frames — the landmark-engine slot
 *  filled for tests (capabilities declare everything facePose emits). */
export function fixtureLandmarkTracker (script, { id = 'fixture-landmarks', clockStart = 0 } = {}) {
  let i = 0
  let ts = clockStart
  return {
    id,
    capabilities: { boxes: true, landmarks: Object.keys(faceLandmarkOffsets()) },
    async track () {
      const faces = script[Math.min(i, script.length - 1)] || []
      i++
      ts += 33
      return { faces: faces.map((f) => ({ ...f, box: { ...f.box } })), ts }
    },
  }
}

/** A boxes-only IFaceTracker (the Shape-Detection truth shape). */
export function fixtureBoxTracker (script, { id = 'fixture-boxes' } = {}) {
  let i = 0
  return {
    id,
    capabilities: { boxes: true, landmarks: null },
    async track () {
      const boxes = script[Math.min(i, script.length - 1)] || []
      i++
      return { faces: boxes.map((box) => ({ box: { ...box }, conf: null })), ts: i * 33 }
    },
  }
}

/** A fake platform FaceDetector environment (Chromium/Android-like). */
export function envWithFaceDetector (script, calls = []) {
  let i = 0
  class FakeFaceDetector {
    constructor (opts) { calls.push({ constructed: opts }) }
    async detect (frame) {
      calls.push({ detect: frame })
      const boxes = script[Math.min(i, script.length - 1)] || []
      i++
      return boxes.map((b) => ({ boundingBox: { x: b.x, y: b.y, width: b.width, height: b.height } }))
    }
  }
  return { FaceDetector: FakeFaceDetector }
}

/* ------------------------------------------------------------ hands ------ */

const HAND_POSES = {
  open: {
    wrist: [0.50, 0.90],
    thumbCmc: [0.38, 0.78], thumbMcp: [0.30, 0.68], thumbIp: [0.25, 0.60], thumbTip: [0.20, 0.52],
    indexMcp: [0.42, 0.52], indexPip: [0.40, 0.38], indexDip: [0.39, 0.30], indexTip: [0.38, 0.22],
    middleMcp: [0.50, 0.50], middlePip: [0.50, 0.35], middleDip: [0.50, 0.26], middleTip: [0.50, 0.17],
    ringMcp: [0.58, 0.52], ringPip: [0.60, 0.38], ringDip: [0.61, 0.30], ringTip: [0.62, 0.23],
    pinkyMcp: [0.66, 0.55], pinkyPip: [0.69, 0.44], pinkyDip: [0.70, 0.37], pinkyTip: [0.71, 0.30],
  },
  fist: {
    wrist: [0.50, 0.90],
    thumbCmc: [0.40, 0.78], thumbMcp: [0.36, 0.70], thumbIp: [0.38, 0.64], thumbTip: [0.42, 0.62],
    indexMcp: [0.42, 0.52], indexPip: [0.42, 0.44], indexDip: [0.43, 0.52], indexTip: [0.43, 0.58],
    middleMcp: [0.50, 0.50], middlePip: [0.50, 0.42], middleDip: [0.50, 0.50], middleTip: [0.50, 0.57],
    ringMcp: [0.58, 0.52], ringPip: [0.58, 0.44], ringDip: [0.57, 0.52], ringTip: [0.57, 0.58],
    pinkyMcp: [0.66, 0.55], pinkyPip: [0.66, 0.48], pinkyDip: [0.65, 0.54], pinkyTip: [0.65, 0.60],
  },
}

// peace: index+middle extended and separated; ring+pinky+thumb curled.
HAND_POSES.peace = {
  ...HAND_POSES.fist,
  indexPip: [0.42, 0.38], indexDip: [0.41, 0.28], indexTip: [0.40, 0.20],
  middlePip: [0.53, 0.36], middleDip: [0.54, 0.27], middleTip: [0.55, 0.18],
}

// thumbs-up: fist + thumb extended well above the wrist and every fingertip.
HAND_POSES['thumbs-up'] = {
  ...HAND_POSES.fist,
  thumbCmc: [0.45, 0.75], thumbMcp: [0.44, 0.62], thumbIp: [0.43, 0.50], thumbTip: [0.42, 0.38],
}

// kiss (chef's kiss): every fingertip pinched into one cluster, held up.
HAND_POSES.kiss = {
  wrist: [0.50, 0.90],
  thumbCmc: [0.40, 0.78], thumbMcp: [0.38, 0.62], thumbIp: [0.42, 0.44], thumbTip: [0.45, 0.32],
  indexMcp: [0.42, 0.52], indexPip: [0.42, 0.40], indexDip: [0.44, 0.34], indexTip: [0.45, 0.30],
  middleMcp: [0.50, 0.50], middlePip: [0.49, 0.38], middleDip: [0.47, 0.33], middleTip: [0.46, 0.29],
  ringMcp: [0.58, 0.52], ringPip: [0.55, 0.40], ringDip: [0.50, 0.34], ringTip: [0.47, 0.31],
  pinkyMcp: [0.66, 0.55], pinkyPip: [0.60, 0.44], pinkyDip: [0.53, 0.37], pinkyTip: [0.48, 0.33],
}

/** One hand pose scaled into pixels: `{landmarks, handedness}`. */
export function handPose (kind, { x = 0, y = 0, scale = 200, handedness = null } = {}) {
  const pose = HAND_POSES[kind]
  if (!pose) throw new Error(`unknown hand pose: ${kind}`)
  const landmarks = {}
  for (const [name, [px, py]] of Object.entries(pose)) {
    landmarks[name] = { x: x + px * scale, y: y + py * scale }
  }
  return { landmarks, handedness }
}

/** The two-hand heart: index tips meet at the top, thumb tips at the
 *  bottom, mirrored around x = 0.5 of the span. */
export function heartHandsPair ({ x = 0, y = 0, scale = 200 } = {}) {
  const left = handPose('kiss', { x, y, scale })                  // reuse pinched shape…
  const right = handPose('kiss', { x: x + scale * 0.1, y, scale })
  // …then place the tips where a heart puts them.
  left.landmarks.indexTip = { x: x + scale * 0.52, y: y + scale * 0.22 }
  left.landmarks.thumbTip = { x: x + scale * 0.50, y: y + scale * 0.62 }
  right.landmarks.indexTip = { x: x + scale * 0.58, y: y + scale * 0.22 }
  right.landmarks.thumbTip = { x: x + scale * 0.60, y: y + scale * 0.62 }
  left.handedness = 'left'
  right.handedness = 'right'
  return [left, right]
}

/* ----------------------------------------------------------- images ------ */

/** A solid RGBA image. */
export function solidImage (width, height, [r, g, b, a = 255]) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a }
  return { data, width, height }
}

/** Typical skin tone (sRGB) — inside the Cb/Cr skin cluster. */
export const SKIN_RGB = [205, 160, 130]
/** Saturated blue — far outside the skin cluster. */
export const SKY_RGB = [70, 120, 220]

/** A seeded noisy skin patch with a hard dark edge column down the middle
 *  — the edge-preservation fixture. */
export function skinEdgeImage (width, height, { seed = 3, noise = 14 } = {}) {
  const rand = mulberry32(seed)
  const img = solidImage(width, height, SKIN_RGB)
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rand() * 2 - 1) * noise
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n
  }
  const edgeX = Math.floor(width / 2)
  for (let y = 0; y < height; y++) {
    for (const dx of [0, 1]) {
      const i = (y * width + edgeX + dx) * 4
      img.data[i] = 40; img.data[i + 1] = 25; img.data[i + 2] = 20
    }
  }
  return img
}

/** Per-column mean absolute deviation from the column mean — the local
 *  noise metric the smoothing assertions use. */
export function columnNoise (image, x0, x1) {
  const { data, width, height } = image
  let total = 0
  let cols = 0
  for (let x = x0; x < x1; x++) {
    let mean = 0
    for (let y = 0; y < height; y++) mean += data[(y * width + x) * 4]
    mean /= height
    let dev = 0
    for (let y = 0; y < height; y++) dev += Math.abs(data[(y * width + x) * 4] - mean)
    total += dev / height
    cols++
  }
  return total / cols
}
