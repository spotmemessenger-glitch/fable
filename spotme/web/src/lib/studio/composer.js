/**
 * Spot Me — Creative Studio composer: the stories/reels timeline.
 *
 * A timeline is DATA (like the op-doc): an output format plus an ordered list
 * of segments — image or video, each with a duration, an optional per-segment
 * op list (rendered through the SAME evaluator as single-photo edits), an
 * optional Ken Burns move — and a transition into the next segment. All
 * timing math is pure and unit-tested; pixel work happens in renderFrame(),
 * which is CPU-real (deterministic, Node-testable) and is what the video
 * drivers (render-video.js) call per frame.
 *
 * Transitions are real compositing math: crossfade (linear mix), slide
 * (push with sub-pixel sampling), zoom (scale-in cross-blend). The GPU
 * transition path would need a second texture unit in the minimal GL runtime,
 * so transitions render on CPU today — an optimization seam, not a fake.
 *
 * Video segments hold a source ref plus trim points; DECODING them needs a
 * browser (<video> seek or WebCodecs VideoDecoder) and lives in
 * render-video.js. Everything about them here — trim math, scheduling,
 * validation — is environment-free.
 */

import { validateOp, createEvaluator } from './evaluator.js'
import { coverResize, resizeBilinear } from './composite.js'
import { makeImage, isImage } from './image-io.js'
import { num } from './ops-color.js'

export const TIMELINE_KIND = 'spotme-studio-timeline'
export const TIMELINE_VERSION = 1

export const MAX_SEGMENTS = 50
export const MAX_DURATION_MS = 5 * 60_000
export const MIN_SEGMENT_MS = 300
export const TRANSITIONS = Object.freeze(['none', 'crossfade', 'slide', 'zoom'])

/* -------------------------------------------------------------- validation */

export function validateTimeline (t) {
  if (!t || typeof t !== 'object') throw new TypeError('timeline: not an object')
  if (t.kind !== TIMELINE_KIND) throw new Error('timeline: wrong kind')
  if (t.v !== TIMELINE_VERSION) throw new Error(`timeline: unsupported version ${t.v}`)
  const width = Math.trunc(num(t.width, 'timeline.width', 16, 4096))
  const height = Math.trunc(num(t.height, 'timeline.height', 16, 4096))
  const fps = Math.trunc(num(t.fps, 'timeline.fps', 1, 60, 30))
  if (!Array.isArray(t.segments) || t.segments.length === 0 || t.segments.length > MAX_SEGMENTS) {
    throw new RangeError(`timeline: 1..${MAX_SEGMENTS} segments required`)
  }
  const segments = t.segments.map((s, i) => {
    const name = `segment[${i}]`
    if (!s || typeof s !== 'object') throw new TypeError(`${name}: not an object`)
    if (s.type !== 'image' && s.type !== 'video') throw new RangeError(`${name}.type must be image|video`)
    if (typeof s.ref !== 'string' || !s.ref) throw new TypeError(`${name}.ref must be an asset id`)
    const durMs = Math.trunc(num(s.durMs, `${name}.durMs`, MIN_SEGMENT_MS, MAX_DURATION_MS))
    const out = { type: s.type, ref: s.ref, durMs }
    if (s.type === 'video') {
      out.startMs = Math.trunc(num(s.startMs, `${name}.startMs`, 0, MAX_DURATION_MS, 0))
      out.muted = s.muted !== false
    }
    if (s.ops !== undefined) {
      if (!Array.isArray(s.ops) || s.ops.length > 32) throw new RangeError(`${name}.ops: at most 32 ops`)
      s.ops.forEach((op) => validateOp(op))          // registry-checked, params normalized at render
      out.ops = s.ops
    }
    if (s.kenBurns !== undefined) {
      const kb = s.kenBurns
      out.kenBurns = {
        from: checkView(kb?.from, `${name}.kenBurns.from`),
        to: checkView(kb?.to, `${name}.kenBurns.to`)
      }
    }
    const tr = s.transition === undefined ? { type: 'none', durMs: 0 } : s.transition
    if (!TRANSITIONS.includes(tr.type)) throw new RangeError(`${name}.transition.type must be ${TRANSITIONS.join('|')}`)
    const trDur = tr.type === 'none' ? 0 : Math.trunc(num(tr.durMs, `${name}.transition.durMs`, 100, 3000, 400))
    out.transition = { type: tr.type, durMs: trDur }
    return out
  })
  // A transition overlaps the two segments it joins; it cannot be longer than
  // half of either or the schedule folds over itself.
  for (let i = 0; i < segments.length - 1; i++) {
    const tr = segments[i].transition
    if (tr.durMs > segments[i].durMs / 2 || tr.durMs > segments[i + 1].durMs / 2) {
      throw new RangeError(`segment[${i}].transition longer than half a joined segment`)
    }
  }
  const total = totalDurationMs({ segments })
  if (total > MAX_DURATION_MS) throw new RangeError('timeline: total duration over 5 minutes')
  const out = { kind: TIMELINE_KIND, v: TIMELINE_VERSION, width, height, fps, segments }
  if (t.audio !== undefined) {
    if (typeof t.audio?.ref !== 'string' || !t.audio.ref) throw new TypeError('timeline.audio.ref must be an asset id')
    out.audio = { ref: t.audio.ref }
  }
  return out
}

function checkView (v, name) {
  return {
    x: num(v?.x, `${name}.x`, 0, 1, 0.5),
    y: num(v?.y, `${name}.y`, 0, 1, 0.5),
    scale: num(v?.scale, `${name}.scale`, 1, 3, 1)
  }
}

/* ------------------------------------------------------------- timing math */

/** Total play time: segment durations minus transition overlaps. */
export function totalDurationMs ({ segments }) {
  let total = 0
  for (let i = 0; i < segments.length; i++) {
    total += segments[i].durMs
    if (i < segments.length - 1) total -= segments[i].transition?.durMs || 0
  }
  return total
}

/** Segment start times on the composed axis (transition-overlapped). */
export function segmentStarts ({ segments }) {
  const starts = []
  let at = 0
  for (let i = 0; i < segments.length; i++) {
    starts.push(at)
    at += segments[i].durMs - (i < segments.length - 1 ? segments[i].transition?.durMs || 0 : 0)
  }
  return starts
}

/**
 * What is on screen at time t: one segment, or two blended by a transition.
 * → { a: {index, tMs}, b?: {index, tMs}, mix, transition } where tMs is local
 * time inside each segment and mix ∈ (0,1] is b's weight.
 */
export function frameAt (timeline, tMs) {
  const { segments } = timeline
  const starts = segmentStarts(timeline)
  const total = totalDurationMs(timeline)
  const t = Math.max(0, Math.min(total - 1e-6, tMs))
  let i = segments.length - 1
  for (let k = 0; k < segments.length; k++) {
    if (t < starts[k] + segments[k].durMs - (k < segments.length - 1 ? segments[k].transition.durMs : 0) ||
        k === segments.length - 1) { i = k; break }
  }
  const local = t - starts[i]
  const tr = segments[i].transition
  const trStart = segments[i].durMs - tr.durMs
  if (i < segments.length - 1 && tr.type !== 'none' && local >= trStart) {
    const p = (local - trStart) / tr.durMs
    return {
      a: { index: i, tMs: local },
      b: { index: i + 1, tMs: local - trStart },
      mix: Math.min(1, Math.max(0, p)),
      transition: tr.type
    }
  }
  return { a: { index: i, tMs: local }, mix: 0, transition: 'none' }
}

/** Every output frame's timestamp for the whole timeline. */
export function frameSchedule (timeline) {
  const total = totalDurationMs(timeline)
  const step = 1000 / timeline.fps
  const out = []
  for (let t = 0; t < total; t += step) out.push(Math.round(t * 1000) / 1000)
  return out
}

/* ------------------------------------------------------------ frame render */

const defaultEvaluator = createEvaluator()

/** Ken Burns viewport at progress p → normalized center+scale. */
function kbAt (kb, p) {
  if (!kb) return { x: 0.5, y: 0.5, scale: 1 }
  const e = p * p * (3 - 2 * p)                     // ease in-out
  return {
    x: kb.from.x + (kb.to.x - kb.from.x) * e,
    y: kb.from.y + (kb.to.y - kb.from.y) * e,
    scale: kb.from.scale + (kb.to.scale - kb.from.scale) * e
  }
}

/** Render one segment's still at local time → frame-sized image. */
function renderSegmentStill (timeline, seg, tMs, deps) {
  const { width: W, height: H } = timeline
  const source = deps.frames?.get?.(seg.ref) || deps.assets?.get?.(seg.ref)
  if (!isImage(source)) throw new Error(`composer: asset ${seg.ref} not decoded for render`)
  const p = Math.min(1, Math.max(0, tMs / seg.durMs))
  const view = kbAt(seg.kenBurns, p)
  // Cover the frame, then crop the Ken Burns viewport with bilinear sampling:
  // scale>1 zooms in about (x, y).
  const base = coverResize(source, W, H)
  let frame = base
  if (view.scale > 1.001 || Math.abs(view.x - 0.5) > 1e-3 || Math.abs(view.y - 0.5) > 1e-3) {
    const vw = W / view.scale
    const vh = H / view.scale
    const x0 = Math.min(W - vw, Math.max(0, view.x * W - vw / 2))
    const y0 = Math.min(H - vh, Math.max(0, view.y * H - vh / 2))
    const crop = makeImage(Math.max(1, Math.round(vw)), Math.max(1, Math.round(vh)))
    for (let y = 0; y < crop.height; y++) {
      const sy = Math.min(H - 1, Math.round(y0) + y)
      const src = (sy * W + Math.round(x0)) * 4
      crop.data.set(base.data.subarray(src, src + crop.width * 4), y * crop.width * 4)
    }
    frame = resizeBilinear(crop, W, H)
  }
  if (seg.ops?.length) {
    const evaluator = deps.evaluator || defaultEvaluator
    frame = evaluator.render(frame, seg.ops, { assets: deps.assets, quality: 'export' }).image
  }
  return frame
}

/** The three real transitions, CPU compositing. */
export function blendTransition (type, a, b, mix) {
  const { width: w, height: h } = a
  const out = makeImage(w, h)
  if (type === 'crossfade' || type === 'zoom') {
    const src = type === 'zoom' ? resizeBilinear(zoomInto(b, 1.15 - 0.15 * mix), w, h) : b
    for (let i = 0; i < out.data.length; i += 4) {
      for (let c = 0; c < 3; c++) out.data[i + c] = a.data[i + c] * (1 - mix) + src.data[i + c] * mix + 0.5
      out.data[i + 3] = 255
    }
    return out
  }
  if (type === 'slide') {
    const shift = Math.round(mix * w)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4
        const fromB = x >= w - shift
        const sx = fromB ? x - (w - shift) : x + shift
        const src = fromB ? b : a
        const si = (y * w + Math.min(w - 1, sx)) * 4
        out.data[o] = src.data[si]
        out.data[o + 1] = src.data[si + 1]
        out.data[o + 2] = src.data[si + 2]
        out.data[o + 3] = 255
      }
    }
    return out
  }
  return mix >= 0.5 ? b : a          // 'none' mid-blend should not happen; be safe
}

function zoomInto (img, scale) {
  const w = img.width
  const h = img.height
  const vw = Math.max(1, Math.round(w / scale))
  const vh = Math.max(1, Math.round(h / scale))
  const x0 = Math.floor((w - vw) / 2)
  const y0 = Math.floor((h - vh) / 2)
  const crop = makeImage(vw, vh)
  for (let y = 0; y < vh; y++) {
    const src = ((y0 + y) * w + x0) * 4
    crop.data.set(img.data.subarray(src, src + vw * 4), y * vw * 4)
  }
  return crop
}

/**
 * Render the composed frame at absolute time t.
 * deps: { assets: Map<id, image>, frames?: Map<id, image> (video frames the
 * driver decoded for THIS timestamp), evaluator? }
 */
export function renderFrame (timeline, tMs, deps = {}) {
  const at = frameAt(timeline, tMs)
  const segA = timeline.segments[at.a.index]
  const a = renderSegmentStill(timeline, segA, at.a.tMs, deps)
  if (!at.b) return a
  const segB = timeline.segments[at.b.index]
  const b = renderSegmentStill(timeline, segB, at.b.tMs, deps)
  return blendTransition(at.transition, a, b, at.mix)
}
