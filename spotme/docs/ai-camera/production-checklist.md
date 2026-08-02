# Camera engine — production checklist

Two halves, honestly separated: what CI PROVES on every run, and what only
hardware can prove (the manual device matrix). A feature flag does not
flip until both halves are green for that feature.

## CI-proven (green as of 2026-08-02, run on every `npm test`)

- [x] 59 suites green including all 37 pre-existing (untouched-green), exit 0
- [x] 11 camera suites, 202 assertions (203 with the post-build bundle
      check), deterministic (seeded fixtures,
      fake hardware, manual clocks — zero timing sleeps, zero network)
- [x] `npx eslint .` clean
- [x] `npm run build` green; post-build fence: dist/ contains NO camera
      identifiers (byte-identical app while dark)
- [x] Fence: no outside import, no view mention, all flags false, inert
      factory vs throwing fakes, zero egress/persistence/crypto call
      shapes, zero new deps, <500 lines/file, every module test-imported
- [x] Algorithm golden vectors (FFT analytic, alignment sign convention +
      noise corridor, Mertens behaviour, √N stacking, motion rejection,
      EIS smoothing ≥3×, EBML structure round-trip)
- [x] Bench recorded with environment (benchmark-report.md)

## What CI CANNOT prove — the manual device matrix

No camera, GPU, codec or permission prompt exists in CI; the fakes model
API shape, not physics. Before each flag flip, fill the row on real
hardware. Template (append filled rows below it, dated, per device):

| Check | Android mid (e.g. Pixel/Samsung) | Android high (multi-cam) | iPhone Safari/WebView | Desktop Chrome | Notes |
|---|---|---|---|---|---|
| Permission prompt → open → preview < 2 s warm | ☐ | ☐ | ☐ | ☐ | `frames.firstFrame` metric |
| Release ⇒ OS camera indicator OFF every exit path | ☐ | ☐ | ☐ | ☐ | threat T2 |
| Front/back switch (warm vs cold strategy reported truthfully) | ☐ | ☐ | n/a labels | ☐ | |
| Torch actually lights / honestly refused | ☐ | ☐ | ☐ expect refuse | ☐ expect refuse | |
| Zoom range matches device UI | ☐ | ☐ | ☐ expect refuse | ☐ | |
| EV/ISO/exposureTime take visible effect | ☐ | ☐ | ☐ expect refuse | ☐ likely refuse | |
| takePhoto still at SENSOR res (bigger than stream) | ☐ | ☐ | n/a (canvas-draw labeled) | ☐ | |
| HDR bracket: 3 exposures visibly differ, fusion recovers shadows+highlights, halo check | ☐ | ☐ | n/a (refused) | n/a | 2.7 gate |
| Night: 8-frame handheld stack visibly denoises, moving subject unghosted | ☐ | ☐ | ☐ | ☐ | 2.4 gate |
| Recording: webm/mp4 per platform PLAYS BACK (incl. our muxed WebCodecs output in VLC+Chrome+device player) | ☐ | ☐ | ☐ | ☐ | 2.1 gate; muxer field validation |
| Segmented recording + caps stop correctly | ☐ | ☐ | ☐ | ☐ | |
| Timelapse overnight-class run within budgets, battery note | ☐ | ☐ | ☐ | ☐ | 2.3 gate |
| Slow-mo: high-fps mode really granted (count strobe/fan blades), output genuinely slow | ☐ | ☐ | n/a (refused) | n/a | 2.8 gate |
| Burst pace + memory bound on a low-RAM device | ☐ | ☐ | ☐ | ☐ | 2.2 gate |
| EIS on device: walking-video A/B visibly steadier, fps cost measured | ☐ | ☐ | ☐ | ☐ | 2.5 gate |
| GL pipeline: gain/LUT stages match CPU reference by eye + probe pixels; context-loss recovery | ☐ | ☐ | ☐ | ☐ | GL cannot run in CI at all |
| Backgrounding/lock mid-session releases cleanly | ☐ | ☐ | ☐ | ☐ | |
| iOS quirks: playsinline preview, autoplay refusal path, mp4-only recording | n/a | n/a | ☐ | n/a | |
| Thermal: 10-min preview+pipeline session, device temperature + fps sag noted | ☐ | ☐ | ☐ | ☐ | |

Known-in-advance expected refusals (verify the REASON matches, not just
the absence): iOS HDR = NO_EXPOSURE_CONTROL, iOS slow-mo =
NO_HIGH_FPS_MODE (60fps named), RAW = DEFERRED_NATIVE everywhere,
portrait = NO_SEGMENTER_REGISTERED until the owner decision.

## Release gate (any wiring PR)

1. CI half green (automatic).
2. Matrix rows for the feature being lit, on ≥1 Android + ≥1 iOS device,
   dated and initialled.
3. Security-review wiring checklist items answered in the PR.
4. Rollback line identified (which flag reverts this PR).
