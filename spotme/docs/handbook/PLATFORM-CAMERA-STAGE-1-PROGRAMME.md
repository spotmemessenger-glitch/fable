# Camera Stage 1 — Audit + Modern Integration (dark, additive)

> **Status: Implemented (Draft PR — DARK), in progress.** Migration of the
> frozen CAM-1..4 platform (source: PRs #55 #56 #58 #59 + snap-camera-kit,
> READ-ONLY history) into web-next TypeScript behind the Moments-5D
> `CameraPort` seam, under ADR-029 (freeze lift scope + approved engine
> bundle: MediaPipe face-landmarker · tesseract.js · gateway-only cloud ·
> platform/jsQR barcode). Nothing merges, mounts, or activates; hardware
> behavior is honestly unproven until Stage 2 (real device); native is
> Stage 3.

## Phase 0 audit — completion table

| Capability (origin) | Classification | Stage 1 destination |
|---|---|---|
| Device/session/FrameSource, still, pipeline, HDR, night, burst, video, timelapse, slow-mo, EIS-basic, pro controls (#56) | implemented-and-portable | C2 |
| Portrait `ISegmenter` seam (#56) | blocked-on-engine (segmentation not in approved bundle) | C3 seam kept, honest refusal |
| RAW / gyro-EIS / native depth (#56) | deliberately-deferred (`DEFERRED_NATIVE`) | Stage 3 |
| CAM 11-flag layering (#56) | stale-vs-platform | superseded: darkness = no mount + fixtures + fences |
| Barcode/QR platform>jsQR (#58) | implemented-and-portable | C3 |
| OCR seam (#58) | seam-portable; engine approved | C3 + tesseract.js adapter |
| `ITranslator` slot (#58) | seam only | C3 (stays empty) |
| Cloud vision legs (#58) | stale-vs-platform (pre-gateway) | C3 gateway dark seams under CLOUD CONSENT; medical refused |
| Document scanner (#58) | **failed-or-parked** (11/36 goldens) | stays parked (`wip/ai-vision-docscan-unreviewed` `3adf646`) |
| Beauty tier-0, `IFaceTracker` + shape-detection + EMA (#59) | implemented-and-portable | C3 |
| MediaPipe landmarker slot (#59) | decision now recorded (ADR-029) | C3 adapter under ASSET INTEGRITY |
| Gestures / world AR (#59) | deferred (no hand engine approved; WebXR deferred) | Stage 2/3 |
| Studio op-graph/undo/exposure/curves/crop/looks (#55) | implemented-and-portable | C3 (named subset) |
| Studio removal/bg/sky/relight/composer/collage/templates/drafts (#55) | implemented, out of subset | later stage |
| Studio cloud legs (#55) | stale-vs-platform | C3 gateway dark seams |
| snap-camera-kit (`1439f24`) | research reference only | no port; superseded by approved bundle |

## Linear stacked chain (nothing merges this mission)

| Group | Branch | Base | Scope |
|---|---|---|---|
| C1 | `feat/camera-stage1-contracts` | `master` | Camera contracts v1 (privacy-by-absence capture shapes, edit-op graph, vision scan, beauty tiers, cloud-consent context, asset-record shape) + compile-time negatives/positive control + ADR-029 + DECISIONS record + threat model + this programme |
| C2 | `feat/camera-stage1-engine` | C1 | CAM-1 engine ported to web-next TS behind the Moments-5D `CameraPort`: device selection, session lifecycle, still/HDR/night/burst/video/timelapse/slow-mo, EIS-basic, pro-control refusals — deterministic tests migrated; dark (no mount) |
| C3 | `feat/camera-stage1-studio-vision-ar` | C2 | Studio subset (op graph, undo, exposure/curves/crop, looks) · vision scan (platform>jsQR) + NEW tesseract.js `ITextRecognizer` (lazy, honest `not-loaded`) · AR/beauty tier-0 + NEW MediaPipe `IFaceTracker`/landmark adapter per ASSET INTEGRITY · cloud legs = AI-Gateway dark seams under CLOUD CONSENT · docscan stays parked |
| C4 | `feat/camera-stage1-moments-wiring` | C3 | `CameraPort` registered into the Moments composer path (capture → EXIF-strip → media contracts), fixture-default and dark · gallery-import path · full privacy-mutation battery (no location token from capture reaches outbound) |
| C5 | `feat/camera-stage1-fences-perf-docs` | C4 | Dark fences (no mount, no boot-time model fetch, no consent-free cloud call, gateway-only scans, artifact scan incl. model-loader paths) · honest jsdom-fidelity perf with Stage-2 named as activation prerequisite · docs + status rows (originals → Superseded-by-Stage-1, PRs left open) · 13-lens review + disposition |

## Owner-retained (not delegated)

Activation/flags · deployment · #43/#60/#61 · gender/age (A3) · real-device
validation claims (Stage 2 required before any) · vendors beyond the
approved bundle (never a new barcode vendor) · hand-landmark/segmentation/
WebXR engines · D6/A5/D5 policy · Wave 0 artifacts (paused, untouched).

## Build record

| Group | PR | State | Evidence |
|---|---|---|---|
| C1 | — | In progress | `camera.ts` v1 + negative/usage compile-time fences + ADR-029 + DECISIONS record + threat model (T-CA-1..8); contracts fence 6/6 + typecheck + build |
| C2 | — | Pending | — |
| C3 | — | Pending | — |
| C4 | — | Pending | — |
| C5 | — | Pending | — |

## Protected-head record (mission start; final report re-verifies equality)

master `64c9334` · #55 `d7ef3fa` · #56 `c7c8020` · #58 `44da9ff` ·
#59 `97aebee` · snap-camera-kit `1439f24` · docscan park `3adf646`.
