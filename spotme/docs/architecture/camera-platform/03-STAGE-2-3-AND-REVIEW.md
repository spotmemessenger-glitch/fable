# Camera Platform — Stage 2/3 Requirements & the Stage 1 Review (C5)

## 1. What Stage 2 (real-device validation) still requires

1. **Asset vendoring under ADR-029 §4** — download, pin, and commit the
   MediaPipe face-landmarker `.task` and tesseract.js worker/wasm/
   traineddata binaries; record real sha256 digests + licenses in
   `MODEL_ASSET_MANIFEST`; the loader and fences are already in place.
2. **Activation wirings (each one line, owner-reviewed):** the jsQR
   fallback loader; the tesseract loader; the navigator/MediaStream
   `CameraDevicePort` adapter; the MediaRecorder `RecorderPort` adapter.
3. **Real-device matrix:** camera behavior, browser API differences,
   GPU/GLSL twin equivalence (the shaders remain on the source branch),
   EIS live-preview cost, WebM real-player playback, thermal/battery,
   visual quality — NOTHING here is claimed from jsdom.
4. **Visible-recording-state UI + permission UX** (T-CA-1) and untrusted
   scan-payload rendering (URLs from QR are untrusted — the Moments
   no-unfurl discipline applies).
5. **A11y audit of any capture/editor surface** (none exists yet).
6. **Perf re-benchmark on hardware** — the CPU-floor numbers in doc 02
   bound nothing on phones.

## 2. What Stage 3 (native) still requires

RAW/DNG capture, gyro-fused EIS (capture-synchronized IMU), native depth
(portrait), full-res iOS stills, WebXR/world AR — all `DEFERRED_NATIVE`
per ADR-014a/c, unchanged. The hand-landmark engine (gestures) and any
segmentation model (portrait) remain owner decisions outside the approved
bundle.

## 3. Stage 1 adversarial review — 13 lenses, disposition

Lenses: (1) fabrication · (2) permission abuse/covert capture ·
(3) location leakage · (4) model supply chain · (5) consent boundary ·
(6) vendor rule · (7) studio honesty · (8) capability honesty (HDR/
slow-mo/faces) · (9) dark-mount/import graph · (10) payload injection ·
(11) a11y · (12) dependency/artifact scans · (13) test vacuity/doc
honesty.

| # | Lens | Sev | Finding → Disposition |
|---|---|---|---|
| F-CAM-1 | (5) consent | Medium | `DisabledCloudVision`'s defaulted clock (`() => 0`) made staleness unenforceable (any real grantedAtUTC read as "future"). **Fixed (C3 `3c6271f`):** clock REQUIRED; future-granted consent refused as stale (age < 0). Regression added. |
| F-CAM-2 | (1) fabrication | Medium | Shape-Detection boxes carried an invented `confidence: 0.5` — the API reports none. **Fixed (C3 `3c6271f`):** confidence 0 = unknown, never invented. Regression added. |
| F-CAM-3 | (7) studio honesty | **High** | `vignette/sharpen/clarity/grain` evaluated as SILENT NO-OPS — a stored op that did nothing was a lie. **Fixed (C3 `3c6271f`):** all four really apply (radial vignette with corner-vs-centre asymmetry pinned, unsharp sharpen, wide-radius clarity, seeded deterministic grain); `straighten` is the one stored-unrasterized op, disclosed via `unappliedOps()`. Regressions added. |

No other lens produced a fix-worthy finding. Notes: (2) release guarantee
tested on every path, visible-recording-state named as a Stage 2 gate;
(3) contract-level absence + C4 battery + fence scans; (4) empty manifest +
structural no-CDN + tamper-checked scans; (6) injected seams only, zero new
dependencies (package.json untouched); (9)/(12) fences tamper-checked
(a planted CDN fetch failed the scan); (10) scan rawValue documented as
untrusted for Stage 2 UI; (11) no UI exists this stage; (13) golden suites
are behavioral, bench numbers labeled CPU-floor.

Repairs were committed at their origin group (C3) and forward-merged
C3→C4→C5 with ordinary merge commits; historical camera branches untouched.
