# Camera Stage 2A — Report (asset vendoring + activation prep + device-lab harness)

**Status: Implemented (Draft PR — DARK).** Stacked on the Stage 1 chain tip
(C5, #113) as `feat/camera-stage2a-assets-harness`. Nothing merges, nothing
activates, `App` untouched in normal builds. Continues ADR-029.

## 1. What shipped

**Asset vendoring (fills the honest empty manifest).** `MODEL_ASSET_MANIFEST`
now carries **7 pinned records** with real sha256 digests and Apache-2.0
license/source records; `scripts/stage-camera-assets.mjs` stages the binaries
into `public/models/` reproducibly and **verifies every byte against the
committed digests at build time** (the runtime loader re-verifies on load).
Binaries are **not committed** (repo-light: gitignored build outputs) — the
wasm/worker files copy from the exact-pinned npm packages (the package-lock is
a second integrity layer), the two model files download once at build from
pinned upstream URLs. This is a build step, **never a runtime CDN**: the app
only ever loads `/models/*` from its own origin.

**Activation wirings, prepared dark.** The four C5-identified wirings are real
code in `lab/wirings.ts` — jsQR lazy loader, MediaPipe face-landmarker
registration (through the integrity loader), tesseract registration, and the
navigator/MediaStream `CameraDevicePort` + composer binding. They live
**outside** the fenced `src/` tree (they legitimately need `fetch`, the engine
packages, and `navigator.mediaDevices` — all forbidden in `src/`), compiled
**only** into the `CAMERA_LAB_ENABLED` build.

**Device-validation harness.** `lab/CameraLab.tsx` — the owner's Stage 2B
cockpit: capture (still/HDR/night/burst/video with honest refusals shown),
live beauty-tier preview with strength sliders, face-landmark detection,
barcode/QR live scan, OCR (eng + kan), per-feature timing, a thermal/battery
note field, and a **copyable markdown results block**. The C5-named safety
gaps are closed: a visible recording-state indicator while a track is live,
scan payloads rendered as **untrusted text (never auto-opened)**, labeled
controls + ARIA live regions.

**Runbook.** `docs/ai-camera/STAGE-2B-DEVICE-MATRIX.md` — the exact run
commands, the device checklist, per-capability pass/fail criteria, and which
result unblocks which wiring.

## 2. Asset manifest summary (versions; digests live in the manifest)

| Asset | Version | License |
|---|---|---|
| MediaPipe face-landmarker (.task, float16) | tasks-vision 1.0.1 / model v1 | Apache-2.0 |
| MediaPipe vision wasm (js + wasm) | tasks-vision 1.0.1 | Apache-2.0 |
| tesseract.js worker | 7.0.0 | Apache-2.0 |
| tesseract.js-core (simd-lstm wasm loader) | 6.1.2 | Apache-2.0 |
| tessdata eng | 4.0.0 | Apache-2.0 |
| tessdata kan (Kannada — owner's region) | 4.0.0 | Apache-2.0 |

7 records, 7 committed digests, all same-origin `/models/*` paths. Languages
are easily extended (one record + one staging entry).

## 3. Validation

- **web-next full chain (flag false): 190 tests + 4 skipped**, isolation
  fence 6/6, camera source fences 8/8, **camera-lab-absent fence 4/4**,
  `src` and `lab` typecheck, production build clean.
- **New integrity tests** (`camera-assets-integrity.test.ts`, 9 assertions):
  the loader PASSES the real staged digests, still refuses tampered bytes as
  `asset-integrity-failed`, and still refuses any non-same-origin path.
- **Artifact proof:** `CAMERA_LAB_ENABLED=true npm run build` emits
  `dist/lab/camera-lab.html` + a 313 KB lab chunk; the flag-false build emits
  **neither**, and the absent-fence scans every dist chunk for lab
  identifiers (incl. `face_landmarker.task`, `createNavigatorDevicePort`) —
  clean. Production dependencies remain **react + react-dom only**; the engine
  packages are devDependencies.
- **Protected heads** (master, the four historical camera branches,
  snap-camera-kit, docscan park, all five Stage 1 chain heads) recorded at
  mission start and **unchanged** except this new branch. Wave 0 artifacts
  untouched (no `feat/activation-wave-0`, no `docs/ops/`, nothing Railway).

## 4. What Stage 2B asks of the owner

1. Run the lab per the runbook on your device set (Pixel/Android, iPhone/iOS,
   one budget floor device).
2. For each device, exercise every feature and **paste the copyable markdown
   block** back into a session (attachments don't transfer).
3. Note any thermal/battery drain over a few-minute session.

Each capability's activation wiring is unblocked once it passes (or honestly
refuses for a device-capability reason) across the device set. **Activation
itself stays a separate owner change** — importing the wirings into a
production surface, mounting any capture UI, and the flag flip are not part of
Stage 2A.
