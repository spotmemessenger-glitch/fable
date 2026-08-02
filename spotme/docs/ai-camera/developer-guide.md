# Camera engine — developer guide (the contracts, precisely)

For missions 2–4 and the wiring PR. Import surface:
`web/src/lib/camera/index.js`. Everything returns availability envelopes:

```js
{ available: true, ...facts }                    // real
{ available: false, reason, detail? }            // reason ∈ CAMERA_UNAVAILABLE
```

Check `available` before touching facts; surface `reason` to users —
the closed set is in `availability.js` and every code means one sentence.

## The engine

```js
import { createCameraEngine } from '.../lib/camera/index.js'
const engine = createCameraEngine({ flags, env?, clock? })
```

- Shipped defaults ⇒ the INERT STUB: `enabled === false`, every method
  answers `FLAG_DISABLED`, nothing is constructed. Write call sites
  against this shape first — it is the shipped state.
- `flags` is explicit overrides over `DEFAULT_FLAGS`; unknown names THROW.
  A child flag is effective only when its whole parent chain is true.
- `env`/`clock` default to `globalThis`/real timers; tests inject fakes.
- Live surface: `listDevices() · openSession(sel) · createFrameSource ·
  createPipeline · segmenters · availability(session?) · metrics()` plus
  gated namespaces `hdr · night · portrait · video · timelapse · slowmo ·
  burst · stabilization · proControls`, each answering `FLAG_DISABLED`
  (with the flag named in `detail`) while its flag is dark.

## Sessions

```js
const opened = await engine.openSession({ facing: 'back' /* or deviceId, width… */ })
if (!opened.available) return show(opened.reason)      // PERMISSION_DENIED, CAMERA_BUSY…
const session = opened.session                          // opened.openedInMs measured
```

- `session.stream · track() · settings() · facing() · capabilities() ·
  state() · switchTo(sel) · release() · onReleased(fn) · pro.*`
- `switchTo` reports `strategy: 'warm'|'cold'` + `switchedInMs`. If both
  strategies fail the session is RELEASED (never a zombie).
- **`release()` is your job on every exit path** — it stops every track
  (the camera light). Idempotent; the OS ending the track also releases.
- `pro.setTorch/setZoom/setExposureCompensation/…` each verify the LIVE
  `MediaTrackCapabilities` first: absent control ⇒
  `NOT_IN_TRACK_CAPABILITIES`; out of range ⇒ same reason, `detail:
  'out of range'`. Never render a control without checking
  `session.capabilities()`.

## FrameSource — SEAM #1 (missions 2–3 consume this)

```js
const source = engine.createFrameSource(session)
const sub = source.subscribeFrames(async ({ frame, ts, mediaTs, width, height, seq, dropped }) => {
  // frame: VideoFrame | ImageBitmap | {data,width,height,close()} per pump
}, { fps: 10 })
if (!sub.available) …                                   // NO_FRAME_PUMP in bare envs
…
sub.unsubscribe()
```

THE RULES, in blood:

1. **Ownership:** the delivered `frame` is valid ONLY until your callback
   resolves (return a promise to extend across your await chain). The
   source closes it afterwards. **Never call `frame.close()` yourself;
   never retain the handle.** Need pixels later? Copy:
   `await createImageBitmap(frame)` — then YOU own (and close) the copy.
2. **Backpressure is drop-oldest:** while your callback runs, newer frames
   replace the single pending slot. You always get the FRESHEST next
   frame; `dropped` says how many you missed. A model that takes 80 ms
   simply sees ~12 fps with dropped counts — it can never stall the
   camera or receive stale frames.
3. **`fps`** throttles deliveries per subscriber (camera keeps its own
   rate). Multiple subscribers are independent.
4. **Timestamps:** `ts` = engine clock ms at delivery; `mediaTs` = the
   frame's media timestamp in ms where the pump has one
   (track-processor), else null.
5. `pumpKind()` ∈ `PUMP.{TRACK_PROCESSOR,RVFC,INTERVAL_CANVAS}` — labeled
   truth, useful for capability-dependent model choices.
6. `stats()` → `{framesIn, framesDelivered, framesDropped, firstFrameMs}`.

```js
const shot = await source.captureStill()
// shot.path ∈ STILL_PATH.{TAKE_PHOTO, GRAB_FRAME, CANVAS_DRAW} — always
// labeled; CANVAS_DRAW means STREAM resolution (the iOS reality).
```

`source.stop()` ends everything; a released session stops its sources.

## Pipeline — SEAM #2 (mission 3 adds stages here)

```js
const pipeline = engine.createPipeline({ canvas? })     // canvas ⇒ tries WebGL2
pipeline.mode()                                         // 'webgl2' | 'cpu' — REPORTED, not guessed
pipeline.addStage(stage, index?)                        // envelope; duplicates refused
pipeline.apply(imageData, overrides?, clock?)           // CPU semantics + per-stage cost
pipeline.runGl(source, overrides?)                      // GL draw; refuses in CPU mode
```

A stage:

```js
{
  name: 'unique-name',
  params: { … },                                        // defaults, overridable per apply
  cpu (image, params) { return newImage },              // PURE: fresh buffer, input untouched
  glsl: {                                               // optional GL twin
    fragment: '#version 300 es …',                      // sees u_frame, v_uv; writes outColor
    uniforms: (params) => ({ u_x: 1.0, u_lut: Uint8Array(1024) /* 256×1 RGBA texture */ }),
  },
}
```

- Zero stages = passthrough returning the SAME object.
- A GL-only stage added to a CPU pipeline is REFUSED (`NO_WEBGL2`) — write
  a CPU twin or accept absence; silent skipping is banned.
- Shaders compile at `addStage` (broken GLSL fails the add, not frame 1).
- Reference stages to copy: `exposureGainStage`, `lutStage` in
  `stages.js`; `stabilizerStage` shows a stateful-filter stage;
  `portraitBlurStageGl` shows a mask-texture stage.

## ISegmenter — SEAM #3 (portrait/beauty engines)

```js
engine.segmenters.register({
  name: 'mediapipe-selfie',                             // or 'native-depth'
  kind: 'ml',                                           // 'ml' | 'depth'
  async segment (image /* {data,width,height} */) {
    return { mask: { data: Float32Array /* 0..1, 1 = person */, width, height } }
    // mask MAY be model-sized (e.g. 256×256); consumers upsample+feather
  },
  release () { /* free the model */ },
})
```

- No engine registered ⇒ portrait is `NO_SEGMENTER_REGISTERED` — do not
  fake one; the dependency decision is the owner's (ADR-014a §4).
- A throwing/malformed engine becomes `FAILED` with the engine named;
  capture never crashes.
- Consumers: `engine.portrait.render(image, {blurRadius, passes, feather})`
  (segment + masked blur) or `applyMask` with your own mask.

## Algorithms (pure, importable anywhere, no flags needed for math)

- `fuseExposures(images, opts)` — Mertens fusion over same-geometry RGBA.
- `stackFrames(frames, {mode, motionThreshold})` — aligned night stack.
- `estimateShift(refLuma, movedLuma)` — `{dx, dy, confidence}`; convention:
  moved ≈ reference translated by (dx,dy); align by shifting moved by
  (−dx,−dy). Respect `MIN_SHIFT_CONFIDENCE` and the `flat` texture gate.
- `createStabilizer().feed(luma)` → clamped per-frame correction;
  `stabilizeFrame` applies with a constant centre crop.
- `muxWebm({codec, width, height, frames})` for WebCodecs chunks;
  `assembleFrames` picks webcodecs-webm vs canvas-replay and LABELS it.

## Capture recipes

```js
// HDR still (only where real):
const hdrOk = engine.hdr.availability(session)          // NO_EXPOSURE_CONTROL on iOS
const bracket = await engine.hdr.captureBracket(session, source, { evs: [-2, 0, 2] })
const fused = engine.hdr.fuse(decodedImageDataFrames)   // decode blobs first (createImageBitmap→canvas)

// Burst (you own the bitmaps):
const burst = await engine.burst.capture(session, source, { count: 8 })
… pick one …
engine.burst.release(burst)                             // ALWAYS

// Slow-mo:
const prep = await engine.slowmo.prepare(session)       // NO_HIGH_FPS_MODE on 60fps devices
const take = engine.slowmo.capture(source, { captureFps: prep.captureFps })
const captured = await take.stop()
const video = await engine.slowmo.assemble(captured, { slowFactor: prep.slowFactor })
```

## Testing your consumer

Copy the suites' pattern: platform presets from
`test/helpers/fake-media.js` (`androidChromeLike()`, `iosSafariLike()`,
`desktopLike()`), `manualClock()` for time, `track.emitFrame(new
FakeVideoFrame({...}))` to drive frames, and assert against availability
envelopes. Determinism rule: if your test sleeps real time (other than a
0 ms settle), it is wrong.

## The fence (read before adding files)

`test/camera-fence.test.js` will fail your PR if: an app file imports the
module while dark, a flag defaults true, any lib/camera file gains a
network/storage call shape or a package import, a file crosses 500 lines,
or a module ships without a test importing it. These are the platform's
load-bearing promises — extend the fence for new files, never delete it.
