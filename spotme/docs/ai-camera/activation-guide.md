# Camera engine — activation guide (the path from dark to lit)

Nothing in this guide happens without an OWNER-approved wiring PR. The
engine ships with every flag false and no runtime override; activation is
a sequence of small reviewed diffs, each independently revertible
(rollback-plan.md), in this order.

## Stage 0 — prerequisites (before any flag moves)

- [ ] Manual device matrix rows for the target platforms filled
      (production-checklist.md) — capability honesty verified on hardware.
- [ ] Security review's wiring checklist (security-review.md §wiring PR)
      acknowledged in the PR description.
- [ ] Owner decisions resolved as needed: segmenter dependency (ADR-014a
      §4.1) only if portrait is in scope; P10 items stay deferred.

## Stage 1 — the wiring PR (capture core only)

The first PR that imports `lib/camera/index.js`:

1. Adds the camera UI surface (its own view work, reviewed for T2/T3/T4 of
   the threat model: release on every exit path, outputs into the existing
   media path, nothing server-bound).
2. Flips, in the SAME diff, exactly:
   - `AI_CAMERA_ENABLED: true`
   - `CAMERA_ENGINE_ENABLED: true`
   (the factory goes live; every capability still FLAG_DISABLED).
3. Updates the fence test intentionally: the no-import check moves from
   "zero importers" to "exactly the approved wiring modules" — the same
   deliberate-change pattern signing-not-shipped.test.js documents.
   Deleting the fence is never the move; NARROWING it is.
4. Ships basic capture only: open/switch/release + preview + still +
   the flagless always-on parts of the engine surface.

Gate to proceed: capture works on the matrix devices; permission and
release behaviour verified by hand; no regression in the existing suites.

## Stage 2 — capability flags, one PR each, this order

Ordered by blast radius (pure-output features first, hardware-control
features later):

| Order | Flag | Ships | Why this position |
|---|---|---|---|
| 2.1 | `CAMERA_VIDEO_ENABLED` | recorder + caps + segments | most-wanted, least novel; uses only MediaRecorder |
| 2.2 | `CAMERA_BURST_ENABLED` | burst + picker UI | bounded memory, no controls |
| 2.3 | `CAMERA_TIMELAPSE_ENABLED` | lapse capture/assembly | timer-driven, bounded |
| 2.4 | `CAMERA_NIGHT_ENABLED` | stacking on capture | pure math on frames |
| 2.5 | `CAMERA_STABILIZATION_ENABLED` | TIER_BASIC EIS | pure math; CPU/GL cost verified on device first (benchmark appendix) |
| 2.6 | `CAMERA_PRO_CONTROLS_ENABLED` | torch/zoom/EV/ISO… UI | device-control surface; per-control honesty already enforced |
| 2.7 | `CAMERA_HDR_ENABLED` | bracket + fusion | depends on pro-control exposure path (2.6) |
| 2.8 | `CAMERA_SLOWMO_ENABLED` | high-fps capture + retiming | most device-variable; needs matrix rows for high-fps devices |
| 2.9 | `CAMERA_PORTRAIT_ENABLED` | ISegmenter consumer | LAST: blocked on the owner's segmenter decision below |

Each PR: one flag line + its UI + matrix evidence for that feature. Each
is reverted by re-flipping its line.

## Owner decisions (explicit, still open)

1. **Portrait segmenter (blocks 2.9):** approve `@mediapipe/tasks-vision`
   (Apache-2.0; first ML dependency; ~5 MB wasm+model, lazily loaded) and
   register it as the ISegmenter — or defer portrait to the P10 native
   depth adapter. The engine refuses honestly until one exists; nothing
   else in the platform waits on this.
2. **P10 native adapter scope:** RAW/DNG, gyro EIS (TIER_ADVANCED),
   native depth, full-res iOS stills. One scoped native work item; each
   lands as an ISegmenter-style adapter behind the SAME availability
   envelopes (the reasons flip from DEFERRED_NATIVE to available where the
   adapter is present).
3. **This ordering itself** — proposed, owner-amendable at Stage 1 time.

## What never activates via flags

- Egress of any frame/metric (structurally absent; adding it would be a
  new ADR, not a flag).
- Any crypto interaction (ADR-008 §12 lane is untouched by this platform).
