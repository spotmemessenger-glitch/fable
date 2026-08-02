# Camera engine — what is real, where (mission CAM-1)

The module: `web/src/lib/camera/`. Everything ships dark
(`flags.js`, all false, fence-enforced). This page is the per-feature,
per-platform truth table — the same answers `engine.availability()` gives
at runtime, written down.

Platforms as probed by `capabilities.js` (and simulated in
`test/helpers/fake-media.js`):

- **Android Chrome-class** — ImageCapture, MediaStreamTrackProcessor,
  WebCodecs, webm recording; capable devices expose torch/zoom/exposure/
  ISO/high-fps in MediaTrackCapabilities (varies per device — probed live,
  never assumed).
- **iOS Safari-class** — no ImageCapture, no track processor, minimal
  track capabilities, mp4 recording, rVFC present.
- **Desktop Chromium-class** — ImageCapture + WebCodecs, webcam without
  torch/exposure, ≤60fps.

| Feature | Android-class | iOS-class | Desktop-class | Notes |
|---|---|---|---|---|
| Startup (open/switch/release) | REAL | REAL | REAL | warm switch (open-before-close) with cold fallback; every wait bounded; release stops every track |
| Frame pump | REAL `track-processor` | REAL `rvfc` | REAL `track-processor` | labeled; none ⇒ `NO_FRAME_PUMP` |
| Still capture | REAL `takePhoto` (sensor res) | REAL `canvas-draw` (STREAM res, labeled) | REAL `takePhoto` | path always in the result |
| HDR (bracket + Mertens fusion) | REAL where track has `exposureCompensation` | `NO_EXPOSURE_CONTROL` | `NO_EXPOSURE_CONTROL` (typical webcams) | fusion math itself runs anywhere; bracketing never fakes |
| Night (align + stack + reject) | REAL | REAL | REAL | pure math; longer exposure via pro controls where the track allows |
| Portrait | `NO_SEGMENTER_REGISTERED` | `NO_SEGMENTER_REGISTERED` | `NO_SEGMENTER_REGISTERED` | seam + blur consumer REAL; engine = owner decision (MediaPipe) or P10 depth |
| RAW/DNG | `DEFERRED_NATIVE` | `DEFERRED_NATIVE` | `DEFERRED_NATIVE` | web has no sensor-RAW path at all; P10 adapter contract in ADR-014a §3 |
| Burst | REAL `grabFrame` | REAL `frame-pump` (labeled) | REAL `grabFrame` | hard memory budget, truncation reported |
| Video recording | REAL webm (negotiated) | REAL mp4 (negotiated) | REAL webm | guarded state machine, byte/duration caps, segments |
| Timelapse | REAL (webcodecs-webm or canvas-replay, labeled) | REAL (canvas-replay, real-time, labeled) | REAL | interval stills under frame/byte budgets |
| Slow-motion | REAL where track ≥100fps (e.g. 240 ⇒ 8× at 30fps) | `NO_HIGH_FPS_MODE` (60fps ceiling named) | `NO_HIGH_FPS_MODE` | zero interpolation, ever |
| Stabilization | REAL `TIER_BASIC` | REAL `TIER_BASIC` | REAL `TIER_BASIC` | `TIER_ADVANCED` (gyro) `DEFERRED_NATIVE` |
| Pro controls | REAL per-control (torch/zoom/EV/ISO/exposureTime/WB/focus/fps) | mostly `NOT_IN_TRACK_CAPABILITIES` | partial | each gated on live MediaTrackCapabilities |

Reason codes are the closed set in `availability.js`
(`CAMERA_UNAVAILABLE`); every refusal carries one plus free-form `detail`.

## The three seams later missions consume

1. **FrameSource** (`frame-source.js`) — `subscribeFrames(cb, {fps})` with
   drop-oldest backpressure and close-exactly-once ownership;
   `captureStill()` labeled by path. Mission 2 (AI vision) subscribes here.
2. **Pipeline** (`pipeline.js` + `pipeline-gl.js`) — ordered pure stages,
   GLSL/CPU twins, zero stages = passthrough, GL-only stages refused in CPU
   mode. Mission 3 (AR/beauty) adds stages here.
3. **ISegmenter** (`portrait.js`) — mask engines register into the engine's
   registry; portrait (and later beauty) consume masks.

Precise contracts: `developer-guide.md`.

## Test and bench surface

11 deterministic suites (`test/camera-*.test.js`, 202 assertions; 203
with the post-build bundle check) on the
fake harness (`test/helpers/fake-media.js`) — no camera, no DOM, no
network in CI. `test/bench/camera.bench.mjs` records per-MP algorithm
costs (numbers: `benchmark-report.md`). What CI cannot prove is listed
honestly in `production-checklist.md`'s manual device matrix.
