# Camera Platform — Engine, Studio, Vision, AR (Stage 1, C2–C4)

> **Status: Implemented (Draft PR — DARK).** All in `web-next/src/camera/`,
> mounted nowhere (fence-proven). Sources #55/#56/#58/#59 are read-only
> history; hardware behavior is honestly unproven until Stage 2.

## 1. Engine (C2) — ported formula-for-formula from #56

`imagemath` / `fft` (own radix-2, throws on non-pow2) / `align` (phase
correlation; measured texture gate 1e-5 + trust floor 0.2 carried over;
sign convention pinned by test) / `hdr` (Mertens fusion, MEASURE_FLOOR) /
`night` (motion-rejected stacking, √N law asserted) / `stabilize` (EIS
basic: path smoothing + crop clamp). Engine facade over the
`CameraDevicePort` hardware seam with the RELEASE GUARANTEE (every session
released on every path) and closed refusals: no EV range → no HDR; no
honest ≥100fps track → no slow-mo; byte budgets bound bursts. Recorder
layer: negotiated mime, `stoppedBy` caps, timelapse LABELED
`realtime-recorder` (the CAM-1 WebCodecs/EBML offline path is a documented
later port). The Moments-5D `CameraPort` is implemented
(`EngineCameraAdapter`) with `UnavailableCameraPort` as the dark default.

## 2. Studio subset (C3) — from #55

Op-doc model (undo = document slicing, serialization round-trip),
Fritsch–Carlson monotone curves→LUT, scalar adjustments, crop/rotate,
8 procedural looks. After review repair F-CAM-3, vignette/sharpen/clarity/
grain REALLY apply; `straighten` is the one stored-unrasterized op
(Stage 2 GL path), disclosed via `unappliedOps()`. Out of subset (still on
the source branch): removal/bg/sky/relight/composer/collage/templates/
drafts.

## 3. Vision (C3) — from #58 under the ADR-029 vendor rule

Scan: platform `BarcodeDetector` preferred; the approved jsQR fallback via
an INJECTED lazy seam (web-next's isolation fence forbids new package
imports — the one-line loader importing the repo's jsQR is a documented
activation wiring). OCR: the tesseract.js `ITextRecognizer` — explicit
`load()` only (recognize never loads implicitly), `not-loaded` before,
`''` is an honest empty read, malformed payloads are `failed`. The
`ITranslator` slot stays empty; docscan stays parked
(`wip/ai-vision-docscan-unreviewed`).

## 4. AR/Beauty (C3) — from #59

Tier-0 stages formula-for-formula with `BEAUTY_LIMITS` enforced inside
every stage (strength 5 == capped strength 1, tested). `IFaceTracker` +
Shape-Detection adapter (normalized, source-labeled, confidence 0 =
unknown per F-CAM-2, EMA-smoothed). The landmark gate ports: advanced
beauty refuses `no-landmark-engine` in types AND at runtime; MediaPipe
registration goes ONLY through the ADR-029 §4 integrity loader.

## 5. Cloud consent + asset integrity (C3)

Non-optional single-request `CloudConsentContext` on every cloud method;
`DisabledCloudVision` (clock REQUIRED per F-CAM-1) validates consent even
while disabled — missing/malformed/stale/future all refuse — and answers
`gateway-dark` with zero egress. The asset manifest is committed EMPTY at
Stage 1 (vendoring pinned MediaPipe/tesseract binaries with real digests
is a named Stage 2 prerequisite); the loader refuses non-same-origin paths
structurally and digest mismatches as `asset-integrity-failed`.

## 6. Moments wiring (C4)

`camera?: CameraPort` optional dep on the Moments controller, defaulting
to ABSENT (gallery-only unchanged; honest error unwired). A capture joins
the draft as mediaId only; bytes meet the Phase 5B EXIF strip at upload;
the M5 two-step coarse attach remains the only location path. The C4
privacy-mutation battery proves zero coordinate tokens outbound without an
attach and only the confirmed coarse values with one.

## 7. Honest performance (CPU floor, CI container, jsdom/Node fidelity)

Measured 2026-08-04 on the port (1 MP = 1024×1024 synthetic scene):
Mertens fuse 3×1MP ≈ **799 ms** · night stack 4×1MP ≈ **184 ms** · shift
estimate 1MP ≈ **24 ms**. No GPU, no real camera, no mobile thermal
envelope — **Stage 2 real-device validation is the activation
prerequisite**; these numbers bound nothing on phones.

## 8. Verification map

| Concern | Suite |
|---|---|
| DSP golden vectors (migrated from #56) | `web-next/test/camera-algorithms.test.ts` |
| Engine honesty + release + recorder + CameraPort | `web-next/test/camera-engine.test.ts` |
| Studio/vision/AR/cloud/assets + repair regressions | `web-next/test/camera-studio-vision-ar.test.ts` |
| Moments wiring + C4 privacy battery | `web-next/test/camera-moments-wiring.test.ts` |
| Dark fences (tamper-checked) | `web-next/test/camera-dark-fences.test.ts` |
