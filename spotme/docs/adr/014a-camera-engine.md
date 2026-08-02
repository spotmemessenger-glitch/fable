# ADR-014a — The camera engine (mission CAM-1)

**Status:** Implemented, SHIPPED DARK (every flag false, fence-enforced).
**Parent:** ADR-014 (platform umbrella). **Companions to come:** 014b/c/d.
**Code:** `web/src/lib/camera/` (26 files, each <500 lines, zero deps).

## 1. What was built, and the one rule it obeys

A professional capture pipeline: device selection, session lifecycle with
pro controls, a frame seam, a shader-hook processing chain, computational
photography (HDR fusion, night stacking, EIS), stills, video recording,
timelapse, slow-motion, burst — every piece behind the honesty rule
inherited from `qr-scan.js`: **where a platform cannot do something, the API
answers UNAVAILABLE with a machine-readable reason — never a degraded fake
pretending to be the feature.** The full per-platform truth table lives in
`docs/ai-camera/camera-engine.md`.

## 2. Decisions and their reasons

### 2.1 Layered constant flags, no runtime override
`AI_CAMERA_ENABLED` → `CAMERA_ENGINE_ENABLED` → nine capability flags.
Constants because a runtime toggle is an attack surface and an accident
surface on the most sensitive sensor; layering because rollback must be one
move (master off) rather than nine. `resolveFlags` throws on unknown names —
a typo'd flag must fail tests, not ship a phantom.

### 2.2 The factory is the only door, and dark means inert
`createCameraEngine()` under default flags returns a stub that constructs
nothing — no env read, no probe, no timer (fence-proven with throwing
fakes). Consequence: no code path can warm up, enumerate, or open a camera
while dark; there is nothing to audit because nothing runs.

### 2.3 Injectable clock everywhere
Every timer/timestamp flows through `clock.js`. This is what makes the
recorder caps, timelapse pacing, warm-restart timings and the inertness
proof DETERMINISTIC in CI instead of sleep-and-hope.

### 2.4 FrameSource: drop-oldest backpressure, close-exactly-once
The platform seam (missions 2–3 consume it). A slow consumer must never
stall the camera or process stale frames, and dropped VideoFrames must
never leak GPU memory — so frames are refcounted, the pending slot is
drop-oldest, delivery is valid only during the callback, and the `dropped`
count is visible to consumers. Pumps are feature-detected and labeled
(track-processor > rVFC > interval-canvas); none available is a named
refusal.

### 2.5 Computational photography is pure math on ImageData shapes
HDR fusion, night stacking, alignment, EIS all run on
`{data,width,height}` planes with zero DOM dependency. That is what allows
golden-vector tests in Node (numeric assertions, seeded fixtures) — the
algorithms are the part CI CAN prove, so they are built to be provable.
Measured constants are documented in-code (alignment confidence floor 0.2
from a measured 0.13-noise/0.28-signal corridor; texture-variance gate
1e-5; Mertens measure floor 0.01 so clipped flat regions are arbitrated by
well-exposedness).

### 2.6 HDR requires real exposure control
`captureBracket` exists only where the track exposes an
`exposureCompensation` range. Fusing three identical exposures is fake HDR;
iOS therefore reports NO_EXPOSURE_CONTROL rather than shipping a lie. The
fusion half stays available everywhere as pure math.

### 2.7 Slow-motion requires real high-fps capture
Floor 100fps (device-measured, reported in the refusal). No frame
interpolation — smeared invented frames pretending to be captured time is
exactly the fake this platform bans. Interpolation, if ever wanted, is a
mission-2 model behind its own flag and ADR.

### 2.8 Portrait ships the seam, not a fake segmenter
`ISegmenter` registry + a real masked-blur consumer, golden-tested. No
engine is bundled: producing a mask needs either the MediaPipe
selfie-segmentation dependency (§4 owner decision) or native depth (P10).
With none registered, portrait is NO_SEGMENTER_REGISTERED.

### 2.9 A minimal WebM muxer instead of pretending WebCodecs is enough
`VideoEncoder` emits bare chunks; without a container they are not a video.
Rather than labeling that path "done", the engine writes a minimal
Matroska subset (exact sizes, ms timestamps, cluster rotation before int16
overflow, no Cues — playback-only, stated). Tests parse the EBML back.
The no-WebCodecs path is MediaRecorder canvas replay, honestly labeled
real-time. No mp4 muxing (licensing/complexity cliff; Safari records mp4
natively via MediaRecorder).

### 2.10 EIS is TIER_BASIC and says so
Translation-only phase-correlation EIS with exponential path smoothing and
crop-margin clamping, measured ≥3× smoother on synthetic jitter.
TIER_ADVANCED (gyro fusion, rolling shutter) is DEFERRED_NATIVE — the web
has no capture-synchronized IMU.

### 2.11 Zero egress, zero persistence, no crypto
Fence-enforced by call-shape scans. Settings live in memory per session;
nothing writes IndexedDB/localStorage; nothing can open a network path.
The camera engine therefore cannot interact with disappearing messages,
view-once, or key material until a wiring PR explicitly connects an output
blob to the existing (already-reviewed) media path.

## 3. What is deferred where (the honest map)

| Capability | Web reality | Disposition |
|---|---|---|
| RAW/DNG capture | No sensor-RAW path in any browser | DEFERRED_NATIVE (P10 Capacitor adapter; contract: native returns DNG bytes + metadata via the same availability envelope) |
| Gyro EIS (TIER_ADVANCED) | No capture-synced IMU | DEFERRED_NATIVE (P10) |
| Segmentation engine | Needs ML dep or depth | Owner decision (§4) / P10 depth |
| HDR on iOS Safari | No exposureCompensation | UNAVAILABLE(NO_EXPOSURE_CONTROL) until Safari exposes it or P10 native |
| Slow-mo on 60fps devices | No high-fps mode | UNAVAILABLE(NO_HIGH_FPS_MODE) |
| Full-res stills on iOS | No ImageCapture | canvas-draw at stream resolution, LABELED; full-res via P10 |
| GL/CPU pipeline equivalence | No GPU in CI | Manual device matrix (production-checklist.md) |

## 4. Owner decisions surfaced (blocking future work, not this mission)

1. **MediaPipe selfie-segmentation dependency** (`@mediapipe/tasks-vision`,
   Apache-2.0, ~5 MB wasm+model): the only web path to a real portrait
   segmenter today. Approving adds the platform's first ML dependency;
   declining defers portrait to P10 native depth. Needed before portrait
   can ever light up.
2. **P10 native adapter scope**: RAW capture, gyro EIS, native depth,
   full-res iOS stills are all queued behind the Capacitor adapter — worth
   scoping as one native-camera work item in P10 planning.
3. **Activation order** for the flag flips is proposed in
   activation-guide.md and needs owner sign-off at wiring time.

## 5. Rollback

Revert the commits (or flip `AI_CAMERA_ENABLED` back to false in a one-line
change once wired). No data, no schema, no migration — the module persists
nothing. See rollback-plan.md.
