# ADR-014c — AR & Beauty (mission CAM-3)

**Status:** Partially implemented, SHIPPED DARK (every flag false,
fence-enforced). This is the *finishable subset* — see §4 for what is
deferred and why.
**Parent:** ADR-014 (platform umbrella). **Siblings:** ADR-014a (camera),
ADR-014b (vision).
**Code:** `web/src/lib/ar/` (9 files, each <500 lines; zero dependencies).

## 1. What was built, and the one rule it obeys

The AR/beauty module builds on the camera engine's shared clock and image
math. It obeys the platform honesty rule: **where a platform or a missing
engine cannot do something, the API answers UNAVAILABLE with a
machine-readable reason — never a degraded imitation.** A "face tracker" that
draws a centred oval, or a "smile detector" guessing from a bounding box,
would demo well and be a lie; the closed AR vocabulary exists to refuse them.

Shipped in this subset — every capability is **implemented and testable
inside the gated module, but NOT wired into the app and NOT user-accessible**
(all flags ship false):

- **`beauty` (tier-0) — implemented behind disabled flags.** Skin-masked
  separable bilateral smoothing (YCbCr Chai&Ngan skin classifier + shadow
  gate), tone+warmth (S-curve/flatten + R/B shift), and headroom brighten —
  three pipeline stages, each with a **CPU and GLSL implementation built to
  matched formulas and covered by deterministic CPU-side tests** (real-GPU
  visual/numerical equivalence remains UNPROVEN — no headless GPU here), and
  hard `BEAUTY_LIMITS` naturalness caps. Needs no landmarks. (35 assertions.)
- **`faceTracking` — the seam + one real adapter, behind disabled flags.** An
  `IFaceTracker` registry with a validated contract, the platform
  Shape-Detection **box adapter** (functional where Chromium/Android ships
  `FaceDetector`, honest `NO_PLATFORM_FACE_DETECTOR` elsewhere — untested on
  real hardware), and EMA box/landmark temporal smoothing with greedy-IoU
  identity and hysteresis/coast. Boxes only — the adapter promises no
  landmarks it cannot guarantee. (40 + 22 assertions.)
- **`createArBeauty` factory** — the single front door, camera-engine idiom:
  default flags return an INERT stub that constructs nothing; shape parity
  with the live engine is fence-asserted.
- **The ar fence** (`test/ar-fence.test.js`) — built, not wired, dark, no
  egress/persistence, no dependency, <500 lines, tree-shaken from `dist/`.

## 2. Decisions and their reasons

### 2.1 The flag tree parents to the camera master
`AI_CAMERA_ENABLED` → `AR_BEAUTY_ENABLED` → capability flags, with
`BEAUTY_ADVANCED_ENABLED` a CHILD of `BEAUTY_ENABLED` (the landmark-gated
tier cannot exist without the base tier). The platform master's default is
MIRRORED from `../camera/flags.js`, never forked. Master off darkens the
whole module in one move.

### 2.2 The landmark-mesh slot is deliberately empty
Advanced beauty, masks, and face gestures all anchor to face/hand landmarks.
Rather than approximate landmarks from a bounding box (which whitens chins
and mis-anchors masks), the registry's `landmarkAvailability()` answers
`NO_LANDMARK_ENGINE` until an owner-approved engine (MediaPipe
face-landmarker + self-hosted model assets, §4) is registered. Absent means
absent.

### 2.3 No crypto, no egress, no persistence
Face geometry never leaves the device from this module; the fence proves no
`lib/ar` file can open a network path, touch storage, or import crypto.

## 3. Owner decisions this mission still waits on

- **Face-landmark engine dependency** — MediaPipe face-landmarker (Apache-2.0
  code) plus **self-hosted model assets**; not added until the owner
  approves the dependency and the asset-hosting posture (ADR-014c §4). This
  unblocks advanced beauty and masks.
- **Hand-landmark engine dependency** — the same class of decision, unblocks
  gestures.
- **World AR path** — WebXR immersive-ar and/or the P10 native layer
  (ARCore/ARKit); deferred, not simulated.

## 4. Deliberately deferred — landmark, gesture, mask, world legs

The following ship as honest refusals, NOT working legs, because each blocks
on an owner dependency or a deferred platform path:

| Leg | Refusal until… |
|---|---|
| Advanced beauty | a face-landmark engine is registered (`NO_LANDMARK_ENGINE`) |
| Masks | a face-landmark engine is registered (`NO_LANDMARK_ENGINE`) |
| Gestures | a hand-landmark engine exists (`NO_HAND_ENGINE`) |
| World AR | WebXR/native is wired (`DEFERRED_WEBXR`) |

None is faked from boxes or a gyro guess. The reserved flags exist so the
wiring PRs have a home; the capabilities light only when the owner's
dependency decisions land.

## 5. Status of the honesty rule

Every capability answers the AR UNAVAILABLE vocabulary; no leg returns a
fabricated tracking, landmark, or plane. Proven legs are proven by tests that
would fail without them; unbuilt legs refuse with a named reason. Nothing in
between pretends.
