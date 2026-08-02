# Creative Studio — feature map (CAM-4)

Module: `web/src/lib/studio/` (platform library, no UI surface) +
`web/api/studio-ai.js` (env-gated proxy). Everything ships DARK — see
`studio-activation.md` for the switch order and `adr/014d-creative-studio.md`
for the architecture. This file is the honest inventory: what is real and
local, what is real but manual, what exists only as a dark cloud leg, and
what is deferred on a named dependency.

## Legend

- **REAL-local** — implemented, deterministic, on-device, tested.
- **REAL-manual** — implemented on-device; the user drives it (no ML).
- **CLOUD-dark** — full client+server shell implemented; disabled three ways
  (client flag, server env flag, daily budget); sends image plaintext to a
  provider ONLY after the owner's D1 ratification.
- **DEFERRED-dep** — an adapter contract exists and refuses loudly; needs an
  owner-approved dependency/model before it can be real.

## The map

| Feature | Status | What exactly |
|---|---|---|
| Adjustments (exposure, contrast, saturation, temp/tint, highlights/shadows) | REAL-local | Float kernels, GPU preview twins, CPU export path |
| Curves | REAL-local | Monotone cubic → 256-LUT, per-channel + master (CPU) |
| Vignette, sharpen, clarity, grain | REAL-local | Unsharp mask, local contrast, seeded grain (grain/curves/blurs CPU-only; vignette has a GPU twin) |
| Geometry: crop, rotate, straighten, perspective | REAL-local | Inscribed-rect auto-crop; DLT homography |
| Looks (8 grades incl. 2 mono) | REAL-local | Procedural 3D LUTs — honestly named color grades, **not** AI |
| Object removal — small regions | REAL-local | Telea FMM inpaint, caps 60k px / 25% frame; small-object, low-texture envelope: wires, dust, small signs. Large holes come out blurry — by the method's nature, so oversize selections are REFUSED toward the cloud leg |
| Object removal — large/semantic | CLOUD-dark | `cloud.inpaint` → `/api/studio-ai?op=inpaint` |
| Mask brush | REAL-manual | Soft round brush, stroke interpolation, RLE persistence |
| Background replace — chroma key | REAL-local | Luma-normalized CbCr key + feather + spill suppression; works on screens/flat backdrops, not on busy scenes |
| Background replace — manual mask | REAL-manual | Brush mask + composite onto any asset background |
| Background replace — one-tap semantic | DEFERRED-dep | `ISegmenter` contract; candidate @mediapipe/tasks-vision (Apache-2.0) + self-hosted models — owner decision |
| Sky replace | REAL-local (heuristic) | Classic-CV mask (color+brightness+top-connectivity) + 4 procedural skies + fg tint. Honest failure cases: water reflections, blue objects near the top edge, dense branches, night shots — the mask is brush-correctable; semantic accuracy belongs to ISegmenter |
| Relight | REAL-local (2D tier) | Key light with luma headroom; NO depth — depth tier deferred with the segmenter/model decision |
| Neural style transfer | CLOUD-dark | `cloud.styleTransfer`; local looks are not sold as this |
| Stickers/avatars from photo | CLOUD-dark | `cloud.stickerFromPhoto` (subject cutout, transparent) |
| Caption suggestions | CLOUD-dark | `cloud.captionSuggest`, language-aware |
| Stories/reels composer | REAL-local | Timeline data model, Ken Burns, crossfade/slide/zoom, per-segment op-docs |
| Video export — WebCodecs | REAL-local (probed) | VP9/VP8 chunks muxed by our own WebM writer; **Opus audio passthrough** from MediaRecorder sources (no re-encode) |
| Video export — fallback | REAL-local (labeled) | MediaRecorder canvas capture: realtime, audio-less — both recorded in output metadata, never silently |
| Collage | REAL-local | 8 data-driven layouts, exact gutters, cover-fit, rounded corners |
| Templates | REAL-local | 6 versioned story/reel/collage presets expanding through the standard validators |
| Drafts | REAL-local | Op-docs in `spotme-studio-drafts` (never pixels), LRU 40/16 MB, TTL, corruption-tolerant, on the wipeDevice list |

## Relationship to the existing editor

`lib/photoedit.js` (WhatsApp-grammar flatten-on-send editor) and
`lib/crop.js` are untouched and remain the shipping edit path. The studio is
the next-generation layer beside them; whether photoedit later delegates to
the studio is an activation-time product decision.

## Stories view extension point

`views/stories.js` is READ-ONLY for this mission and currently renders
contact rings with an honest "posting arrives with the native app" note. The
composition ENGINE it will need is this module: at integration time the
posting flow calls `studio.templates.instantiate(...)` →
`studio.composer.renderVideo(...)` (or `studio.collage.render(...)`) and
hands the resulting Blob to the media pipeline. No view code is included
here by design — platform library only.

## Determinism and honesty rules baked into the code

- Exports render on the CPU path: same document + source ⇒ same bytes on
  every device. GPU is preview acceleration with per-op fallback, and the
  render result names the path each op actually took.
- Nothing ML-shaped is faked: the segmenter refuses until an engine is
  registered; oversize inpaints refuse toward the (dark) cloud leg; the
  MediaRecorder fallback cannot impersonate the real encoder because the
  metadata says which one ran.
