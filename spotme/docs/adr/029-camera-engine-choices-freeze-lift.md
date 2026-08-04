# ADR-029 — Camera engine choices & freeze-lift scope (Camera Stage 1)

**Status:** Accepted (owner decisions recorded by the Camera Stage 1 mission,
2026-08-04, under the standing delegation).
**Parents:** ADR-014 (AI Camera platform umbrella), ADR-014a/b/c (CAM-1..3),
ADR-027 (mobile-native boundary).

## 1. Freeze lift — scope and limits

The camera freeze (owner directive, 2026-08-02) is **lifted for web
integration only**:

- The four camera draft PRs — **#56 (engine), #55 (studio), #58 (vision),
  #59 (AR/beauty)** — and the `snap-camera-kit` research branch become
  **SOURCE MATERIAL to migrate from**.
- The original branches/PRs are **READ-ONLY history**: never modified,
  rebased, closed, or deleted. Their PRs stay open for the owner.
- Migration target: `spotme/web-next` (TypeScript, platform idioms), behind
  the `CameraPort` seam Moments 5D defined — dark, no mount, no flag.
- NOT lifted: native work (Stage 3), real-device validation claims (Stage 2),
  activation of anything.

## 2. Engine bundle — APPROVED

| Slot | Engine | Terms |
|---|---|---|
| Face landmarks (unlocks advanced beauty/masks per ADR-014c) | **MediaPipe face-landmarker** | Apache-2.0; pinned exact version; self-hosted per §4 |
| OCR (`ITextRecognizer`) | **tesseract.js** | Apache-2.0; lazy-loaded, on-device; honest `no-text-recognizer`/`not-loaded` until ready |
| Cloud vision | **Phase 1E AI Gateway ONLY** | owner-held provider keys; no new vendor; no direct SDK anywhere outside the gateway package |
| Barcode/QR | existing platform-native `BarcodeDetector`, else the approved `jsQR` fallback already in the repo | **never a new barcode vendor** |

Explicitly NOT approved: Snap Camera Kit (survey retained as reference on the
read-only branch), any hand-landmark engine (gestures stay `NO_HAND_ENGINE`),
any segmentation model (portrait keeps its honest empty seam), WebXR.

## 3. Stage 1 studio subset

The C3 studio port covers the named subset: non-destructive op graph, undo
(document slicing), exposure/curves/crop family, looks. The remaining CAM-4
capabilities (object removal, bg/sky replace, relight, composer, collage,
templates, drafts) are implemented on #55 and **deferred to a later stage**
— not lost, not ported yet.

## 4. Asset integrity (binding for every model/runtime asset)

1. **Pinned exact versions** — no ranges, no "latest".
2. **Served from the app's own origin** — model files ship in the repo/build;
   **no runtime CDN fallback of any kind** (a fence fails on CDN URLs in
   model-loader paths).
3. **License + source recorded** per asset in the committed manifest
   (`ModelAssetRecord`: id, engine, version, path, sha256, license, source).
4. **Integrity-checked** against the committed sha256 before an engine
   registers; a mismatch is `asset-integrity-failed` — an honest refusal,
   never a silent fetch-elsewhere.

## 5. Cloud consent (technically enforced)

Every cloud-vision port method takes an explicit, NON-OPTIONAL
`CloudConsentContext` parameter — `scope: 'single-request'` is the only
representable scope (no global flag, inferred, cached, or optional consent).
The default adapter returns `{ state: 'disabled', reason: 'gateway-dark' }`
with **zero network activity**. Dependency + artifact scans FAIL on any
direct cloud SDK import, provider endpoint, or provider client outside the
Phase 1E AI Gateway package.

## 6. Consequences

- Stage 1 produces a dark, additive C1–C5 chain; nothing merges; nothing
  mounts; hardware behavior remains honestly unproven until Stage 2.
- The parked document scanner (11/36 goldens) stays parked on
  `wip/ai-vision-docscan-unreviewed`.
- The CAM-era 11-flag layering is superseded in web-next by the platform's
  darkness discipline: unmounted modules + fixture defaults + fences.
