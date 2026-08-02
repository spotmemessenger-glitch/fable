# Creative Studio — benchmarks (CAM-4)

Append-style record. Each entry: environment, raw results, median, tail
(Roadmap V2 §8). Reproduce with `node test/bench/studio.bench.mjs` from
`spotme/web/`.

## Scope and honesty

Measured: the **CPU path** — deterministic export rendering, the worst case
and the only path Node can measure honestly. NOT measured here (owed on real
hardware before activation, see studio-activation.md): the WebGL2 preview
path (device/driver-dependent), video ENCODING throughput (WebCodecs /
MediaRecorder are browser-only; the composer numbers below are frame
COMPOSITION only), and IndexedDB draft I/O (same store behavior
`idb-bench.mjs` measures). This container is a FLOOR, not a phone: phone CPUs
are slower and thermally throttled.

---

## 2026-08-02 — baseline at branch feat/creative-studio

Env: node v22.22.2, Intel Xeon @ 2.10 GHz ×4 (container), linux x64.
Commit: 17708fe (numbers identical in reruns within noise).

### Per-op, 1 MP (1155×866), 5 reps, ms

| op | median | p90 | raw |
|---|---|---|---|
| exposure | 96 | 101.1 | 101.1, 93.6, 95.5, 99.6, 96 |
| contrast | 65.9 | 84 | 84, 77.3, 63.5, 65.9, 62.7 |
| saturation | 65.9 | 70 | 68.6, 70, 65.9, 64.1, 64 |
| temperature | 60.8 | 64.8 | 61.1, 60.8, 58.3, 58.9, 64.8 |
| highlights_shadows | 59.8 | 67 | 67, 59.8, 58.5, 58.4, 61.5 |
| curves | 4.3 | 7.4 | 7.4, 4.4, 4.1, 4.2, 4.3 |
| look (3D LUT) | 55.8 | 66.5 | 66.5, 55.9, 53.5, 54.4, 55.8 |
| vignette | 16.3 | 21.7 | 21.7, 16.5, 16.3, 16.3, 15.7 |
| grain | 29.3 | 36.6 | 36.6, 29.3, 29.8, 17.8, 17.5 |
| sharpen (σ1.5) | 111.6 | 150.1 | 119.1, 111.6, 111.3, 106.2, 150.1 |
| clarity (σ16) | 513.7 | 520.4 | 513.7, 515.2, 520.4, 505.1, 497.5 |
| straighten (3°) | 43 | 49.7 | 49.7, 43.2, 43, 42.7, 35.1 |
| perspective | 57 | 70.2 | 70.2, 56.7, 57, 56.5, 57.3 |

### Per-op, 12 MP (4000×3000) — export worst case, ms

2 reps; [1 rep] where marked (the bench stays runnable).

| op | median | raw |
|---|---|---|
| exposure | 2155.1 | 2144.7, 2155.1 |
| contrast | 990.4 | 990.4, 868.7 |
| saturation | 941.8 | 941.8, 915.5 |
| temperature | 895.7 | 895.7, 739.5 |
| highlights_shadows | 917.9 | 791.3, 917.9 |
| curves | 315 | 315, 153.5 |
| look (3D LUT) | 740.1 | 738.3, 740.1 |
| vignette | 275.7 | 201.1, 275.7 |
| grain | 242.7 | 242.1, 242.7 |
| sharpen | 1484.8 | [1 rep] |
| clarity | 7646.6 | [1 rep] |
| straighten | 449.1 | [1 rep] |
| perspective | 735.1 | [1 rep] |

**Reading.** Per-pixel ops scale ~linearly with pixels (≈12× from 1 MP →
12 MP, JIT noise aside). A realistic 5-op export chain at 12 MP lands ≈4–6 s
on this container — acceptable for an explicit export with progress; the
clarity outlier is a 16σ separable blur and the first candidate for a GPU or
downsampled-pyramid pass if hardware numbers demand it. Interactive preview
never runs these sizes: it renders ≤2.6 MP with the GPU path covering the
scrubbed sliders.

### Inpaint cost vs region size (400×300 frame, radius 4, refine 6, 3 reps)

| region px | median ms | p90 | raw |
|---|---|---|---|
| 484 | 21 | 24.8 | 21, 24.8, 20.6 (first-run JIT warmup visible) |
| 2 025 | 7.4 | 7.7 | 7.7, 7, 7.4 |
| 7 921 | 9.1 | 19 | 19, 9.1, 8.1 |
| 29 929 | 28.6 | 29.1 | 29.1, 28.6, 28.5 |

Near-linear in filled pixels and comfortably interactive at every size the
local-tier caps allow (≤60 000 px).

### 3D LUT apply, 1 MP, 5 reps

applyLUT3D (17³ trilinear): median 54.6 ms, p90 60.7 (raw 60.7, 55.3, 54.4,
54.6, 54).

### Composer frame composition, 720×1280 story (2 segments, look + Ken Burns, crossfade)

| frame | median ms | ≈fps | raw |
|---|---|---|---|
| plain | 103 | 9.7 | 113.6, 103, 101.5, 103, 99.6 |
| transition | 147.5 | 6.8 | 147.5, 168.2, 145.4, 151, 140.4 |

Composition only. A 10 s/30 fps story is ~300 frames ⇒ ≈35 s of CPU
composition on this container before encoding — fine for an export with a
progress bar; the WebCodecs driver overlaps encode with composition, and the
per-segment still is a candidate for caching across frames (Ken Burns changes
the viewport, not the graded still) if hardware numbers demand it.

### Mask serialization sanity

RLE for a 500×400 brush region on a 12 MP frame: 6 040 chars of JSON — drafts
stay KB-sized as designed.

---

Append new entries below with date + commit + environment; never overwrite a
recorded run.
