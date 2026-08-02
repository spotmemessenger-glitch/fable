# ADR-014 — The AI Camera & Creative Studio platform (umbrella)

**Status:** Approved as the platform umbrella; mission CAM-1 (camera engine)
is implemented DARK behind flags. Missions 2–4 are planned as companion ADRs
**014b (AI vision), 014c (AR & beauty), 014d (creative studio)** — each must
be written and reviewed before its mission ships code.
**Depends on:** Roadmap V2 §2 rules + Owner Amendment 2026-08-01 (AI features
optimise accuracy + latency + privacy simultaneously; no hard provider
dependency), the on-device-first posture of the AI communication platform
work, ADR-008 §12 (untouched by this work — the camera platform contains no
cryptography).

## Why a platform and not four features

Camera capture, AI vision, AR/beauty and creative tooling all consume the
same three scarce things: the live camera stream, per-frame compute budget,
and the user's trust that the most privacy-sensitive sensor on the device is
doing only what the screen says it is doing. Built separately they would each
open their own streams, run their own frame loops, and make their own privacy
mistakes. Built as a platform there is exactly one capture pipeline (mission
CAM-1, this umbrella's first child), and every later mission is a CONSUMER of
its seams:

```
mission 1  camera engine   lib/camera/   capture, stills, video,
                                          computational photography
mission 2  AI vision       (014b)        consumes FrameSource; models,
                                          scene/object understanding
mission 3  AR & beauty     (014c)        consumes the pipeline stage chain
                                          + ISegmenter registry
mission 4  creative studio (014d)        consumes capture outputs; editing,
                                          composition, export
```

## The platform decisions every mission inherits

1. **One flag tree, one root.** `AI_CAMERA_ENABLED` in
   `web/src/lib/camera/flags.js` is the platform master. Every mission's own
   flags parent to it (directly, or through their mission root added to
   `FLAG_PARENT`). A child is effective only under a fully-lit ancestor
   chain; turning the master off darkens the entire platform in one move
   with no data migration — nothing in the platform persists.
2. **Ship dark, prove dark.** Every flag defaults false with no runtime
   override; `assertShippedDark` and the fence test
   (`web/test/camera-fence.test.js`) fail the build on any drift, on any app
   import of the module, and on any camera identifier surviving into
   `dist/`. Each mission extends the fence to its own files.
3. **Zero egress from the platform library.** Frames, masks, metrics,
   settings — nothing leaves the device from `lib/camera/**`. Mission 2 will
   need a provider decision for cloud models; that is 014b's central
   question, decided under the Owner Amendment's accuracy+latency+privacy
   rule and the D1-style plaintext-boundary posture (any provider egress is
   an explicit, owner-approved, default-OFF boundary) — never a default, and
   never inside this library.
4. **Capability honesty.** Every capability is feature-detected and reported
   as data: `{available:false, reason}` with a closed-set machine-readable
   reason (`availability.js`). Web-impossible features are DEFERRED_NATIVE
   (Capacitor, P10) with the adapter contract documented — never simulated.
5. **The seams are the contract.** Missions build against `FrameSource`
   (frames with backpressure), the pipeline stage chain (ordered pure
   stages, GL/CPU twins), and `ISegmenter` (mask engines). Breaking a seam
   is a platform decision requiring this ADR's revision, not a mission's
   local edit.
6. **No new dependency without an owner decision.** CAM-1 ships with zero.
   Known future decision points are logged in 014a §Owner decisions
   (MediaPipe segmentation) and will recur in 014b (models) — each is an
   explicit ADR-recorded owner call, on-device-first.
7. **UI arrives separately.** The platform is a library; every mission's
   user surface lands in its own owner-approved wiring PR flipping explicit
   flags (activation-guide.md), so capture capability and user exposure are
   independently reviewable and reversible.

## Consequences

- The app is byte-identical while dark (proven by the bundle fence); the
  platform can be developed, tested and benchmarked at full production
  quality without any user exposure.
- Later missions cannot accidentally open cameras: session opening lives
  behind the engine factory, which is inert until the chain is lit.
- The cost: nothing here is user-visible until wiring PRs land, and the
  fence must be maintained as missions 2–4 add files.

## Companion documents

- `docs/adr/014a-camera-engine.md` — mission CAM-1's decisions (this repo,
  implemented).
- `docs/ai-camera/architecture.md` — the platform picture, per-mission
  sections filled as each lands.
- `docs/ai-camera/threat-model.md`, `security-review.md`,
  `activation-guide.md`, `rollback-plan.md`, `ops-guide.md`,
  `production-checklist.md`, `benchmark-report.md`, `developer-guide.md`,
  `camera-engine.md`.
