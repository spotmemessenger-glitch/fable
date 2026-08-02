# ADR-014d — Creative Studio (AI Camera platform, CAM-4)

Status: **Accepted (shipped dark)** · Date: 2026-08-02 · Owner mission: CAM-4
Parent: ADR-014 (AI Camera platform umbrella — owned by the camera-engine
mission; it did not exist on this branch's base commit, so this ADR is
self-contained and will be linked from the umbrella at integration time).

## 1. Context

Spot Me's current editing surface is `lib/photoedit.js` — a WhatsApp-grammar
flatten-on-send editor (crop/rotate, stickers, text, pencil) — plus
`lib/crop.js` (avatar crop). Both are single-pass and destructive by design.
The AI Camera roadmap needs a professional, non-destructive editing platform:
adjustment layers, real removal/replace tools, stories/reels composition,
collage, templates, drafts, and clearly separated cloud-AI legs. This module
is that platform. It deliberately does **not** modify or replace photoedit —
it is the next-generation layer built beside it; retiring or bridging the old
editor is a product decision for activation time, not a side effect of this
build.

Constraints that shaped everything: zero new npm dependencies; everything
ships dark behind flags with a byte-clean bundle; privacy first (editing is
local-only; anything that sends image content to a provider is owner-gated —
priority-2 D1 decision, default OFF); no fake AI — ML-dependent features are
adapter contracts and dark cloud legs, never simulated locally.

## 2. Decision

A platform **library** at `web/src/lib/studio/` (no UI surface), fully
dependency-injected, with one serverless proxy `api/studio-ai.js`.

### 2.1 Non-destructive core: the op-doc

An edit is data: `{kind:'spotme-studio-opdoc', v:1, source, assets[], ops[]}`
— an ordered list of typed, versioned, JSON-pure ops. The evaluator renders
`source + ops[0..cursor]` from scratch; undo/redo is a cursor move (document
slicing); serialization is stable-keyed so identical edits are identical
bytes. Assets (replacement backgrounds) are referenced by id, resolved by the
caller — a document never embeds pixels; masks travel as bounded RLE.

**Alternatives considered.** (a) Layer-stack model (Photoshop-style): more
general, but per-layer pixel caches multiply memory on a phone and the
product surface (sliders + tools) maps 1:1 onto an op list. (b) Command
pattern with inverse ops: undo via inverse requires every op to be exactly
invertible (inpaint is not); re-render-from-source makes undo trivially
correct. (c) Storing rendered intermediates in drafts: rejected — drafts of
op-docs are ~KB and re-render deterministically.

### 2.2 Dual-path evaluation: CPU truth, GPU preview

Every op has a mandatory CPU implementation over plain
`{width,height,data:Uint8ClampedArray}` — byte-deterministic, Node-testable,
memory-bounded via a tiling plan (per-op declared overlap). Per-pixel color
ops additionally carry GLSL twins run by a minimal WebGL2 runtime (one
fullscreen triangle, ping-pong FBOs, chain locality, every failure → null →
CPU fallback per op; the render result reports the path each op took).

**Determinism policy.** Exports render on CPU (same bytes on every device —
the property golden tests and draft re-rendering stand on). GPU floats are
preview-only unless a caller opts in. The float arithmetic is defined once in
`kernels.js`; CPU wraps it, GLSL transcribes it, and tests hold the byte path
to the float reference within quantization tolerance — so the twins cannot
drift silently. Honest GPU coverage: curves/LUT ops (would need a LUT
texture), two-pass blurs (sharpen/clarity), and seeded grain are CPU-only
today rather than shipping approximations that make preview disagree with
export.

### 2.3 Real algorithms, named

Adjustments: exposure/contrast/saturation/WB/highlights-shadows (float
kernels), curves (Fritsch–Carlson monotone cubic → 256-LUT), vignette,
unsharp-mask sharpen, midtone-weighted local-contrast clarity, seeded
(mulberry32) luma-modulated grain. Geometry: crop, lossless 90° rotate,
straighten with exact largest-inscribed-rect, perspective via DLT homography
(partial-pivot solve, degenerate quads refused by self-verification). Looks:
procedural 3D LUTs (17³, trilinear apply, strength blend) from a frozen
parameter set — honestly named color grades, never "AI". Removal local tier:
Telea-2004 fast-marching inpainting + Jacobi refinement with hard caps
(60k px / 25% of frame) that refuse rather than degrade. Background replace:
luma-normalized CbCr chroma key, gaussian mask feather, edge-band spill
suppression, over-composite. Sky: classic-CV heuristic mask (color +
brightness + top-connectivity) + procedural gradient skies + sky-tinted
foreground. Relight: 2D key light with luma headroom — the no-depth tier,
labeled as such; a depth tier waits for an owner-approved model.

### 2.4 Composer, collage, templates

Timeline as validated data (segments, per-segment op lists through the same
evaluator, eased Ken Burns, overlap-checked transitions); pure timing math;
CPU frame renderer with real crossfade/slide/zoom. Video encode: WebCodecs
probed honestly (isConfigSupported awaited) muxed by a from-spec minimal
EBML/WebM writer (clusters, SimpleBlocks, signed-16-bit rel-ts bound), with
Opus **passthrough** (packets extracted from MediaRecorder WebMs by our own
reader — no re-encode); fallback is MediaRecorder canvas capture — realtime
and audio-less, both facts recorded in output metadata. Collage: layouts as
data + one exact renderer (gutters, cover-fit, anti-aliased corner radius).
Templates: versioned data expanding through the same validators user input
passes; unknown versions refused.

**Alternative considered:** shipping a muxer dependency (mp4-muxer/
webm-muxer) — rejected by the zero-dependency rule; the needed WebM subset is
~300 lines and is proven by its own reader in tests.

### 2.5 Cloud legs (dark) and the ISegmenter seam

Four typed ops — inpaint (large/semantic), styleTransfer, stickerFromPhoto,
captionSuggest — exist as: a client adapter that **rejects before any byte is
serialized** unless `STUDIO_CLOUD_AI_ENABLED` is on, and `api/studio-ai.js`,
which follows the translate/voice proxy conventions (CORS allow-list, HS256
gate, per-user per-minute limits) plus two of its own: server env flag
`STUDIO_AI_ENABLED` absent ⇒ 501 before body parsing (owner D1), and a
per-user daily budget (D5). Provider routing (OpenAI / Gemini / Azure OpenAI
per op, env-selectable) is real request construction with keys server-side
only; image bytes are never logged (tested). On-device semantic segmentation
is an adapter contract (`ISegmenter`) that refuses loudly until the owner
approves an engine — candidate: `@mediapipe/tasks-vision` (Apache-2.0) with
self-hosted model assets.

### 2.6 Drafts

`spotme-studio-drafts` IndexedDB: serialized op-docs + refs (never pixels),
validated on write, LRU-capped (40 / 16 MB), TTL-honoring (a draft born from
a disappearing-message chat takes that chat's msgTtl), corruption-tolerant
(bad rows skipped+counted+deleted), absent-storage-safe, and on the
`wipeDevice()` list — the one line this module adds to `db.js`.

## 3. Security & privacy

- Local-only by default: with shipped flags there is **zero egress** — the
  adapter's dark state is observed by test (fetch fake never called).
- The cloud boundary is triple-gated: client flag (owner activation), server
  env flag (D1 ratification), daily budget (D5). No client can outrun the
  server gate.
- EXIF is read for orientation only; exports re-encode via canvas and carry
  no metadata — GPS stripping by construction (threat model §metadata).
- Input validation at every boundary: op params, RLE masks (cover-exact,
  run-capped), timeline caps, endpoint byte/dimension caps, JWT pinned to
  HS256 (shared `_auth.js`).
- No image bytes in logs, server or client (tested with a payload marker).
- Full analysis: `docs/ai-camera/studio-threat-model.md`.

## 4. Scalability & performance

Preview renders at a bounded scale (≤1600 edge / 2.6 MP) with GPU
acceleration where available; exports run tiled CPU (4 MP tiles, per-op
overlap) so a 48 MP bound is a plan, not an allocation. Measured CPU numbers
(median, Node, 4-core Xeon container — a floor, not a phone):
1 MP per-op 4–110 ms (clarity 514 ms is the outlier; it is a 16σ blur),
12 MP exposure 2.2 s / look 0.7 s / clarity 7.6 s; inpaint ≤30 ms at its
caps; 720p composer frame ~103 ms. Full tables + scope caveats:
`docs/ai-camera/studio-benchmarks.md`. GL preview and encoder throughput are
device measurements owed before activation (checklist in
studio-activation.md).

## 5. Observability

The evaluator's per-op path report (`gpu`/`cpu`) makes acceleration
observable; render metadata names the encoder, codec, realtime-ness and audio
state of every export; drafts surface skipped-corrupt counts; the endpoint
logs op + byte counts only. At activation, these are the fields to feed the
product's metrics pipe — no new telemetry is invented here while dark.

## 6. Testing

11 suites / 196 checks in the repo's harness: kernel-twin tolerance, golden
vectors (inpaint constant/gradient, chroma, sky, WebM round-trip incl. Opus),
determinism, flag algebra, endpoint shell (501/caps/budget/no-byte-logging),
drafts lifecycle incl. wipe, and a fence suite proving import isolation, the
inert factory (throwing fakes), and a dist audit (no studio strings except
the wipe DB name — verified against a real build). Full app suite stays
green: 57 files, 1130/1130.

## 7. Deployment & rollback

Ships dark: all flags false, module tree-shaken out (dist byte-clean but for
the wipe line), endpoint answers 501 without its env flag. Activation is
staged per `studio-activation.md` (flag order + owner decisions). Rollback at
any stage = flip the flag(s) off / unset `STUDIO_AI_ENABLED`: documents are
data, so nothing corrupts; drafts of disabled features simply stop opening
(records remain until wipe/TTL); the DB wipe line is a safe no-op when the DB
never existed. No migration exists to roll back.

## 8. Evolution

- Op/document/template/timeline versions are all explicit; v2 of anything
  adds a migration in its own module — unknown versions are refused today.
- Looks and templates are frozen by id; taste changes mint new ids so old
  drafts keep rendering what the user saved.
- Seams left deliberately: multi-pass GL (for blur twins + transitions on
  GPU), an aux-texture LUT path, a depth-tier relight behind ISegmenter-like
  owner approval, Redis-backed endpoint budgets before scale-out, and the
  AI_CAMERA_ENABLED parent wiring (documented in flags.js because CAM-1's
  flag cannot be imported from this branch).
