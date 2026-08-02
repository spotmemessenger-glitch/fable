/**
 * Spot Me vision — finding the page: largest-convex-quad detection from
 * first principles (downscaled luma → Sobel edge map → Hough lines → quad
 * assembly → geometric + edge-support scoring).
 *
 * WHY HOUGH AND NOT CONTOUR TRACING. A phone photo of a document is four
 * long, straight, high-contrast edges interrupted by fingers, shadows and
 * table clutter. Contour tracing dies on the first interruption; a Hough
 * accumulator collects evidence for each LINE independently of gaps, which
 * is exactly the robustness a hand-held scanner needs. The line count is
 * small (top 10), so trying every 4-subset (≤210) is cheap and beats any
 * greedy pairing at finding the quad the human sees.
 *
 * THE REFUSAL IS THE FEATURE. When no candidate scores above the floor the
 * answer is UNAVAILABLE(NO_QUAD_FOUND) with the best score in `detail` —
 * never a guessed centre crop pretending to be detection. A fake detection
 * would survive a demo and mangle the first real receipt.
 *
 * All coordinates returned are in FULL-RESOLUTION image space (the
 * detector works on a ≤240px downscale and scales back up).
 */

import { lumaPlane, downscalePlane, boxBlurPlane } from '../camera/imagemath.js'
import { sobel, planePercentile, orderCorners, polygonArea, isConvex, quadAngles } from './imageops.js'
import { VISION_UNAVAILABLE, available, unavailable } from './availability.js'

export const QUAD_DEFAULTS = Object.freeze({
  /** Working width of the downscale the detector runs on. 240 keeps the
   *  Hough pass ~10 ms while an A4 edge is still ~200 votes long. */
  workSize: 240,
  /** Hough angular resolution — 1° distinguishes a page edge from its
   *  shadow at these working sizes. */
  thetaSteps: 180,
  /** How many peak lines to keep for quad assembly. */
  maxLines: 10,
  /** Gradient percentile that counts as "an edge" (of NON-ZERO gradients;
   *  a page on a plain background is mostly zero gradient). */
  edgePercentile: 88,
  /** A plausible page fills at least this fraction of the frame. */
  minAreaFraction: 0.12,
  /** Interior angles of a perspective-photographed rectangle stay inside
   *  this window; beyond it the "quad" is a sliver or a bowtie. */
  angleWindowDeg: [35, 145],
  /** Fraction of sampled quad-perimeter points that must sit on edge
   *  pixels. Below this the lines exist but the QUAD is imaginary. */
  minEdgeSupport: 0.55,
  /** Overall score floor — measured against the synthetic corpus: real
   *  pages (straight, rotated, perspective, noisy) score ≥0.45; the best
   *  accidental quad on a featureless frame scores ≤0.15. */
  minScore: 0.3,
})

/**
 * Hough transform over an edge-magnitude plane. Returns up to `maxLines`
 * peak lines as { theta, rho, votes }, non-max-suppressed so near-duplicate
 * lines (a thick edge) collapse to one.
 *
 * Line model: x·cosθ + y·sinθ = ρ, θ ∈ [0,π), ρ ∈ [−diag, +diag].
 */
export function houghLines (edge, { thetaSteps = 180, maxLines = 10, threshold = 0 } = {}) {
  const { data, width, height } = edge
  const diag = Math.ceil(Math.hypot(width, height))
  const rhoCount = diag * 2 + 1
  const acc = new Float32Array(thetaSteps * rhoCount)
  const cos = new Float32Array(thetaSteps)
  const sin = new Float32Array(thetaSteps)
  for (let t = 0; t < thetaSteps; t++) {
    const theta = (t * Math.PI) / thetaSteps
    cos[t] = Math.cos(theta)
    sin[t] = Math.sin(theta)
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const m = data[y * width + x]
      if (m <= threshold) continue
      for (let t = 0; t < thetaSteps; t++) {
        const rho = Math.round(x * cos[t] + y * sin[t]) + diag
        acc[t * rhoCount + rho] += m
      }
    }
  }
  // Peak pick with suppression in a (θ±5°, ρ±4px) neighbourhood.
  const lines = []
  const tWin = Math.max(1, Math.round(thetaSteps / 36))
  const rWin = 4
  const suppressed = new Uint8Array(acc.length)
  for (let n = 0; n < maxLines; n++) {
    let best = -1
    let bestIdx = -1
    for (let i = 0; i < acc.length; i++) {
      if (!suppressed[i] && acc[i] > best) { best = acc[i]; bestIdx = i }
    }
    if (bestIdx < 0 || best <= 0) break
    const t = Math.floor(bestIdx / rhoCount)
    const r = bestIdx % rhoCount
    lines.push({ theta: (t * Math.PI) / thetaSteps, rho: r - diag, votes: best })
    for (let dt = -tWin; dt <= tWin; dt++) {
      // θ wraps at π with ρ negating — suppress both readings of the line.
      let tt = t + dt
      let flip = false
      if (tt < 0) { tt += thetaSteps; flip = true }
      if (tt >= thetaSteps) { tt -= thetaSteps; flip = true }
      const rc = flip ? (diag - (r - diag)) : r
      for (let dr = -rWin; dr <= rWin; dr++) {
        const rr = rc + dr
        if (rr >= 0 && rr < rhoCount) suppressed[tt * rhoCount + rr] = 1
      }
    }
  }
  return lines
}

/** Intersection of two Hough lines, or null when near-parallel. */
export function intersectLines (a, b) {
  const det = Math.cos(a.theta) * Math.sin(b.theta) - Math.sin(a.theta) * Math.cos(b.theta)
  if (Math.abs(det) < 1e-6) return null
  return {
    x: (a.rho * Math.sin(b.theta) - b.rho * Math.sin(a.theta)) / det,
    y: (b.rho * Math.cos(a.theta) - a.rho * Math.cos(b.theta)) / det,
  }
}

/** Fraction of points sampled along the quad's perimeter that land on
 *  edge pixels (magnitude above threshold, ±1px tolerance). */
export function edgeSupport (edge, corners, threshold, samplesPerSide = 24) {
  const { data, width, height } = edge
  let onEdge = 0
  let total = 0
  const hit = (x, y) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.round(x) + dx
        const yy = Math.round(y) + dy
        if (xx >= 0 && yy >= 0 && xx < width && yy < height && data[yy * width + xx] > threshold) return true
      }
    }
    return false
  }
  for (let i = 0; i < 4; i++) {
    const a = corners[i]
    const b = corners[(i + 1) % 4]
    for (let s = 1; s < samplesPerSide; s++) {
      const t = s / samplesPerSide
      total++
      if (hit(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) onEdge++
    }
  }
  return total ? onEdge / total : 0
}

/**
 * The detector. `image` is RGBA {data,width,height}; the answer is
 * { available:true, corners:[TL,TR,BR,BL] (full-res px), score, facts… }
 * or UNAVAILABLE(NO_QUAD_FOUND) with how close it got.
 */
export function detectDocumentQuad (image, opts = {}) {
  const o = { ...QUAD_DEFAULTS, ...opts }
  if (!image?.data || !image.width || !image.height) {
    return unavailable(VISION_UNAVAILABLE.BAD_INPUT, 'image must be {data,width,height}')
  }
  // 1. Downscale → luma → light blur (kills sensor noise the Sobel would
  //    otherwise amplify into phantom votes).
  const scale = Math.min(1, o.workSize / Math.max(image.width, image.height))
  const workW = Math.max(16, Math.round(image.width * scale))
  const workH = Math.max(16, Math.round(image.height * scale))
  const luma = downscalePlane(lumaPlane(image), workW, workH)
  const smooth = boxBlurPlane(luma, 1)

  // 2. Edge map, thresholded at a percentile of the NON-ZERO gradients.
  const { mag } = sobel(smooth)
  const nonZero = Float32Array.from(mag.data.filter((v) => v > 1e-4))
  if (nonZero.length < 32) {
    return unavailable(VISION_UNAVAILABLE.NO_QUAD_FOUND, 'no gradients — the frame is featureless')
  }
  const threshold = planePercentile({ data: nonZero, width: nonZero.length, height: 1 }, o.edgePercentile)
  const edge = { data: mag.data.map((v) => (v > threshold ? v : 0)), width: workW, height: workH }

  // 3. Lines, then every 4-subset assembled into a candidate quad.
  const lines = houghLines(edge, { thetaSteps: o.thetaSteps, maxLines: o.maxLines })
  if (lines.length < 4) {
    return unavailable(VISION_UNAVAILABLE.NO_QUAD_FOUND, `only ${lines.length} line(s) of evidence`)
  }
  const frameArea = workW * workH
  const margin = 0.25                       // corners may sit slightly out of frame
  let best = null
  let bestScore = 0
  for (let a = 0; a < lines.length - 3; a++) {
    for (let b = a + 1; b < lines.length - 2; b++) {
      for (let c = b + 1; c < lines.length - 1; c++) {
        for (let d = c + 1; d < lines.length; d++) {
          const quad = quadFromLines([lines[a], lines[b], lines[c], lines[d]], workW, workH, margin)
          if (!quad) continue
          const areaFraction = Math.abs(polygonArea(quad)) / frameArea
          if (areaFraction < o.minAreaFraction || areaFraction > 1.25) continue
          const angles = quadAngles(quad)
          if (angles.some((deg) => deg < o.angleWindowDeg[0] || deg > o.angleWindowDeg[1])) continue
          const support = edgeSupport(edge, quad, 0)
          if (support < o.minEdgeSupport) continue
          const angleScore = 1 - Math.max(...angles.map((deg) => Math.abs(deg - 90))) / 90
          const score = Math.min(1, areaFraction) * 0.4 + support * 0.4 + angleScore * 0.2
          if (score > bestScore) { bestScore = score; best = quad }
        }
      }
    }
  }
  if (!best || bestScore < o.minScore) {
    return unavailable(VISION_UNAVAILABLE.NO_QUAD_FOUND,
      best ? `best candidate scored ${bestScore.toFixed(2)} < ${o.minScore}` : 'no convex candidate survived the sanity gates')
  }
  // 4. Scale corners back to full resolution.
  const sx = image.width / workW
  const sy = image.height / workH
  const corners = best.map((p) => ({
    x: Math.min(image.width - 1, Math.max(0, p.x * sx)),
    y: Math.min(image.height - 1, Math.max(0, p.y * sy)),
  }))
  return available({ corners, score: bestScore, workSize: { width: workW, height: workH }, lines: lines.length })
}

/** Assemble 4 lines into an ordered convex quad, or null. Lines sorted by
 *  angle pair up as (0,2) and (1,3) — opposite sides — which is the only
 *  pairing that yields a convex quad from two roughly-perpendicular
 *  families. */
function quadFromLines (four, width, height, margin) {
  const sorted = [...four].sort((a, b) => a.theta - b.theta)
  const sideA = [sorted[0], sorted[2]]
  const sideB = [sorted[1], sorted[3]]
  const points = []
  for (const la of sideA) {
    for (const lb of sideB) {
      const p = intersectLines(la, lb)
      if (!p) return null
      if (p.x < -width * margin || p.x > width * (1 + margin) ||
          p.y < -height * margin || p.y > height * (1 + margin)) return null
      points.push(p)
    }
  }
  const ordered = orderCorners(points)
  return isConvex(ordered) ? ordered : null
}
