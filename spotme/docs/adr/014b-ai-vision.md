# ADR-014b — AI Vision (mission CAM-2)

**Status:** Partially implemented, SHIPPED DARK (every flag false,
fence-enforced). This is the *finishable subset* — see §4 for what is
deliberately deferred and why.
**Parent:** ADR-014 (platform umbrella). **Sibling:** ADR-014a (camera engine).
**Code:** `web/src/lib/vision/` (7 files, each <500 lines; the one dependency
is the pre-existing lazy `jsqr`).

## 1. What was built, and the one rule it obeys

The vision module builds on the camera engine's SEAM#1 (`FrameSource`) and its
shared image math. It obeys the platform honesty rule inherited from
`qr-scan.js`: **where the module cannot do something, the API answers
UNAVAILABLE with a machine-readable reason — never a degraded fake.** An OCR
that "reads" a blank string or a "translator" that echoes the source would
demo well and lie to the first user who trusts it; an empty seam refuses.

Shipped in this subset:

- **`scan` — barcode/QR, live and proven.** Dual-decoder engine: native
  `BarcodeDetector` (13 formats) preferred, lazy `jsQR` fallback (qr only),
  honest `NO_DETECTOR`/`NO_PIXEL_ACCESS`; continuous `scanFrames` over the
  camera FrameSource with dedup + backpressure. The one on-device leg that
  carries no owner dependency. (30 assertions.)
- **`createVision` factory** — the single front door, camera-engine idiom:
  default flags return an INERT stub that constructs nothing (no probe, no
  registry, no cloud client, no `env` read); shape parity with the live
  engine is fence-asserted so a dark call site cannot crash into `undefined`.
- **On-device seams** (`seams.js`) — an `ITextRecognizer` registry (OCR) and
  an `ITranslator` slot (photo translation), both EMPTY: they answer
  `NO_TEXT_RECOGNIZER` / `NO_TRANSLATOR` until a wiring PR registers an
  owner-approved engine, and they never fabricate a result.
- **The cloud CLIENT port** (`vision-cloud.js`) — typed ops over
  `/api/vision-ai` for the cloud legs, DARK: with `VISION_CLOUD_ENABLED` off
  (shipped) every op returns `CLOUD_DISABLED` with zero egress, zero fetch.
  Fully dependency-injected; imports nothing outside `lib/vision`.
- **The vision fence** (`test/vision-fence.test.js`) — proves the module is
  built, not wired, ships dark, cannot egress or persist, adds no dependency,
  and (after build) is tree-shaken out of `dist/`.

## 2. Decisions and their reasons

### 2.1 The flag tree parents to the camera master
`AI_CAMERA_ENABLED` → `AI_VISION_ENABLED` → capability flags, with
`VISION_MEDICAL_INFO_ENABLED` a CHILD of `VISION_ASSISTANT_ENABLED` (the
safety layer can never be dark under a lit medical leg) and
`VISION_CLOUD_ENABLED` parenting every provider leg. The platform master's
default is IMPORTED from `../camera/flags.js`, never restated, so the two
modules cannot disagree about the shipped state. Turning the master off
darkens camera AND vision in one move.

### 2.2 The D1 boundary is held in code, not just in prose
Every cloud leg (recognize, assistant, shopping, cloud OCR, cloud photo
translate) is gated on `VISION_CLOUD_ENABLED`, checked BEFORE any byte is
serialized. Flipping it is the owner's D1 plaintext-boundary decision
(`priority-2/91-ENGINEERING-RISK-REGISTER.md` D1). The client port carries
the gate; the server endpoint (authored at activation) carries its own
independent env gate, so a client bug can never outrun the owner's decision.

### 2.3 lib/vision imports only itself, `../camera/`, and jsQR
The vision fence allows exactly those and forbids every other package, app
module, or view — the same bidirectional cleanliness the camera fence
enforces, extended to the platform sibling relationship.

## 3. Owner decisions this mission still waits on

None of the following is assumed; each blocks a specific unbuilt leg:

- **OCR engine dependency** — tesseract.js on-device (Apache-2.0) is the named
  candidate for the `ITextRecognizer` seam; not added until the owner
  approves the dependency.
- **D1 cloud provider boundary** — the provider matrix, per-op cost caps, and
  the server endpoint `api/vision-ai.js` are authored only after the owner
  answers the D1/D5 register. Until then recognize/assistant/shopping/photo-
  translate are honest `CLOUD_DISABLED` refusals.
- **Medical-info policy** — `VISION_MEDICAL_INFO_ENABLED` is additionally
  owner-policy-gated on top of the assistant safety layer.
- **Translator port** — the #51 translation-platform adapter is written at
  integration time, documented not imported here.

## 4. Deliberately deferred — the document scanner

An on-device document scanner (quad detection → homography rectification →
adaptive-threshold enhancement → multi-page PNG assembly) was drafted but
landed **unreviewed and failing its own golden tests** (11/36: clean
high-contrast pages returned `NO_QUAD_FOUND`, and the homography solver did
not reject degenerate/collinear inputs). Per the honesty rule and the owner's
"finishable subset only" scope, it is **NOT shipped as a working leg**: the
`VISION_DOCSCAN_ENABLED` flag is reserved but the factory does not expose it,
and the drafted code is preserved on branch
`wip/ai-vision-docscan-unreviewed` for a future mission that finishes it to
the platform bar (real geometry fixes, then the golden suite green). This
ADR records the gap rather than papering over it.

## 5. Status of the honesty rule

Every capability in this module answers the vision UNAVAILABLE vocabulary; no
leg returns a fabricated recognition, translation, or scan. The proven legs
are proven by tests that would fail without them; the unbuilt legs refuse
with a named reason. That distinction — proven vs. refused, with nothing in
between pretending — is the whole point of the subset.
