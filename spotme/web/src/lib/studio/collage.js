/**
 * Spot Me — Creative Studio collage: a data-driven layout engine that renders
 * N photos into ONE image. Layouts are plain data (normalized cell rects), so
 * adding a layout is adding a table row, and the pixel math — gutters,
 * cover-fit, rounded corners with anti-aliased edges, background — is one
 * tested renderer.
 */

import { coverResize } from './composite.js'
import { makeImage, isImage } from './image-io.js'
import { num } from './ops-color.js'

/** cells: [x, y, w, h] normalized to the unit square, BEFORE gutters. */
export const COLLAGE_LAYOUTS = Object.freeze({
  two_vertical: { name: 'Two, side by side', cells: [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]] },
  two_horizontal: { name: 'Two, stacked', cells: [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]] },
  three_hero_left: {
    name: 'Hero left + two',
    cells: [[0, 0, 0.62, 1], [0.62, 0, 0.38, 0.5], [0.62, 0.5, 0.38, 0.5]]
  },
  three_columns: { name: 'Three columns', cells: [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]] },
  four_grid: { name: 'Four grid', cells: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]] },
  four_hero_top: {
    name: 'Hero top + three',
    cells: [[0, 0, 1, 0.6], [0, 0.6, 1 / 3, 0.4], [1 / 3, 0.6, 1 / 3, 0.4], [2 / 3, 0.6, 1 / 3, 0.4]]
  },
  six_grid: {
    name: 'Six grid',
    cells: [
      [0, 0, 1 / 3, 0.5], [1 / 3, 0, 1 / 3, 0.5], [2 / 3, 0, 1 / 3, 0.5],
      [0, 0.5, 1 / 3, 0.5], [1 / 3, 0.5, 1 / 3, 0.5], [2 / 3, 0.5, 1 / 3, 0.5]
    ]
  },
  nine_grid: {
    name: 'Nine grid',
    cells: Array.from({ length: 9 }, (_, i) => [(i % 3) / 3, Math.floor(i / 3) / 3, 1 / 3, 1 / 3])
  }
})

export const collageLayoutIds = () => Object.keys(COLLAGE_LAYOUTS)

/* ------------------------------------------------------------- layout math */

/**
 * Normalized cells → pixel rects with gutters applied: `gutter` px between
 * cells AND around the border. Pure and exact: cells that share an edge in
 * normalized space stay exactly one gutter apart in pixels.
 */
export function layoutCells (layoutId, width, height, gutter = 0) {
  const layout = COLLAGE_LAYOUTS[layoutId]
  if (!layout) throw new RangeError(`unknown collage layout: ${layoutId}`)
  const g = Math.max(0, Math.trunc(gutter))
  return layout.cells.map(([x, y, w, h]) => {
    const px = Math.round(x * width + g / 2) + (x === 0 ? g / 2 : 0)
    const py = Math.round(y * height + g / 2) + (y === 0 ? g / 2 : 0)
    const pr = Math.round((x + w) * width - g / 2) - (x + w >= 0.999 ? g / 2 : 0)
    const pb = Math.round((y + h) * height - g / 2) - (y + h >= 0.999 ? g / 2 : 0)
    return {
      x: Math.round(px),
      y: Math.round(py),
      w: Math.max(1, Math.round(pr - px)),
      h: Math.max(1, Math.round(pb - py))
    }
  })
}

/* --------------------------------------------------------------- rendering */

const hexToRgb = (hex) => {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex))
  if (!m) throw new RangeError('collage.background must be #rrggbb')
  const v = parseInt(m[1], 16)
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
}

/**
 * Render a collage.
 *
 *   images   array of pixel images, one per cell (fewer → remaining cells
 *            stay background; more → extras ignored, both surfaced in result)
 *   options  { width, height, gutter, radius, background }
 *
 * → { image, placed, empty }
 */
export function renderCollage (layoutId, images, options = {}) {
  const width = Math.trunc(num(options.width, 'collage.width', 64, 4096, 1080))
  const height = Math.trunc(num(options.height, 'collage.height', 64, 4096, 1080))
  const gutter = Math.trunc(num(options.gutter, 'collage.gutter', 0, 64, 8))
  const radius = Math.trunc(num(options.radius, 'collage.radius', 0, 96, 16))
  const bg = hexToRgb(options.background || '#101014')

  const cells = layoutCells(layoutId, width, height, gutter)
  const out = makeImage(width, height)
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = bg[0]
    out.data[i + 1] = bg[1]
    out.data[i + 2] = bg[2]
    out.data[i + 3] = 255
  }

  let placed = 0
  for (let c = 0; c < cells.length; c++) {
    const img = images[c]
    if (!isImage(img)) continue
    const cell = cells[c]
    const fitted = coverResize(img, cell.w, cell.h)
    const r = Math.min(radius, Math.floor(Math.min(cell.w, cell.h) / 2))
    for (let y = 0; y < cell.h; y++) {
      for (let x = 0; x < cell.w; x++) {
        // Rounded-corner coverage: 1 inside, anti-aliased ramp across the
        // corner circle's edge. Straight edges keep full coverage.
        let cov = 1
        if (r > 0) {
          const cx = x < r ? r : x >= cell.w - r ? cell.w - r - 1 : -1
          const cy = y < r ? r : y >= cell.h - r ? cell.h - r - 1 : -1
          if (cx >= 0 && cy >= 0) {
            const d = Math.hypot(x - cx, y - cy)
            cov = Math.max(0, Math.min(1, r + 0.5 - d))
          }
        }
        if (cov <= 0) continue
        const si = (y * cell.w + x) * 4
        const di = ((cell.y + y) * width + (cell.x + x)) * 4
        out.data[di] = fitted.data[si] * cov + out.data[di] * (1 - cov) + 0.5
        out.data[di + 1] = fitted.data[si + 1] * cov + out.data[di + 1] * (1 - cov) + 0.5
        out.data[di + 2] = fitted.data[si + 2] * cov + out.data[di + 2] * (1 - cov) + 0.5
      }
    }
    placed++
  }
  return { image: out, placed, empty: cells.length - placed }
}
