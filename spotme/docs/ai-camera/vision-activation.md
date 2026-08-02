# AI Vision — activation guide (the path from dark to lit)

Nothing here happens without an OWNER-approved wiring PR. The vision module
ships with every flag false and no runtime override; activation is a sequence
of small reviewed diffs, each independently revertible, in this order. It
parallels `activation-guide.md` (camera) and depends on the camera engine
being wired first (vision reads its `FrameSource`).

## Stage 0 — prerequisites (before any flag moves)

- [ ] Camera engine wired at least through capture core (this module consumes
      its `FrameSource`).
- [ ] Owner decisions resolved for the legs in scope (ADR-014b §3):
      - scan/OCR-seam only → none beyond the camera prerequisites.
      - on-device OCR → the tesseract.js dependency approval.
      - any cloud leg → the D1/D5 register (provider boundary + cost caps).
- [ ] Fence test updated intentionally: the no-import check moves from "zero
      importers" to "exactly the approved wiring modules" — narrow it, never
      delete it (the signing-not-shipped.test.js pattern).

## Stage 1 — the wiring PR (scan only)

The first PR that imports `lib/vision/index.js`:

1. Adds the scanner UI surface (its own reviewed view work: outputs into the
   existing app flow, nothing server-bound).
2. Flips, in the SAME diff, exactly:
   - `AI_CAMERA_ENABLED: true` (if not already lit by the camera wiring)
   - `AI_VISION_ENABLED: true`
   - `VISION_SCAN_ENABLED: true`
3. Ships barcode/QR scanning only. Every other capability still answers its
   honest refusal.

Gate to proceed: scanning works on the device matrix; the honest
`NO_DETECTOR` path verified on a browser without `BarcodeDetector`.

## Stage 2 — the on-device OCR seam (optional, dependency-gated)

Only if the owner has approved the OCR engine dependency (ADR-014b §3):

1. Add the `ITextRecognizer` adapter (e.g. tesseract.js) as a new dependency
   — its own reviewed PR, and the fence's dependency assertion updated to
   name it.
2. Register it via `engine.ocr.register(...)` at wiring time.
3. Flip `VISION_OCR_ENABLED: true`. Photo translate additionally needs an
   `ITranslator` port registered and `VISION_TRANSLATE_ENABLED`.

## Stage 3 — the cloud legs (D1, owner only)

Only after the owner answers the D1 provider-plaintext boundary and D5 cost
governance (`priority-2/91-ENGINEERING-RISK-REGISTER.md`):

1. Author `api/vision-ai.js` — the env-gated server proxy (mirrors
   `api/studio-ai.js`: `VISION_AI_ENABLED` env ⇒ else 501, per-user auth +
   rate limit + daily budget, provider routing per the approved matrix, keys
   in server env only, image bytes never logged).
2. Wire the client port's `fetchImpl`/`getAuthHeaders` in the same diff.
3. Flip `VISION_CLOUD_ENABLED: true`, then the specific leg flags
   (recognize/assistant/shopping). `VISION_MEDICAL_INFO_ENABLED` stays off
   until the owner's medical-info policy is separately ratified.

## Not in this platform yet

The on-device **document scanner** is deferred (ADR-014b §4) — its drafted
foundation is on `wip/ai-vision-docscan-unreviewed`, failing its golden
tests, and is NOT part of any stage above until a future mission finishes it.
`VISION_DOCSCAN_ENABLED` is a reserved flag with no wired capability.

## Rollback

Every stage is one flag flip to revert. The master (`AI_VISION_ENABLED` or
`AI_CAMERA_ENABLED`) darkens the whole module in one move; nothing here
persists, so rollback needs no data migration.
