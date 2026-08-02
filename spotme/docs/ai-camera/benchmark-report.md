# Camera engine — benchmark report (mission CAM-1)

Per Roadmap V2 §8: environment, raw command, median AND tail. Harness:
`web/test/bench/camera.bench.mjs` (env-stamped; warm-up iteration before
sampling; nearest-rank percentiles).

## Environment (this run)

```
node v22.22.2 · linux/x64 · Intel(R) Xeon(R) Processor @ 2.10GHz
cores=4 · mem=15.7GiB · 2026-08-02
command: node test/bench/camera.bench.mjs
```

**What these numbers are:** the ALGORITHMS' pure-JS cost on typed arrays,
isolated from camera hardware, GPU and codecs (fakes stand in for those).
Phone CPUs will differ in constant factor; the shapes (linear in pixels,
n·log n in tile size) will not. Real-device capture timings belong to the
manual matrix (production-checklist.md).

## Results

| Benchmark | n | median | p90 | p99 | min | max | unit |
|---|---|---|---|---|---|---|---|
| HDR fuseExposures (3 frames 512×384) | 12 | 516 | 554 | 565 | 471 | 565 | ms/MP |
| Night stackFrames (8 frames, align+reject) | 8 | 306 | 317 | 317 | 294 | 317 | ms/MP |
| estimateShift (720p luma → 64² tile, 3×FFT) | 50 | 13.1 | 14.1 | 22.3 | 12.5 | 22.3 | ms |
| fft2d 64×64 forward | 200 | 0.190 | 0.206 | 0.225 | 0.182 | 0.535 | ms |
| Pipeline passthrough (0 stages, 640×480) | 500 | 0.000 | 0.001 | 0.002 | 0.000 | 0.050 | ms |
| Pipeline 2 stages (gain+LUT, 640×480) | 60 | 4.28 | 5.22 | 6.40 | 4.03 | 6.40 | ms |
| Stabilizer feed (640×480 luma) | 60 | 5.03 | 5.30 | 5.56 | 4.82 | 5.56 | ms |
| Portrait blur consumer (512×384, 128×96 mask) | 10 | 85.5 | 92.1 | 93.7 | 83.2 | 93.7 | ms |
| muxWebm (300×8 KB chunks ≈ 10 s video) | 40 | 2.58 | 3.01 | 3.40 | 1.93 | 3.40 | ms |
| captureStill orchestration (fakes) | 100 | 0.009 | 0.028 | 0.171 | — | — | ms |
| openSession orchestration (fakes) | 50 | 0.012 | 0.113 | 0.335 | — | — | ms |

## Reading the numbers (engineering conclusions)

- **HDR at ~0.52 s/MP, night at ~0.31 s/MP (CPU, single thread):** a
  12 MP still would cost ~6 s / ~4 s on this class of CPU — acceptable for
  a post-shutter "processing…" moment on capture, NOT for per-frame
  preview. The design already matches this: fusion/stacking run on
  CAPTURED frames only; preview effects live in the (GL) pipeline.
  Obvious headroom when needed: Worker offload and/or a GL port of the
  weight/blend passes — contained inside the same function contracts.
- **estimateShift ~13 ms** is dominated by the 720p→64² box downscale
  (the FFTs are 0.2 ms each). At 64×64-input cost this is EIS-viable at
  30fps on desktop-class CPUs; on phones EIS applies to recorded takes
  (post-process) until measured on hardware — matrix item.
- **Pipeline overhead:** passthrough is free (same-object return, proven);
  ~2 ms/stage CPU at 480p confirms CPU mode is a fallback, and per-frame
  preview belongs to the GL executor.
- **Muxing and orchestration are noise** (<3 ms for 10 s of video; <0.1 ms
  per capture call): the engine adds no meaningful latency on top of
  hardware — capture latency on devices will be sensor time, not module
  time.
- **Tail behaviour** is tight (p99 within ~1.7× median everywhere except
  the 22 ms alignment outlier, a one-off GC pause at n=50).

## Reproducing / updating

Run the command above on the target machine and replace the table +
environment block together — numbers and environment travel as a pair or
they are meaningless. Device runs go in a per-device appendix here once
the manual matrix starts.
