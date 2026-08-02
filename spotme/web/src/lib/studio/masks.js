/**
 * Spot Me — Creative Studio masks: the selection model every removal /
 * replace / relight op consumes.
 *
 * A mask is a soft coverage plane: { w, h, data: Uint8Array } with 255 =
 * fully selected. In an op-doc it travels as RLE (JSON-pure, bounded);
 * in memory it is painted by the brush, derived by chroma keying, guessed by
 * the sky heuristic, or — when the owner approves an on-device engine —
 * produced by an ISegmenter implementation. The three local producers are
 * REAL today; the segmenter is an adapter contract with no engine shipped,
 * and it says so at runtime instead of faking a result.
 */

/* ------------------------------------------------------------- mask model */

export function makeMask (w, h, fill = 0) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new RangeError('makeMask: bad size')
  const data = new Uint8Array(w * h)
  if (fill) data.fill(fill)
  return { w, h, data }
}

export function isMask (m) {
  return Boolean(m) && Number.isInteger(m.w) && Number.isInteger(m.h) &&
    m.w > 0 && m.h > 0 && m.data instanceof Uint8Array && m.data.length === m.w * m.h
}

/** Fraction of the frame selected (soft-weighted). */
export function maskCoverage (mask) {
  let sum = 0
  for (let i = 0; i < mask.data.length; i++) sum += mask.data[i]
  return sum / (mask.data.length * 255)
}

/* ------------------------------------------------------------------- RLE */

export const MAX_RLE_RUNS = 200_000

/**
 * Run-length encode: [count, value, count, value, …]. Deterministic, exact,
 * and JSON-pure — a brush mask over a 12 MP frame compresses to a few
 * thousand runs. An adversarial worst case (alternating pixels) is refused by
 * the run cap rather than serialized into a multi-megabyte document.
 */
export function encodeMaskRLE (mask) {
  if (!isMask(mask)) throw new TypeError('encodeMaskRLE: not a mask')
  const rle = []
  const d = mask.data
  let value = d[0]
  let count = 1
  for (let i = 1; i < d.length; i++) {
    if (d[i] === value && count < 0x7fffffff) {
      count++
    } else {
      rle.push(count, value)
      value = d[i]
      count = 1
    }
    if (rle.length > MAX_RLE_RUNS * 2) throw new RangeError('encodeMaskRLE: mask too noisy to serialize')
  }
  rle.push(count, value)
  return { w: mask.w, h: mask.h, rle }
}

export function decodeMaskRLE (obj) {
  if (!obj || !Number.isInteger(obj.w) || !Number.isInteger(obj.h) ||
      obj.w < 1 || obj.h < 1 || !Array.isArray(obj.rle) || obj.rle.length % 2 !== 0 ||
      obj.rle.length > MAX_RLE_RUNS * 2) {
    throw new TypeError('decodeMaskRLE: bad RLE object')
  }
  const mask = makeMask(obj.w, obj.h)
  let at = 0
  for (let i = 0; i < obj.rle.length; i += 2) {
    const count = obj.rle[i]
    const value = obj.rle[i + 1]
    if (!Number.isInteger(count) || count < 1 || !Number.isInteger(value) || value < 0 || value > 255) {
      throw new RangeError('decodeMaskRLE: bad run')
    }
    if (at + count > mask.data.length) throw new RangeError('decodeMaskRLE: runs exceed mask size')
    mask.data.fill(value, at, at + count)
    at += count
  }
  if (at !== mask.data.length) throw new RangeError('decodeMaskRLE: runs do not cover mask')
  return mask
}

/* ------------------------------------------------------------------ brush */

/** Stamp one soft round dab. hardness 1 = hard edge, 0 = full falloff. */
export function stampBrush (mask, cx, cy, radius, { hardness = 0.5, erase = false, flow = 1 } = {}) {
  if (!isMask(mask)) throw new TypeError('stampBrush: not a mask')
  const r = Math.max(0.5, radius)
  const x0 = Math.max(0, Math.floor(cx - r))
  const x1 = Math.min(mask.w - 1, Math.ceil(cx + r))
  const y0 = Math.max(0, Math.floor(cy - r))
  const y1 = Math.min(mask.h - 1, Math.ceil(cy + r))
  const hard = Math.min(1, Math.max(0, hardness))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r
      if (d > 1) continue
      const edge = hard >= 1 ? 1 : Math.min(1, (1 - d) / Math.max(1e-4, 1 - hard))
      const add = edge * flow * 255
      const i = y * mask.w + x
      mask.data[i] = erase
        ? Math.max(0, mask.data[i] - add)
        : Math.min(255, mask.data[i] + add)
    }
  }
  return mask
}

/** Stamp along a polyline with sub-radius spacing — the drag gesture. */
export function strokeBrush (mask, points, radius, opts = {}) {
  if (!Array.isArray(points) || points.length === 0) return mask
  const step = Math.max(1, radius * 0.4)
  let prev = points[0]
  stampBrush(mask, prev.x, prev.y, radius, opts)
  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    const dist = Math.hypot(p.x - prev.x, p.y - prev.y)
    const n = Math.max(1, Math.ceil(dist / step))
    for (let k = 1; k <= n; k++) {
      stampBrush(mask, prev.x + ((p.x - prev.x) * k) / n, prev.y + ((p.y - prev.y) * k) / n, radius, opts)
    }
    prev = p
  }
  return mask
}

/* -------------------------------------------------------------- chroma key */

/**
 * Chroma-key assist: distance from a key color in the CbCr plane (luma
 * dropped, so shading on a green screen keys evenly), smoothstepped between
 * tolerance and tolerance+softness. Returns the BACKGROUND coverage — 255
 * where the pixel matches the key color.
 */
export function chromaKeyMask (img, { color, tolerance = 0.12, softness = 0.08 } = {}) {
  if (!Array.isArray(color) || color.length !== 3) throw new TypeError('chromaKeyMask: color must be [r,g,b] 0..255')
  const [kr, kg, kb] = color.map((c) => {
    if (typeof c !== 'number' || c < 0 || c > 255) throw new RangeError('chromaKeyMask: color channel out of range')
    return c / 255
  })
  const keyCb = -0.168736 * kr - 0.331264 * kg + 0.5 * kb
  const keyCr = 0.5 * kr - 0.418688 * kg - 0.081312 * kb
  const mask = makeMask(img.width, img.height)
  const s = img.data
  const lo = tolerance
  const hi = tolerance + Math.max(1e-4, softness)
  for (let i = 0, j = 0; j < mask.data.length; i += 4, j++) {
    const r = s[i] / 255
    const g = s[i + 1] / 255
    const b = s[i + 2] / 255
    const cb = -0.168736 * r - 0.331264 * g + 0.5 * b
    const cr = 0.5 * r - 0.418688 * g - 0.081312 * b
    const d = Math.hypot(cb - keyCb, cr - keyCr)
    const t = d <= lo ? 1 : d >= hi ? 0 : 1 - (d - lo) / (hi - lo)
    mask.data[j] = t * 255 + 0.5
  }
  return mask
}

/* ------------------------------------------------------------ sky heuristic */

/**
 * Classic-CV sky mask: per-pixel score from color (blue/gray hue families),
 * brightness, and vertical position, then a per-column top-down coherence
 * scan — sky is connected to the top of the frame; a blue car on the road is
 * not. Honest envelope (docs/ai-camera/studio.md): works on open outdoor
 * skies, degrades on reflections, blue clothing near the top edge, dense
 * branch cover, and night shots. The result is a STARTING mask the user can
 * brush-correct; semantic accuracy belongs to the ISegmenter engine.
 */
export function skyHeuristicMask (img, { threshold = 0.45 } = {}) {
  const { width: w, height: h, data: s } = img
  const mask = makeMask(w, h)
  const score = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const posW = y / h < 0.75 ? 1 - (y / h) / 0.75 : 0        // top-weighted, dead below 75%
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const r = s[i] / 255
      const g = s[i + 1] / 255
      const b = s[i + 2] / 255
      const bright = (r + g + b) / 3
      const blueness = b - Math.max(r, g)                      // >0: blue dominates
      const grayness = 1 - (Math.max(r, g, b) - Math.min(r, g, b))
      const colorW = Math.max(blueness * 2.5, (grayness - 0.8) * 3 * bright)
      score[y * w + x] = Math.max(0, Math.min(1, colorW)) * Math.min(1, bright * 1.6) * posW
    }
  }
  // Column coherence: walk down from the top while the score holds; a gap of
  // a few weak rows (thin branches, wires) is tolerated, a solid break ends
  // the column's sky.
  const maxGap = Math.max(2, Math.round(h * 0.02))
  for (let x = 0; x < w; x++) {
    let gap = 0
    for (let y = 0; y < h; y++) {
      const v = score[y * w + x]
      if (v >= threshold) {
        gap = 0
        mask.data[y * w + x] = Math.min(255, v * 340)
      } else {
        gap++
        if (gap > maxGap) break
        mask.data[y * w + x] = Math.min(255, v * 200)
      }
    }
  }
  return mask
}

/* ------------------------------------------------- ISegmenter adapter slot */

/**
 * The semantic-segmentation contract. SAME NAME AND SHAPE as the camera
 * mission's adapter, defined independently here because the missions branch
 * from master in parallel — at integration time one definition wins and the
 * other imports it (flagged in the final report).
 *
 *   ISegmenter = {
 *     id: string,
 *     kinds: string[],                    // e.g. ['person', 'sky', 'hair']
 *     segment(image, { kind }) → Promise<mask>
 *   }
 *
 * No engine ships in this repo: the candidate (@mediapipe/tasks-vision,
 * Apache-2.0, with SELF-HOSTED model assets — no CDN at runtime) is an owner
 * dependency decision recorded in docs/ai-camera/studio-activation.md.
 * Until an engine is registered, `segment()` rejects loudly. Nothing in the
 * studio pretends a segmenter exists.
 */
export function createSegmenterSlot () {
  let engine = null
  return {
    register (candidate) {
      if (!candidate || typeof candidate.id !== 'string' || !candidate.id ||
          !Array.isArray(candidate.kinds) || candidate.kinds.length === 0 ||
          typeof candidate.segment !== 'function') {
        throw new TypeError('ISegmenter: engine must be {id, kinds[], segment()}')
      }
      if (engine) throw new Error(`ISegmenter: ${engine.id} already registered`)
      engine = candidate
    },
    available: () => Boolean(engine),
    kinds: () => (engine ? [...engine.kinds] : []),
    async segment (image, opts = {}) {
      if (!engine) {
        throw new Error('ISegmenter: no segmentation engine installed — semantic masks need the owner-approved on-device model (see studio-activation.md); use the brush, chroma key, or sky heuristic meanwhile')
      }
      const mask = await engine.segment(image, opts)
      if (!isMask(mask) || mask.w !== image.width || mask.h !== image.height) {
        throw new Error(`ISegmenter: engine ${engine.id} returned a bad mask`)
      }
      return mask
    }
  }
}
