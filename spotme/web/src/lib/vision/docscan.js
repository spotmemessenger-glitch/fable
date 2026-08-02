/**
 * Spot Me vision — the document scanner: detect → rectify → enhance →
 * assemble, with ZERO persistence anywhere in the chain.
 *
 * Pages live in memory as {data,width,height} until the caller asks for
 * Blobs, and the Blobs are handed over, not stored — this module touches
 * no IndexedDB, no localStorage, no cache (fence-enforced). A scanned
 * page reaches disk only if a future wiring PR passes the Blob to the
 * app's existing, reviewed media path.
 *
 * The encoder seam: `toBlobs` uses an injected `encode(image) → Blob`
 * when the wiring PR provides one (canvas JPEG/WebP — smaller files), and
 * falls back to the module's own dependency-free PNG writer, which works
 * everywhere including Node. Either way the format is REAL and labeled.
 */

import { detectDocumentQuad, QUAD_DEFAULTS } from './quad.js'
import { homographyFromPoints, warpPerspective } from './homography.js'
import { orderCorners } from './imageops.js'
import { enhancePage, ENHANCE_MODES } from './enhance.js'
import { encodePngBlob } from './png.js'
import { VISION_UNAVAILABLE, available, unavailable } from './availability.js'

export const DOCSCAN_DEFAULTS = Object.freeze({
  /** Longest output side a rectified page is capped at. */
  maxOutputSize: 2400,
  /** Refuse rectangles thinner than this — a 40×2000 "page" is a table
   *  edge, not a document. */
  minAspect: 1 / 8,
  /** Cap on assembled pages per document (memory bound, stated). */
  maxPages: 40,
})

/**
 * Output geometry for a rectified quad: opposite-side maxima, capped to
 * `maxOutputSize` with aspect preserved. Exported for the bench.
 */
export function rectifiedSize (corners, { maxOutputSize = DOCSCAN_DEFAULTS.maxOutputSize } = {}) {
  const [tl, tr, br, bl] = corners
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
  let w = Math.max(dist(tl, tr), dist(bl, br))
  let h = Math.max(dist(tl, bl), dist(tr, br))
  const long = Math.max(w, h)
  if (long > maxOutputSize) {
    const s = maxOutputSize / long
    w *= s
    h *= s
  }
  return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) }
}

/**
 * Rectify `image` inside `corners` (any order — re-ordered here) to a
 * front-on page. The homography maps OUTPUT → SOURCE so the warp samples
 * exactly once per output pixel.
 */
export function rectifyDocument (image, corners, opts = {}) {
  if (!image?.data || !image.width || !image.height) {
    return unavailable(VISION_UNAVAILABLE.BAD_INPUT, 'image must be {data,width,height}')
  }
  if (!Array.isArray(corners) || corners.length !== 4 ||
      corners.some((p) => typeof p?.x !== 'number' || typeof p?.y !== 'number')) {
    return unavailable(VISION_UNAVAILABLE.BAD_INPUT, 'corners must be 4 {x,y} points')
  }
  const ordered = orderCorners(corners)
  const { width, height } = rectifiedSize(ordered, opts)
  const aspect = Math.min(width, height) / Math.max(width, height)
  const minAspect = opts.minAspect ?? DOCSCAN_DEFAULTS.minAspect
  if (aspect < minAspect) {
    return unavailable(VISION_UNAVAILABLE.NO_QUAD_FOUND,
      `quad aspect ${aspect.toFixed(3)} is a sliver, not a page`)
  }
  const dst = [{ x: 0, y: 0 }, { x: width - 1, y: 0 }, { x: width - 1, y: height - 1 }, { x: 0, y: height - 1 }]
  const H = homographyFromPoints(dst, ordered)   // output px → source px
  if (!H) return unavailable(VISION_UNAVAILABLE.FAILED, 'degenerate corner correspondence')
  return available({ image: warpPerspective(image, H, width, height), corners: ordered, width, height })
}

/**
 * One shot: detect the page in `image`, rectify it, apply the enhance
 * mode. Every stage's refusal passes through UNCHANGED — a caller that
 * sees NO_QUAD_FOUND knows to tell the user to re-aim, not to retry the
 * same frame.
 */
export function scanDocumentPage (image, { mode = 'color', quad = null, ...opts } = {}) {
  const detected = quad ? available({ corners: quad, score: null }) : detectDocumentQuad(image, opts)
  if (!detected.available) return detected
  const rectified = rectifyDocument(image, detected.corners, opts)
  if (!rectified.available) return rectified
  const enhanced = enhancePage(rectified.image, mode, opts)
  if (!enhanced.available) return enhanced
  return available({
    page: enhanced.image,
    mode,
    corners: rectified.corners,
    score: detected.score,
    width: rectified.width,
    height: rectified.height,
  })
}

/**
 * Multi-page assembly. Pages are copied in (the caller's buffer stays the
 * caller's) and live ONLY in this object; `clear()` — or dropping the
 * assembler — is the entire deletion story, by privacy design.
 */
export function createDocumentAssembler ({ maxPages = DOCSCAN_DEFAULTS.maxPages, encode = null } = {}) {
  const pages = []
  return {
    addPage (image, { mode = 'color', name = null } = {}) {
      if (!image?.data || !image.width || !image.height) {
        return unavailable(VISION_UNAVAILABLE.BAD_INPUT, 'page must be {data,width,height}')
      }
      if (pages.length >= maxPages) {
        return unavailable(VISION_UNAVAILABLE.INPUT_TOO_LARGE, `document is capped at ${maxPages} pages`)
      }
      pages.push({
        image: { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height },
        mode,
        name: name || `page-${pages.length + 1}`,
      })
      return available({ index: pages.length - 1, count: pages.length })
    },
    removePage (index) {
      if (index < 0 || index >= pages.length) return unavailable(VISION_UNAVAILABLE.BAD_INPUT, `no page ${index}`)
      pages.splice(index, 1)
      return available({ count: pages.length })
    },
    pages: () => pages.map((p, i) => ({ index: i, name: p.name, mode: p.mode, width: p.image.width, height: p.image.height })),
    clear () { pages.length = 0 },
    /** Encode every page to a Blob. Injected encoder first, PNG floor
     *  otherwise; `type` REPORTS what was actually produced. */
    async toBlobs () {
      const out = []
      for (const p of pages) {
        let blob = null
        if (encode) {
          try { blob = await encode(p.image) } catch { blob = null }
        }
        if (!blob) blob = encodePngBlob(p.image)
        out.push({ blob, type: blob.type || 'image/png', name: p.name, width: p.image.width, height: p.image.height })
      }
      return available({ pages: out, count: out.length })
    },
  }
}

export { ENHANCE_MODES, QUAD_DEFAULTS }
