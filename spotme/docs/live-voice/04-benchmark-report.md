# Live Voice Translation — benchmark report (local orchestration)

Per roadmap §8: environment, raw numbers, median AND tail. This report
covers the platform's OWN cost — everything measured runs on deterministic
fakes, so provider latency is exactly zero and the numbers isolate the glue
the design's §4 budget must carry ON TOP of the vendor legs. Reproduce with
`node test/bench/live-voice.bench.mjs`.

## 1. Environment

- Node v22.22.2, 4× Intel Xeon @ 2.10 GHz, 15.7 GiB RAM (CI-class Linux
  container, 2026-08-02)
- Providers: deterministic stubs resolved on microtasks; manual clock for
  the budget arithmetic (wall-clock measures only the local machinery)

## 2. Results (µs; nearest-rank percentiles)

| Benchmark | n | min | p50 | p90 | p95 | p99 | max | mean |
|---|---|---|---|---|---|---|---|---|
| Session setup (1:1: adapters + ladder + aggregator + machine) | 2000 | 4.98 | 10.43 | 16.73 | 22.12 | 80.84 | 2650.84 | 19.62 |
| Fan-out matrix (16 participants, 5 languages) | 20000 | 1.44 | 2.49 | 6.94 | 8.79 | 26.70 | 7677.41 | 4.57 |
| Full utterance, 1:1 (shared STT→MT→TTS→playback, frames + budget) | 500 | 32.20 | 47.52 | 101.59 | 141.57 | 465.91 | 3115.75 | 75.58 |
| Full utterance, 3-party (2 translated legs, shared STT) | 500 | 51.64 | 79.28 | 141.46 | 172.35 | 365.52 | 4630.41 | 113.19 |
| VAD: 500 frames = 10 s of 20 ms audio | 200 | 13.34 | 30.60 | 71.55 | 118.12 | 1815.15 | 2984.51 | 64.26 |
| Jitter buffer: 500 push+drain cycles = 10 s of chunks | 200 | 67.12 | 96.77 | 206.22 | 291.78 | 513.69 | 638.91 | 119.84 |
| Metrics + ladder: 100 utterance folds | 2000 | 6.16 | 7.36 | 13.99 | 27.45 | 40.70 | 439.24 | 10.19 |

Max outliers are first-iteration JIT/GC effects (p99 is the honest tail).

## 3. Interpretation against the < 2.5 s budget

- The platform machinery costs **~50–170 µs per utterance** (p50–p95,
  1:1 and 3-party) — under **0.007 %** of the 2 500 ms budget. The budget
  is spent where §4 says it is: providers + network.
- Per-frame costs amortise to ~0.06 µs/frame (VAD) and ~0.2 µs/chunk
  (jitter incl. schedule arithmetic) — irrelevant at 50 frames/s.
- 3-party overhead over 1:1 is ~32 µs p50 for a second full leg — fan-out
  legs are effectively free locally; the real fan-out cost is provider
  spend (§14), which `planCall()` exposes for capping.

## 4. Resource estimates per active translated stream (engineering estimates)

- **CPU:** local machinery <0.1 % of one core (measured above). Browser
  Opus encode + WebAudio taps dominate at low single-digit %; unmeasured
  here (needs a device matrix).
- **RAM:** bounded by construction — metrics rings ≤ 256 samples × ~8
  series, replay ring ≤ 64 caption + 64 audio frames of ONE utterance,
  MT decision log ≤ 32; order tens of KB per session plus transient audio
  chunks in flight (mp3 base64, ~8 KB/chunk × jitter depth).
- **Bandwidth (per direction, estimates to validate live):** uplink ~24–32
  kbit/s Opus (VAD-gated); downlink translated mp3_44100_64 = 64 kbit/s
  while speech plays; captions negligible.

## 5. What is NOT measured here (cred-gated / deferred)

The §4 critical-path terms — STT stabilisation, TTS first-audio, network
legs — require live credentials and shaped networks. The suite's
cred-gated smoke (`ELEVENLABS_API_KEY` + `LIVE_VOICE_LIVE_TESTS=1`) proves
the wire; the full provider benchmark matrix is governed by
`docs/adr/03-live-voice-benchmark-plan.md` and is the go/no-go evidence the
production checklist requires before any cohort enablement. The budget
split honoured by the code today: local < 1 ms, leaving the entire 2.5 s
(target < 1 s in production per §4) for capture+providers+network+jitter.
