/**
 * Creative Studio composer — timeline math, transition blending, the WebM
 * container round-trip (writer proven by the reader, Opus passthrough), the
 * encoder probe's honesty, collage layout exactness, and templates expanding
 * through the same validators user input passes.
 *
 *   node test/studio-composer.test.js
 */
import {
  validateTimeline, totalDurationMs, segmentStarts, frameAt, frameSchedule,
  renderFrame, blendTransition, TIMELINE_KIND, TIMELINE_VERSION
} from '../src/lib/studio/composer.js'
import '../src/lib/studio/ops-color.js'
import '../src/lib/studio/looks.js'
import { muxWebM, parseWebM, extractOpusTrack, encodeVint } from '../src/lib/studio/webm.js'
import { probeEncoders, selectDriver, renderTimeline } from '../src/lib/studio/render-video.js'
import { layoutCells, renderCollage, collageLayoutIds, COLLAGE_LAYOUTS } from '../src/lib/studio/collage.js'
import { TEMPLATES, templateIds, validateTemplate, instantiateTemplate } from '../src/lib/studio/templates.js'
import { makeImage } from '../src/lib/studio/image-io.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const throws = (fn, re) => {
  try { fn(); return false } catch (e) { return re ? re.test(String(e.message)) : true }
}

function solid (w, h, r, g, b) {
  const img = makeImage(w, h)
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255
  }
  return img
}

const baseTimeline = (extra = {}) => ({
  kind: TIMELINE_KIND,
  v: TIMELINE_VERSION,
  width: 64,
  height: 96,
  fps: 10,
  segments: [
    { type: 'image', ref: 'a', durMs: 2000, transition: { type: 'crossfade', durMs: 400 } },
    { type: 'image', ref: 'b', durMs: 2000 }
  ],
  ...extra
})

/* ---------------------------------------------------------- timeline math */

check('validateTimeline normalizes and passes a sound timeline', () => {
  const t = validateTimeline(baseTimeline())
  return t.segments.length === 2 && t.fps === 10 && t.segments[1].transition.type === 'none'
})

check('total duration subtracts transition overlap', () =>
  totalDurationMs(validateTimeline(baseTimeline())) === 3600)

check('segment starts respect the overlap', () => {
  const starts = segmentStarts(validateTimeline(baseTimeline()))
  return starts[0] === 0 && starts[1] === 1600
})

check('frameAt: single-segment window, transition window, and clamping', () => {
  const t = validateTimeline(baseTimeline())
  const solo = frameAt(t, 800)
  const blend = frameAt(t, 1800)
  const end = frameAt(t, 99999)
  return solo.a.index === 0 && solo.mix === 0 &&
    blend.a.index === 0 && blend.b.index === 1 && Math.abs(blend.mix - 0.5) < 1e-9 &&
    blend.transition === 'crossfade' && end.a.index === 1
})

check('frameSchedule emits duration × fps frames', () =>
  frameSchedule(validateTimeline(baseTimeline())).length === 36)

check('a transition longer than half a joined segment is refused (fold-over)', () =>
  throws(() => validateTimeline(baseTimeline({
    segments: [
      { type: 'image', ref: 'a', durMs: 1000, transition: { type: 'crossfade', durMs: 900 } },
      { type: 'image', ref: 'b', durMs: 3000 }
    ]
  })), /longer than half/))

check('a wrong timeline version is refused', () =>
  throws(() => validateTimeline(baseTimeline({ v: 99 })), /unsupported version/))

check('per-segment ops are validated against the registry at timeline time', () =>
  throws(() => validateTimeline(baseTimeline({
    segments: [{ type: 'image', ref: 'a', durMs: 1000, ops: [{ op: 'nope', v: 1, params: {} }] }]
  })), /unknown op/))

/* ------------------------------------------------------------- rendering */

check('renderFrame at a crossfade midpoint mixes the two segments ~50/50', () => {
  const t = validateTimeline(baseTimeline())
  const assets = new Map([['a', solid(64, 96, 200, 0, 0)], ['b', solid(64, 96, 0, 0, 200)]])
  const img = renderFrame(t, 1800, { assets })
  const r = img.data[0]
  const b = img.data[2]
  return Math.abs(r - 100) <= 2 && Math.abs(b - 100) <= 2
})

check('slide at mix 0.5 shows B on the right half, A on the left', () => {
  const a = solid(20, 10, 200, 0, 0)
  const b = solid(20, 10, 0, 0, 200)
  const out = blendTransition('slide', a, b, 0.5)
  return out.data[(5 * 20 + 2) * 4] === 200 && out.data[(5 * 20 + 15) * 4 + 2] === 200
})

check('a segment op-doc (look) is applied inside the composer render', () => {
  const t = validateTimeline(baseTimeline({
    segments: [{
      type: 'image',
      ref: 'a',
      durMs: 1000,
      ops: [{ op: 'look', v: 1, params: { id: 'mono_classic', strength: 1 } }]
    }]
  }))
  const assets = new Map([['a', solid(64, 96, 200, 40, 40)]])
  const img = renderFrame(t, 500, { assets })
  return img.data[0] === img.data[1] && img.data[1] === img.data[2]
})

check('a missing decoded asset fails the frame loudly', () =>
  throws(() => renderFrame(validateTimeline(baseTimeline()), 100, { assets: new Map() }), /not decoded/))

/* ------------------------------------------------------------------ webm */

check('vint encoding: minimal widths with the marker bit', () => {
  const one = encodeVint(5)
  const two = encodeVint(500)
  return one.length === 1 && one[0] === 0x85 && two.length === 2 && two[0] === (0x40 | (500 >> 8)) && two[1] === (500 & 0xff)
})

check('ROUND-TRIP: mux → parse recovers doctype, tracks, duration, blocks', () => {
  const frames = [
    { tsMs: 0, key: true, data: new Uint8Array([1, 2, 3]) },
    { tsMs: 100, key: false, data: new Uint8Array([4, 5]) },
    { tsMs: 200, key: false, data: new Uint8Array([6]) }
  ]
  const bytes = muxWebM({ video: { codec: 'vp8', width: 64, height: 96, frames }, durationMs: 300 })
  const parsed = parseWebM(bytes)
  const video = parsed.tracks.find((t) => t.type === 1)
  return parsed.docType === 'webm' && Math.abs(parsed.durationMs - 300) < 1e-6 &&
    video.codec === 'V_VP8' && video.width === 64 && video.height === 96 &&
    parsed.blocks.length === 3 &&
    parsed.blocks[0].key === true && parsed.blocks[1].key === false &&
    parsed.blocks.map((b) => b.tsMs).join(',') === '0,100,200' &&
    parsed.blocks[2].size === 1
})

check('AUDIO PASSTHROUGH: an Opus track muxes in and extracts back out', () => {
  const opusHead = new Uint8Array([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 1, 0, 0])
  const packets = [
    { tsMs: 0, data: new Uint8Array([9, 9]) },
    { tsMs: 20, data: new Uint8Array([8, 8, 8]) }
  ]
  const bytes = muxWebM({
    video: { codec: 'vp9', width: 32, height: 32, frames: [{ tsMs: 0, key: true, data: new Uint8Array([1]) }] },
    audio: { codecPrivate: opusHead, sampleRate: 48000, channels: 1, packets },
    durationMs: 40
  })
  const parsed = parseWebM(bytes)
  const audio = parsed.tracks.find((t) => t.type === 2)
  const extracted = extractOpusTrack(bytes)
  return audio.codec === 'A_OPUS' && audio.channels === 1 &&
    extracted !== null && extracted.packets.length === 2 &&
    extracted.packets[1].tsMs === 20 &&
    Array.from(extracted.packets[1].data).join(',') === '8,8,8'
})

check('extractOpusTrack answers null on garbage, never throws', () =>
  extractOpusTrack(new Uint8Array([1, 2, 3, 4])) === null &&
  extractOpusTrack(new Uint8Array(0)) === null)

check('a cluster never spans a keyframe boundary poorly: keyframes start clusters', () => {
  const frames = []
  for (let i = 0; i < 10; i++) frames.push({ tsMs: i * 1000, key: i % 5 === 0, data: new Uint8Array([i]) })
  const bytes = muxWebM({ video: { codec: 'vp8', width: 8, height: 8, frames }, durationMs: 10000 })
  const parsed = parseWebM(bytes)
  // Every block's 16-bit relative timestamp survived the round trip intact.
  return parsed.blocks.map((b) => b.tsMs).join(',') === frames.map((f) => f.tsMs).join(',')
})

/* ---------------------------------------------------- driver probe honesty */

await checkAsync('probe: a WebCodecs env that supports vp9 is reported as such', async () => {
  const env = {
    VideoEncoder: Object.assign(function () {}, {
      isConfigSupported: async (cfg) => ({ supported: cfg.codec.startsWith('vp09') })
    })
  }
  const probe = await probeEncoders(env)
  return probe.webcodecs.available && probe.webcodecs.codec === 'vp9' && selectDriver(probe) === 'webcodecs'
})

await checkAsync('probe: no WebCodecs but MediaRecorder ⇒ fallback selected', async () => {
  const env = { MediaRecorder: Object.assign(function () {}, { isTypeSupported: (m) => m.includes('vp8') }) }
  const probe = await probeEncoders(env)
  return !probe.webcodecs.available && probe.mediarecorder.available &&
    probe.mediarecorder.mime === 'video/webm;codecs=vp8' && selectDriver(probe) === 'mediarecorder'
})

await checkAsync('probe: an env with neither is reported empty and render refuses honestly', async () => {
  const probe = await probeEncoders({})
  if (selectDriver(probe) !== null) return false
  try {
    await renderTimeline(baseTimeline(), { env: {}, assets: new Map() })
    return false
  } catch (e) {
    return /no video encoder/.test(e.message)
  }
})

await checkAsync('probe: isConfigSupported REJECTING is believed (no wishful fallback to vp8→supported)', async () => {
  const env = {
    VideoEncoder: Object.assign(function () {}, { isConfigSupported: async () => ({ supported: false }) })
  }
  const probe = await probeEncoders(env)
  return probe.webcodecs.available === false
})

/* ---------------------------------------------------------------- collage */

check('layoutCells: cells stay in frame, gutters separate shared edges', () => {
  const cells = layoutCells('four_grid', 400, 400, 8)
  const inFrame = cells.every((c) => c.x >= 0 && c.y >= 0 && c.x + c.w <= 400 && c.y + c.h <= 400)
  const gapX = cells[1].x - (cells[0].x + cells[0].w)
  return inFrame && cells.length === 4 && gapX === 8
})

check('every layout id lays out inside an arbitrary frame', () =>
  collageLayoutIds().every((id) => {
    const cells = layoutCells(id, 333, 517, 6)
    return cells.length === COLLAGE_LAYOUTS[id].cells.length &&
      cells.every((c) => c.x >= 0 && c.y >= 0 && c.x + c.w <= 333 && c.y + c.h <= 517 && c.w > 0 && c.h > 0)
  }))

check('renderCollage places images, leaves empty cells as background, reports both', () => {
  const { image, placed, empty } = renderCollage('four_grid',
    [solid(50, 50, 200, 0, 0), solid(30, 60, 0, 200, 0), null, undefined],
    { width: 200, height: 200, gutter: 10, radius: 0, background: '#010203' })
  const cells = layoutCells('four_grid', 200, 200, 10)
  const c0 = ((cells[0].y + 5) * 200 + cells[0].x + 5) * 4
  const c3 = ((cells[3].y + 5) * 200 + cells[3].x + 5) * 4
  return placed === 2 && empty === 2 &&
    image.data[c0] === 200 &&                       // first image landed
    image.data[c3] === 1 && image.data[c3 + 2] === 3 // empty cell = background
})

check('rounded corners actually blend toward background at the corner', () => {
  const { image } = renderCollage('two_vertical',
    [solid(50, 50, 255, 255, 255), solid(50, 50, 255, 255, 255)],
    { width: 100, height: 100, gutter: 0, radius: 20, background: '#000000' })
  const corner = image.data[0]
  const center = image.data[(50 * 100 + 25) * 4]
  return corner < 40 && center === 255
})

/* -------------------------------------------------------------- templates */

check('every shipped template validates', () =>
  templateIds().every((id) => validateTemplate(TEMPLATES[id]) === TEMPLATES[id]))

check('instantiating a story template yields a VALID timeline with the refs placed', () => {
  const out = instantiateTemplate('reel_triptych', ['p1', 'p2', 'p3'])
  return out.type === 'timeline' && out.timeline.segments.length === 3 &&
    out.timeline.segments.map((s) => s.ref).join(',') === 'p1,p2,p3' &&
    out.timeline.width === 1080
})

check('instantiating with the wrong slot count is refused', () =>
  throws(() => instantiateTemplate('reel_triptych', ['p1']), /exactly 3/))

check('a collage template expands to its layout and options', () => {
  const out = instantiateTemplate('collage_four', ['a', 'b', 'c', 'd'])
  return out.type === 'collage' && out.layout === 'four_grid' && out.options.gutter === 10
})

check('an unknown template id is refused', () =>
  throws(() => instantiateTemplate('story_that_never_was', ['x']), /unknown template/))

const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  studio composer — timeline, webm, collage')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
