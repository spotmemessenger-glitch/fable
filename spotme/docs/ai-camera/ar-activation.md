# AR & Beauty — activation guide (the path from dark to lit)

Nothing here happens without an OWNER-approved wiring PR. The AR/beauty
module ships with every flag false and no runtime override; activation is a
sequence of small reviewed diffs, each independently revertible, in this
order. It parallels `activation-guide.md` (camera) and depends on the camera
engine being wired first (AR reads its clock and frame math).

## Stage 0 — prerequisites (before any flag moves)

- [ ] Camera engine wired at least through capture core.
- [ ] Owner decisions resolved for the legs in scope (ADR-014c §3):
      - beauty tier-0 / face-tracking box adapter → none beyond camera.
      - advanced beauty / masks → the MediaPipe face-landmarker dependency
        + self-hosted model-asset posture.
      - gestures → the hand-landmark engine dependency.
      - world AR → the WebXR/native decision.
- [ ] Fence test updated intentionally: the no-import check narrows from
      "zero importers" to "exactly the approved wiring modules" — never
      deleted (the signing-not-shipped.test.js pattern).

## Stage 1 — the wiring PR (tier-0 beauty + face-tracking boxes)

The first PR that imports `lib/ar/index.js`:

1. Adds the beauty/camera UI surface (its own reviewed view work; outputs
   into the existing media path, nothing server-bound — this module never
   egresses).
2. Registers the platform box adapter via
   `engine.faceTracking.useShapeDetection()` (honest
   `NO_PLATFORM_FACE_DETECTOR` where the API is absent — the UI shows the
   real reason, not a fake oval).
3. Flips, in the SAME diff, exactly:
   - `AI_CAMERA_ENABLED: true` (if not already lit)
   - `AR_BEAUTY_ENABLED: true`
   - `BEAUTY_ENABLED: true` and/or `AR_FACE_TRACKING_ENABLED: true`

Gate to proceed: tier-0 beauty verified against the CPU/GLSL golden matrix on
the device set; box tracking + smoothing verified on a FaceDetector device;
the honest refusal verified on Safari/Firefox.

## Stage 2 — the landmark engine (dependency-gated)

Only after the owner approves the MediaPipe face-landmarker dependency and
the self-hosted model-asset posture (ADR-014c §4):

1. Add the landmark-engine adapter (mapping the mesh to `LANDMARK_NAMES`) as
   a new dependency — its own reviewed PR, model assets self-hosted, the
   fence's dependency assertion updated to name it.
2. Register it via `engine.faceTracking.register(...)`; the registry's
   `landmarkAvailability()` flips from `NO_LANDMARK_ENGINE` to available.
3. Flip `BEAUTY_ADVANCED_ENABLED` (advanced beauty) and/or `AR_MASKS_ENABLED`
   (the mask compositor is authored in this same stage, anchored to the
   registered landmarks).

## Stage 3 — gestures and world AR

- Gestures: only after the hand-landmark engine dependency; then
  `AR_GESTURES_ENABLED`.
- World AR: only after the WebXR/native path is authored; then
  `AR_WORLD_ENABLED`. No simulated plane detection is ever shipped.

## Rollback

Every stage is one flag flip to revert. `AR_BEAUTY_ENABLED` (or the camera
master) darkens the whole module in one move; nothing here persists, so
rollback needs no data migration.
