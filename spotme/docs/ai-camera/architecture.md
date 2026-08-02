# AI Camera & Creative Studio — platform architecture

Platform umbrella: ADR-014. One capture pipeline, three published seams,
four missions. This page carries the whole-platform picture; each mission
fills its section as it lands. **Only mission 1 is implemented today.**

```
                        ┌────────────────────────────────────────────┐
                        │              flags.js (root)               │
                        │  AI_CAMERA_ENABLED ── platform master      │
                        │    └─ CAMERA_ENGINE_ENABLED ── mission 1   │
                        │         └─ 9 capability flags              │
                        │    └─ (014b/c/d roots parent here later)   │
                        └────────────────────────────────────────────┘

           createCameraEngine()  ← the ONLY door; inert stub while dark
                       │
   ┌───────────────────┼──────────────────────────────────────────┐
   │ mission 1 — camera engine (lib/camera/, IMPLEMENTED, DARK)   │
   │                                                              │
   │ devices.js → session.js ──────────── pro controls (gated on  │
   │   enumeration   open/switch/release   MediaTrackCapabilities)│
   │        │                                                     │
   │        ▼                                                     │
   │ frame-source.js  ══ SEAM #1: FrameSource ═══════════════════▶│──▶ mission 2
   │   pumps: track-processor | rvfc | interval-canvas            │    AI vision
   │   drop-oldest backpressure · captureStill (labeled path)     │    (ADR-014b,
   │        │                                                     │     planned)
   │        ▼                                                     │
   │ pipeline.js + pipeline-gl.js ══ SEAM #2: stage chain ═══════▶│──▶ mission 3
   │   ordered pure stages · GLSL/CPU twins · stages.js proofs    │    AR & beauty
   │   portrait.js ══ SEAM #3: ISegmenter registry ══════════════▶│    (ADR-014c,
   │        │                                                     │     planned)
   │        ▼                                                     │
   │ computational photography (pure math, Node-testable)         │
   │   imagemath · fft · align (phase corr) · hdr (Mertens) ·     │
   │   night (stack+reject) · stabilize (TIER_BASIC EIS)          │
   │        │                                                     │
   │        ▼                                                     │
   │ outputs: stills (Blob) · video.js recorder · assemble.js     │──▶ mission 4
   │   (webcodecs+webm-mux | canvas-replay) · timelapse · slowmo  │    creative
   │   · burst · metrics.js (zero-egress snapshots)               │    studio
   └──────────────────────────────────────────────────────────────┘    (ADR-014d,
                                                                        planned)
```

## Mission 1 — camera engine (FILLED; see camera-engine.md + ADR-014a)

- **Module:** `web/src/lib/camera/` — 26 plain-ESM files, all <500 lines,
  zero dependencies, zero egress, zero persistence, no crypto
  (fence-enforced by `test/camera-fence.test.js`).
- **Lifecycle:** sessions open only through the engine; every hardware wait
  is bounded (`withTimeout`); release stops every track; the OS ending a
  track releases the session and its frame source.
- **Honesty:** every capability is probed data with closed-set reasons;
  web-impossible features are DEFERRED_NATIVE (P10), never simulated.
- **Determinism:** injectable clock everywhere; CI runs 222 assertions
  against the fake camera stack; algorithms are pure and golden-tested.

## Mission 2 — AI vision (PLACEHOLDER — ADR-014b to come)

Consumes SEAM #1. Expected shape: model runners (on-device first) subscribe
to frames at bounded fps/scale; results (labels, boxes, text) flow to the
app via its own reviewed surface. Its central ADR questions: model
dependencies, any cloud provider boundary (owner decision, default OFF,
per the accuracy+latency+privacy rule), and memory budgets shared with the
pipeline. Must extend the fence to its files.

## Mission 3 — AR & beauty (PLACEHOLDER — ADR-014c to come)

Consumes SEAM #2 and SEAM #3. Expected shape: GLSL stages (with CPU
reference twins where feasible) inserted into the pipeline chain; a real
segmenter registered into the ISegmenter registry (owner dependency
decision recorded in ADR-014a §4). Face-mesh landmarks would be a
mission-2/3 shared model decision.

## Mission 4 — creative studio (PLACEHOLDER — ADR-014d to come)

Consumes capture outputs (stills, videos, bursts, lapses). Expected shape:
editing/composition atop the existing `photoedit.js`/`crop.js` patterns,
export through the existing media path. Owns no camera hardware access.

## Boundaries with the existing app (all missions)

- The app's chat media path (`lib/media.js`, `views/chat.js`) is untouched;
  a future wiring PR connects engine OUTPUT blobs to the existing
  attach/send flow — capture never bypasses the reviewed media pipeline.
- No view imports the platform while dark (fence-tested); UI lands only in
  owner-approved wiring PRs per `activation-guide.md`.
