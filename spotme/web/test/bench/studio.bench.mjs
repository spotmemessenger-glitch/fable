/**
 * Creative Studio benchmarks — CPU path, Node.
 *
 *   node test/bench/studio.bench.mjs
 *
 * WHAT THIS MEASURES: the byte-deterministic CPU evaluator — the path that
 * renders exports, runs everywhere, and bounds the worst case. Roadmap V2 §8
 * asks for environment, raw results, median AND tail, so all are printed.
 *
 * WHAT IT DOES NOT: the WebGL2 preview path (needs a real browser + GPU and
 * varies per device — measure on hardware before activation and append to
 * studio-benchmarks.md), video ENCODING (WebCodecs/MediaRecorder are
 * browser-only; the composer number here is frame COMPOSITION only), and
 * IndexedDB draft I/O (bounded by the same store behavior idb-bench.mjs
 * already measures).
 */
import os from 'node:os'
import { execSync } from 'node:child_process'
import { createEvaluator } from '../../src/lib/studio/evaluator.js'
import '../../src/lib/studio/ops-color.js'
import '../../src/lib/studio/ops-spatial.js'
import '../../src/lib/studio/ops-geometry.js'
import '../../src/lib/studio/looks.js'
import '../../src/lib/studio/inpaint.js'
import '../../src/lib/studio/composite.js'
import { applyLUT3D, buildLookLUT } from '../../src/lib/studio/looks.js'
import { inpaintTelea } from '../../src/lib/studio/inpaint.js'
import { makeMask, encodeMaskRLE } from '../../src/lib/studio/masks.js'
import { makeImage } from '../../src/lib/studio/image-io.js'
import {
  validateTimeline, renderFrame, TIMELINE_KIND, TIMELINE_VERSION
} from '../../src/lib/studio/composer.js'

const evaluator = createEvaluator()

function image (w, h) {
  const img = makeImage(w, h)
  for (let i = 0; i < img.data.length; i += 4) {
    const p = i / 4
    img.data[i] = (p * 7) % 256
    img.data[i + 1] = (p * 13) % 256
    img.data[i + 2] = (p * 29) % 256
    img.data[i + 3] = 255
  }
  return img
}

function stats (times) {
  const sorted = [...times].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return { median: at(0.5), p90: at(0.9), min: sorted[0], max: sorted[sorted.length - 1], raw: times }
}

function bench (fn, reps) {
  const times = []
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now()
    fn()
    times.push(Math.round((performance.now() - t0) * 10) / 10)
  }
  return stats(times)
}

const fmt = (s) => `median ${s.median} ms  p90 ${s.p90} ms  (min ${s.min}, max ${s.max}, raw [${s.raw.join(', ')}])`

console.log('## studio bench — CPU path (Node)')
console.log(`env: node ${process.version}, ${os.cpus()[0]?.model || 'unknown cpu'} x${os.cpus().length}, ${os.platform()} ${os.arch()}`)
try {
  console.log(`commit: ${execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()}`)
} catch { /* not a repo */ }

/* ------------------------------------------------------------ per-op cost */

const MP1 = image(1155, 866)          // ≈1.0 MP
const MP12 = image(4000, 3000)        // 12 MP

const OPS = [
  ['exposure', { ev: 0.6 }],
  ['contrast', { amount: 0.4 }],
  ['saturation', { amount: 0.4 }],
  ['temperature', { temp: 0.5, tint: 0.1 }],
  ['highlights_shadows', { highlights: -0.4, shadows: 0.4 }],
  ['curves', { master: [[0, 0.05], [0.5, 0.55], [1, 1]] }],
  ['look', { id: 'teal_glow', strength: 1 }],
  ['vignette', { amount: 0.5 }],
  ['grain', { amount: 0.5, size: 2, seed: 1 }],
  ['sharpen', { amount: 1, radius: 1.5 }],
  ['clarity', { amount: 0.5, radius: 16 }],
  ['straighten', { degrees: 3 }],
  ['perspective', { quad: [[0.05, 0], [0.95, 0.02], [1, 1], [0, 0.98]] }]
]

console.log('\n### per-op, 1 MP (1155x866), 5 reps')
for (const [op, params] of OPS) {
  const s = bench(() => evaluator.render(MP1, [{ op, v: 1, params }], { quality: 'export' }), 5)
  console.log(`${op.padEnd(20)} ${fmt(s)}`)
}

/* 12 MP: the export worst case. Per-pixel ops scale linearly; the two
 * blur-backed ops are the expensive tail and are measured once each so the
 * bench itself stays runnable. */
console.log('\n### per-op, 12 MP (4000x3000), 2 reps (1 rep where noted)')
for (const [op, params] of OPS) {
  const heavy = op === 'clarity' || op === 'sharpen' || op === 'perspective' || op === 'straighten'
  const s = bench(() => evaluator.render(MP12, [{ op, v: 1, params }], { quality: 'export' }), heavy ? 1 : 2)
  console.log(`${op.padEnd(20)} ${fmt(s)}${heavy ? '  [1 rep]' : ''}`)
}

/* --------------------------------------------------------- inpaint scaling */

console.log('\n### inpaint cost vs region size (400x300 frame, radius 4, refine 6, 3 reps)')
const frame = image(400, 300)
for (const side of [22, 45, 89, 173]) {
  const mask = makeMask(400, 300)
  const x0 = Math.floor((400 - side) / 2)
  const y0 = Math.floor((300 - side) / 2)
  for (let y = y0; y < y0 + side; y++) for (let x = x0; x < x0 + side; x++) mask.data[y * 400 + x] = 255
  const px = side * side
  const s = bench(() => inpaintTelea(frame, mask), 3)
  console.log(`${String(px).padStart(6)} px  ${fmt(s)}`)
}

/* --------------------------------------------------------------- LUT apply */

console.log('\n### 3D LUT apply (trilinear, 17^3), 1 MP, 5 reps')
const lut = buildLookLUT('film_fade')
console.log(`applyLUT3D           ${fmt(bench(() => applyLUT3D(MP1, lut, 1), 5))}`)

/* ------------------------------------------------------------ composer fps */

console.log('\n### composer frame composition, 720x1280 story, 2 segments + crossfade')
const timeline = validateTimeline({
  kind: TIMELINE_KIND,
  v: TIMELINE_VERSION,
  width: 720,
  height: 1280,
  fps: 30,
  segments: [
    {
      type: 'image',
      ref: 'a',
      durMs: 3000,
      ops: [{ op: 'look', v: 1, params: { id: 'golden_hour', strength: 1 } }],
      kenBurns: { from: { x: 0.5, y: 0.5, scale: 1 }, to: { x: 0.5, y: 0.45, scale: 1.1 } },
      transition: { type: 'crossfade', durMs: 500 }
    },
    { type: 'image', ref: 'b', durMs: 3000 }
  ]
})
const assets = new Map([['a', image(1080, 1920)], ['b', image(1080, 1920)]])
for (const [label, tMs] of [['plain frame', 1000], ['transition frame', 2700]]) {
  const s = bench(() => renderFrame(timeline, tMs, { assets }), 5)
  console.log(`${label.padEnd(20)} ${fmt(s)}  ≈ ${(1000 / s.median).toFixed(1)} fps`)
}
console.log('\nNOTE: composition only — encoding adds WebCodecs (faster than realtime')
console.log('on 2020+ phones) or MediaRecorder (realtime by construction) on top.')

/* Sanity: mask RLE size for the draft-size story. */
const brushMask = makeMask(4000, 3000)
for (let y = 1000; y < 1400; y++) for (let x = 1500; x < 2000; x++) brushMask.data[y * 4000 + x] = 255
console.log(`\nRLE size for a 500x400 brush region on 12 MP: ${JSON.stringify(encodeMaskRLE(brushMask)).length} chars`)
