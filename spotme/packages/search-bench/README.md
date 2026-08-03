# @spotme/search-bench

Benchmark harness comparing **Meilisearch** and **Typesense** on a synthetic
Spot Me corpus (usernames, places, Exchange-style listings). It **reports
numbers only** — it wires nothing into the app and expresses no preference. The
owner picks the engine from the table; only then is one wired in.

## Run

Bring up the engines (the dev compose stack's opt-in profile), then the harness:

```bash
docker compose -f spotme/docker-compose.dev.yml --profile search-benchmark up -d

cd spotme/packages/search-bench
npm install
MEILI_URL=http://127.0.0.1:7700 MEILI_KEY=<dev key> \
TS_HOST=127.0.0.1 TS_PORT=8108 TS_KEY=<dev key> \
CORPUS_SIZE=20000 RUNS=3 WARMUP_PASSES=2 WARM_PASSES=10 node bench.mjs
```

Optional: `MEILI_PID`/`TS_PID` (RSS via `/proc/<pid>/status`) and
`MEILI_DATA_DIR`/`TS_DATA_DIR` (index size via `du -sb`).

## Methodology — printed as a manifest with every run

- **Deterministic corpus** (seed committed, `corpus.mjs`): identical for both
  engines and across runs. Query set committed verbatim (6 exact, 5 partial,
  6 typo).
- **Per run:** drop index → re-index (timed) → **1 COLD pass** (timed — the
  first queries the fresh index serves) → **2 warm-up passes** (unmeasured) →
  **10 WARM passes** (timed).
- **Aggregation:** cold latencies pooled across runs; warm pooled across runs;
  index time = median of runs (per-run times printed too).
- **Latency** = end-to-end client round-trip (`performance.now()` around each
  HTTP call from Node) — what an application experiences.
- **Memory** = `VmRSS` from `/proc/<pid>/status` after the final run; engine
  self-reports captured alongside. **Index size** = engine-reported
  (Meili `/stats`) + `du -sb` of the data dir.
- Nothing generated (indexes, data dirs, result files) is committed.

## Recorded run — 2026-08-03 (manifest below)

| Engine | Docs | Index med (docs/s) | Cold p50/p95 | Warm p50/p95 | Typo | RSS | Index disk |
|---|---|---|---|---|---|---|---|
| Meilisearch 1.10.3 | 20,000 | 782.9 ms (**25,547/s**) | 44.08 / 48.18 ms | **44.02 / 44.59 ms** | 100% | **66 MB** | **7.0 MB** (self-report 6.9) |
| Typesense 27.1 | 20,000 | 595.2 ms (**33,603/s**) | 3.95 / 9.36 ms | **3.60 / 5.05 ms** | 100% | 223 MB (self-report 73 active) | 17.3 MB |

Per-run index times (ms): Meilisearch `[783, 752, 811]` · Typesense `[709, 595, 532]`.
Samples: 33 cold + 330 warm per engine.

**Manifest of the recorded run:**

```json
{
  "recordedAt": "2026-08-03T18:17:24.636Z",
  "methodology": {
    "runs": 3,
    "perRun": "drop index → re-index (timed) → 1 COLD pass (timed) → 2 warm-up passes (unmeasured) → 10 WARM passes (timed)",
    "latency": "end-to-end client round-trip, performance.now() around each HTTP call from Node",
    "percentiles": "cold pooled across runs; warm pooled across runs; index time = median of runs",
    "memory": "VmRSS from /proc/<pid>/status after the final run (MB); engine self-reports alongside",
    "indexSize": "engine-reported where available + du -sb of the data dir when *_DATA_DIR set"
  },
  "corpus": { "seed": 1234, "size": 20000,
    "composition": "~34% usernames, ~33% places, ~33% Exchange need/offer listings (deterministic, corpus.mjs)" },
  "querySet": { "exact": 6, "partial": 5, "typo": 6, "note": "committed verbatim in corpus.mjs" },
  "environment": { "node": "v22.22.2", "cpus": 4,
    "cpuModel": "Intel(R) Xeon(R) Processor @ 2.80GHz", "totalMemGB": 15.7, "platform": "linux 6.18.5" },
  "engineConfig": {
    "meilisearch": "defaults + searchableAttributes [title,text,category,tags]; batch 5000; dev master key",
    "typesense": "defaults; schema title/text/category(facet)/tags[]/kind(facet)/geoCell; query_by title,text,category,tags; batch 5000"
  }
}
```

**Reading (no recommendation):** Typesense answered warm queries ~12× faster
(3.6 ms vs 44 ms p50) and, over 3 runs, also indexed ~1.3× faster; Meilisearch
used ~⅓ the resident memory (66 vs 223 MB RSS) and ~40% of the disk. Both
resolved every typo query. The tradeoff — query latency vs memory/disk
footprint — is the owner's call, re-run on target hardware with a
production-scale corpus first.

**Correction over the earlier single-run note (PR #71 era):** a single
un-warmed run had shown Typesense indexing ~2.4× *slower* — that was its
first-ever import (raft initialization) being measured as if steady-state.
The multi-run methodology exists precisely to kill that class of error; with
3 runs Typesense indexes faster, not slower. Single-run numbers should not be
trusted for the engine decision.
