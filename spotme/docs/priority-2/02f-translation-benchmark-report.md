# 02f — Translation Platform: benchmark report

**Companion to** ADR-010b. Roadmap V2 §8 requires environment, raw results,
median AND tail. These isolate the platform's **LOCAL orchestration cost** from
external provider latency: every provider is a **deterministic fake that resolves
immediately**, so the numbers are purely the cost of choosing and orchestrating —
the overhead the live path pays ON TOP of whatever vendor leg it drives. The
vendor legs are measured separately (the engine documents service p90 3.8 s,
`?op=read` p50 3.2 s / p90 6.6 s, detect 259–271 ms).

**Environment:** Node v22.22.2, Intel Xeon @ 2.10 GHz ×4, 16.9 GB, in-process.
Reproduce:
`node web/test/bench/translation-routing.bench.mjs` and
`node web/test/bench/translation-pipeline.bench.mjs`.

---

## 1. Routing (50 000 iters after 5 000 warmup) — `translation-routing.bench.mjs`

| path | p50 | p90 | p95 | p99 | mean |
|---|---|---|---|---|---|
| `route()` over the full 11-provider registry | 7.29 µs | 12.64 µs | 14.72 µs | 40.21 µs | 9.05 µs |
| `score()` a single provider | 0.52 µs | 0.88 µs | 0.99 µs | 2.35 µs | 0.74 µs |
| `route()` with breakers + quality store (enabled shape) | 7.60 µs | 14.05 µs | 16.63 µs | 31.89 µs | 9.73 µs |

## 2. Pipeline paths (20–50 k iters after warmup) — `translation-pipeline.bench.mjs`

| path | p50 | p90 | p95 | p99 | mean |
|---|---|---|---|---|---|
| cache lookup (hit) | 0.24 µs | 0.37 µs | 0.56 µs | 1.86 µs | 0.37 µs |
| context construction (6-turn window → fingerprint) | 11.24 µs | 15.87 µs | 18.68 µs | 34.05 µs | 12.84 µs |
| confidence aggregation (`resolve` → agree) | 1.01 µs | 1.91 µs | 2.18 µs | 4.37 µs | 1.45 µs |
| pipeline: single provider (route+execute+metrics) | 2.87 µs | 5.76 µs | 6.68 µs | 16.78 µs | 4.26 µs |
| pipeline: fallback path (primary fails → backup) | 3.73 µs | 7.02 µs | 8.40 µs | 16.56 µs | 5.05 µs |
| pipeline: cross-provider path (verify → agree) | 5.76 µs | 9.26 µs | 11.34 µs | 26.19 µs | 7.08 µs |
| pipeline: adjudication path (disagree → judge) | 11.01 µs | 16.13 µs | 18.75 µs | 37.67 µs | 13.08 µs |

## 3. Reading

- **Every local path is a few microseconds**, sub-40 µs at p99. The most
  expensive local operations are context construction (a `JSON.stringify` for the
  cache fingerprint, ~11 µs p50) and the adjudication orchestration (~11 µs p50) —
  both still ~1/10⁵ of a single cloud vendor leg.
- **A cache hit (~0.24 µs) removes an entire vendor leg** (hundreds of ms to
  seconds). The cache is the single largest wall-clock lever the platform adds.
- **Cross-verify and adjudication add negligible LOCAL cost** — the real cost of
  those paths is the EXTRA vendor calls they make, which is exactly why they are
  gated and cost-governed (see 02d), not why they are slow to orchestrate.
- The cost of choosing is negligible beside what it routes between; latency is
  won by routing to the faster/cheaper vendor and by caching, not by shaving the
  orchestrator.

## 4. Caveats

These are in-process Node numbers with fake vendors. A serverless cold start and
the real vendor legs dominate any end-to-end measurement and **must be measured
separately on the deploy target** before the platform is enabled. The benches
exist to prove the orchestration overhead is not itself a latency source — they
do not model vendor latency, by design.
