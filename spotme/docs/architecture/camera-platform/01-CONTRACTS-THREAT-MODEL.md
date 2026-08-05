# Camera Platform — Contracts & Threat Model (Stage 1, group C1)

> **Status: Implemented (Draft PR — DARK).** Contracts + ADR-029 + threat
> model + programme only. No engine code, no mount, no asset, no cloud call.

## 1. Contracts (`packages/contracts/src/camera.ts`, v1)

- **Capture** — `CaptureRequest`/`CaptureResult` with a CLOSED refusal
  vocabulary (`no-exposure-control` refuses fake HDR; `no-high-fps-track`
  refuses interpolated slow-mo). **Privacy by absence:** `CapturedMediaRef`
  has no latitude/longitude/gps/location/exif field — compile-time negatives
  prove coordinates have nowhere to live before the Phase 5B EXIF strip.
- **Edit graph** — closed `EditOpKind` vocabulary (the Stage 1 studio
  subset), per-op bounded shapes, `EditDocument` where undo IS document
  slicing; the 8 procedural `LookId`s are honestly named, never "AI".
- **Vision** — `ScanResult` (detected non-empty | none | unavailable with
  closed reasons; decoder labeled `platform-barcode-detector`/`jsqr`),
  `TextRecognitionResult` (a genuine empty read is `''` success; absent
  engine is `no-text-recognizer`; a lazy engine not yet loaded is
  `not-loaded`; fabrication from an unknown engine is uncompilable).
- **Faces/beauty** — `ApprovedLandmarkEngine` is the LITERAL
  `'mediapipe-face-landmarker'`: no other engine is nameable on landmarks,
  and an `advanced` BeautyRequest structurally requires it (the ADR-014c
  gate at type level — a box-only tracker cannot satisfy it).
- **Cloud consent** — `CloudConsentContext` with `scope: 'single-request'`
  as the only representable scope; `CloudVisionOp` is closed and medical is
  NOT a member (refused by absence, owner policy).
- **Asset integrity** — `ModelAssetRecord`: pinned version, same-origin
  path, sha256, license, source — the committed-manifest shape ADR-029 §4
  requires.

Compile-time negatives (`camera-negative.test.ts`): location/exif fields on
capture, open refusal reasons, unknown edit ops/looks, fractional rotations,
empty "detected" scans, OCR from an unknown engine, advanced beauty without
the approved engine, session-scoped consent. `camera-usage.test.ts` is the
positive control (all result arms, exhaustive `never`-proof narrowing,
undo-by-slicing, honest empty OCR read, the asset record).

## 2. Threat model (Stage 1)

| # | Threat | Control |
|---|---|---|
| T-CA-1 | **Permission abuse / covert capture** | Session lifecycle from CAM-1 is ported with guaranteed track release + bounded lifetimes (C2); nothing is mounted in Stage 1 so no capture surface exists; activation adds the visible-recording-state requirement (Stage 2 checklist). Tests assert tracks are released on every path incl. failure. |
| T-CA-2 | **Location leakage via captures** | No location field exists on any capture shape (compile-time negatives); capture flows into Moments ONLY through the Phase 5B EXIF/GPS strip (C4 wiring + privacy-mutation battery: no location token from capture reaches an outbound surface). |
| T-CA-3 | **Model-asset supply chain** | ADR-029 §4: pinned versions, same-origin serving, committed sha256 manifest, license/source records, integrity check before engine registration (`asset-integrity-failed` on mismatch), NO runtime CDN fallback — fence-scanned in C5 incl. model-loader paths. |
| T-CA-4 | **Cloud-consent boundary bypass** | Non-optional single-request `CloudConsentContext` on every cloud port method (type + runtime); default adapter disabled with zero egress; gateway-only scans fail on any provider SDK/endpoint outside the Phase 1E AI Gateway package (C5 fence). |
| T-CA-5 | **Fabricated capability (fake HDR, fake slow-mo, fake faces, fake OCR)** | Closed refusal vocabulary at type level; the CAM honesty rule ported with the code; deterministic tests migrate with each engine (C2/C3). |
| T-CA-6 | **Media exfiltration via cloud legs** | Cloud ops are dark seams routed only through the gateway; consent is per-request; no image-byte logging (ported test discipline); provider keys owner-held, server-side only. |
| T-CA-7 | **Beauty-tier overreach** | Tier-0 params bounded [0,1] with naturalness caps; advanced tier structurally requires the approved landmark engine; no body-morph ops exist in the vocabulary. |
| T-CA-8 | **Stale source drift** | Originals are read-only history; the port is a migration with its deterministic tests carried over — divergence surfaces as test failures, not silent behavior change. |

## 3. What C1 explicitly does NOT contain

No engine code, no UI, no model asset, no network path, no port
implementation, no Moments wiring — types + ADR + docs only.
