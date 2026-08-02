# Creative Studio — activation runbook (CAM-4)

Everything ships DARK. This file is the ordered path from dark to lit, the
owner decisions that gate each stage, and the rollback story at every step.
Nothing below is done implicitly; each stage is a deliberate flag flip in a
reviewed change (V2 §2 rule 6: flags default safe, rollback documented).

## 0. Standing preconditions (before ANY flag flips)

- [ ] Integration wiring lands: `CREATIVE_STUDIO_ENABLED` parented under the
      platform master `AI_CAMERA_ENABLED` (owned by CAM-1; could not be
      imported on this branch — flags.js documents the exact edit).
- [ ] A UI surface exists that calls `createStudio()` with real deps
      (`getAuthHeaders` from lib/auth-headers.js, `indexedDB`,
      `OffscreenCanvas` factory). This module ships none by design.
- [ ] Device benchmarks appended to studio-benchmarks.md: GL preview path on
      low/mid Android WebView + iOS, WebCodecs encode throughput, and the
      MediaRecorder fallback exercised on one device that lacks WebCodecs.
- [ ] The evaluator's per-op gpu/cpu path report and render metadata are
      wired into whatever metrics pipe the product uses (V2 §8: monitoring
      before high-risk enablement).

## 1. Flag order (each stage independently rollback-able by flipping back)

| stage | flags | unlocks | rollback effect |
|---|---|---|---|
| 1 | `CREATIVE_STUDIO_ENABLED` + `STUDIO_EDITOR_ENABLED` | non-destructive editor (adjustments, curves, geometry) | editor gone; no data at risk (docs are data) |
| 2 | `STUDIO_LOOKS_ENABLED` | the 8 looks | look ops in existing drafts refuse to render until re-enabled |
| 3 | `STUDIO_DRAFTS_ENABLED` | draft persistence | store answers `disabled`; existing records inert until wipe/TTL |
| 4 | `STUDIO_OBJECT_REMOVAL_ENABLED` | brush + local Telea inpaint | as stage 1 |
| 5 | `STUDIO_BG_REPLACE_ENABLED`, `STUDIO_SKY_ENABLED`, `STUDIO_RELIGHT_ENABLED` | keying, sky, 2D relight | as stage 1 |
| 6 | `STUDIO_COLLAGE_ENABLED`, `STUDIO_TEMPLATES_ENABLED` | collage + templates | as stage 1 |
| 7 | `STUDIO_COMPOSER_ENABLED` | stories/reels render | as stage 1 |
| 8 | `STUDIO_CLOUD_AI_ENABLED` **+ server `STUDIO_AI_ENABLED=1`** | cloud legs | client rejects again with zero egress; server 501s |

Stage 8 is additionally gated by owner decisions D1/D5 below — the flag flip
is the LAST step, never the first.

## 2. Owner decisions (named, blocking)

### D1 — provider-plaintext boundary (default OFF; blocks stage 8)
Cloud ops send user image plaintext to a third-party provider. Before
ratification the owner needs: which providers (matrix below), their
retention/training posture and DPA status, per-op user consent UX (the
"cloud" labeling grammar translate.js established), and regional
availability. Until then the server env flag stays absent and the endpoint
answers 501 to everyone, authenticated or not.

### D2 — segmenter engine (blocks one-tap semantic masks + depth relight)
Candidate: `@mediapipe/tasks-vision` (Apache-2.0) + **self-hosted** model
assets (no runtime CDN; assets vendored and version-pinned). Decision covers:
license acceptance, asset hosting/size budget (selfie-segmenter ≈16 MB),
device floor. Wire by calling `studio.removal.segmenter.register(engine)`;
until then the slot refuses loudly and the UI must not show one-tap cutout.

### D3 — provider matrix + env routing (stage 8 detail)

| op | default | alternates | env override |
|---|---|---|---|
| inpaint | OpenAI images/edits (mask-aware) | Gemini image, Azure OpenAI | `STUDIO_AI_PROVIDER_INPAINT` |
| style | Gemini image out | OpenAI, Azure OpenAI | `STUDIO_AI_PROVIDER_STYLE` |
| sticker | OpenAI (transparent bg) | Gemini | `STUDIO_AI_PROVIDER_STICKER` |
| caption | Gemini (vision, cheapest/call) | OpenAI, Anthropic vision | `STUDIO_AI_PROVIDER_CAPTION` |

Owner amendment principle applies: **no provider may become a hard
dependency** — routing is env-switchable per op, and a provider outage
degrades one op, not the studio.

Keys (server env only, never client): `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`AZURE_OPENAI_KEY` + `AZURE_OPENAI_ENDPOINT` (+ optional
`AZURE_OPENAI_IMAGE_DEPLOYMENT`, `STUDIO_AI_GEMINI_IMAGE`,
`STUDIO_AI_GEMINI_TEXT`, `STUDIO_AI_LEG_MS`).

### D5 — cost governance (blocks stage 8, with D1)
Server enforces per-user 6 image-ops/min, 20 captions/min, and
`STUDIO_AI_DAILY_OPS` (default 50/user/day) — set the number deliberately
against provider pricing before enabling. KNOWN LIMIT (documented in code):
budgets are in-process — exact on the single Railway instance, per-instance
on serverless; move to the backend's Redis before any scaled activation.

### D6 — template/content policy
Shipped templates are neutral data. Before any user-shared or downloadable
template surface exists, the owner must decide the review/moderation policy;
the versioned schema refuses unknown versions, but policy is not a schema.

## 3. Drafts + disappearing messages (integration REQUIREMENT)
Any surface that opens the studio FROM a conversation with `msgTtl` set MUST
pass `ttlMs: msgTtl` to `drafts.save(...)` so edit history dies no later
than the message it edits (threat model T1). This is a launch-gate review
item for stage 3, not a nice-to-have.

## 4. Rollback drill (what flipping off actually does)
Flags are data checked at call time: no rebuild is needed beyond shipping the
flag change. Documents/drafts are inert data — nothing migrates, so nothing
corrupts. `STUDIO_AI_ENABLED` unset returns the endpoint to 501 instantly.
`wipeDevice()` covers the drafts DB in every state, including never-created
(no-op success). The dist fence test (`studio-fence.test.js` (e)) re-proves
the dark bundle whenever flags return to false.
