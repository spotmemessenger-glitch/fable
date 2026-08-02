/**
 * Camera engine benchmarks — Roadmap V2 §8 requires environment, raw
 * results, median AND tail, so all are printed. Node numbers isolate the
 * ALGORITHMS' cost (pure JS on typed arrays) from any real device's
 * camera/GPU, which the manual matrix measures separately on hardware —
 * a phone's per-MP cost will differ; the SHAPE (linear in pixels) will
 * not.
 *
 *   node test/bench/camera.bench.mjs
 */
import { cpus, totalmem, platform, arch } from 'node:os'
import { fuseExposures } from '../../src/lib/camera/hdr.js'
import { stackFrames } from '../../src/lib/camera/night.js'
import { estimateShift } from '../../src/lib/camera/align.js'
import { fft2d } from '../../src/lib/camera/fft.js'
import { lumaPlane } from '../../src/lib/camera/imagemath.js'
import { createPipeline } from '../../src/lib/camera/pipeline.js'
import { exposureGainStage, lutStage, gammaLut } from '../../src/lib/camera/stages.js'
import { createStabilizer } from '../../src/lib/camera/stabilize.js'
import { applyPortrait } from '../../src/lib/camera/portrait.js'
import { muxWebm } from '../../src/lib/camera/webm-mux.js'
import { openSession } from '../../src/lib/camera/session.js'
import { createFrameSource } from '../../src/lib/camera/frame-source.js'
import { percentile } from '../../src/lib/camera/metrics.js'
import { androidChromeLike } from '../helpers/fake-media.js'

/* ------------------------------------------------------------ fixtures --- */

function mulberry32 (seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function syntheticFrame (width, height, seed) {
  const rand = mulberry32(seed)
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const v = 40 + ((x * 3 + y * 5) % 160) + rand() * 24
      data[i] = v; data[i + 1] = v * 0.9; data[i + 2] = v * 1.1; data[i + 3] = 255
    }
  }
  return { data, width, height }
}

function bench (name, iterations, fn, { unitScale = 1, unit = 'ms' } = {}) {
  fn()                                     // warm-up: JIT + allocation paths
  const samples = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    fn()
    samples.push((performance.now() - t0) / unitScale)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  console.log(`  ${name}`)
  console.log(`    n=${iterations}  median=${fmt(percentile(samples, 50))}  p90=${fmt(percentile(samples, 90))}  ` +
    `p99=${fmt(percentile(samples, 99))}  min=${fmt(sorted[0])}  max=${fmt(sorted[sorted.length - 1])}  [${unit}]`)
  return { median: percentile(samples, 50), p99: percentile(samples, 99) }
}

const fmt = (v) => (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3))

/* ----------------------------------------------------------- env stamp --- */

console.log('\n========================================')
console.log('  camera engine bench')
console.log('========================================')
console.log(`  node ${process.version} · ${platform()}/${arch()} · ${cpus()[0]?.model?.trim() || 'unknown cpu'}`)
console.log(`  cores=${cpus().length} · mem=${(totalmem() / 2 ** 30).toFixed(1)}GiB · ${new Date().toISOString()}`)
console.log('')

/* -------------------------------------------------- 1. fusion/stacking --- */

{
  const W = 512; const H = 384                        // 0.197 MP
  const mp = (W * H) / 1e6
  const bracket = [1, 2, 3].map((s) => syntheticFrame(W, H, s))
  console.log(`— HDR fusion (3 frames, ${W}×${H} = ${mp.toFixed(2)} MP) —`)
  bench('fuseExposures per-frame-set, per MP', 12, () => fuseExposures(bracket), { unitScale: mp, unit: 'ms/MP' })

  const stack = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => syntheticFrame(W, H, s))
  console.log(`— Night stack (8 frames mean+align+reject, ${W}×${H}) —`)
  bench('stackFrames per stack, per MP', 8, () => stackFrames(stack), { unitScale: mp, unit: 'ms/MP' })
}

/* ------------------------------------------------ 2. phase correlation --- */

{
  const a = lumaPlane(syntheticFrame(1280, 720, 10))
  const b = lumaPlane(syntheticFrame(1280, 720, 10))
  console.log('— Alignment (1280×720 luma → 64×64 tile) —')
  bench('estimateShift (downscale + 3×FFT + peak)', 50, () => estimateShift(a, b))
  const re = new Float32Array(64 * 64).map(() => Math.random())
  console.log('— Raw 2D FFT 64×64 —')
  bench('fft2d forward', 200, () => fft2d(new Float32Array(re), new Float32Array(64 * 64), 64, 64))
}

/* ------------------------------------------------- 3. pipeline stages ---- */

{
  const frame = syntheticFrame(640, 480, 42)
  const empty = createPipeline({})
  const two = createPipeline({})
  two.addStage(exposureGainStage(0.5))
  two.addStage(lutStage(gammaLut(2.2)))
  console.log('— Pipeline (CPU executor, 640×480) —')
  bench('empty pipeline apply (passthrough)', 500, () => empty.apply(frame))
  bench('exposure-gain + LUT (2 stages)', 60, () => two.apply(frame))
}

/* ------------------------------------------------------ 4. EIS feed ------ */

{
  const frames = Array.from({ length: 12 }, (_, i) => lumaPlane(syntheticFrame(640, 480, 60 + i)))
  console.log('— Stabilizer feed (640×480 luma per frame) —')
  const stabilizer = createStabilizer()
  let i = 0
  bench('createStabilizer().feed per frame', 60, () => { stabilizer.feed(frames[i++ % frames.length]) })
}

/* ------------------------------------------------------- 5. portrait ----- */

{
  const frame = syntheticFrame(512, 384, 7)
  const mask = { data: new Float32Array(128 * 96).map((_, i) => (i % 128 < 64 ? 1 : 0)), width: 128, height: 96 }
  console.log('— Portrait blur consumer (512×384, model-size mask 128×96) —')
  bench('applyPortrait (blur ×3 passes + feather + composite)', 10, () => applyPortrait(frame, mask))
}

/* ----------------------------------------------------------- 6. muxer ---- */

{
  const chunks = Array.from({ length: 300 }, (_, i) => ({
    data: new Uint8Array(8_000).fill(i & 0xFF), timestampMs: i * 33.3, keyframe: i % 30 === 0,
  }))
  console.log('— WebM mux (300 chunks × 8 KB ≈ 10 s of video) —')
  bench('muxWebm', 40, () => muxWebm({ codec: 'vp8', width: 1280, height: 720, frames: chunks }))
}

/* ------------------------------------------- 7. capture path with fakes -- */

{
  console.log('— Capture path over fake hardware (orchestration cost only) —')
  const env = androidChromeLike()
  const opened = await openSession({ facing: 'back' }, { env })
  const source = createFrameSource(opened.session, { env })
  const samples = []
  for (let i = 0; i < 100; i++) {
    const t0 = performance.now()
    await source.captureStill()
    samples.push(performance.now() - t0)
  }
  console.log('  captureStill (takePhoto path, fake ImageCapture)')
  console.log(`    n=100  median=${fmt(percentile(samples, 50))}  p90=${fmt(percentile(samples, 90))}  ` +
    `p99=${fmt(percentile(samples, 99))}  [ms]`)
  const openSamples = []
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now()
    const r = await openSession({ facing: 'back' }, { env })
    openSamples.push(performance.now() - t0)
    r.session.release()
  }
  console.log('  openSession → live (fake getUserMedia)')
  console.log(`    n=50  median=${fmt(percentile(openSamples, 50))}  p90=${fmt(percentile(openSamples, 90))}  ` +
    `p99=${fmt(percentile(openSamples, 99))}  [ms]`)
  opened.session.release()
}

console.log('\n  Node isolates algorithm cost; real-device numbers (sensor')
console.log('  bring-up, GPU upload, codec) live in the manual matrix —')
console.log('  see docs/ai-camera/benchmark-report.md.')
console.log('========================================\n')
