# 15 — Performance & Capacity (Measured)

> **Every number below was measured; nothing is extrapolated.** The largest
> dataset actually reached was **1,000,000 synthetic profiles** — on both the
> PostGIS and the Typesense legs — so no "reason stopped short" entry is
> needed (mission rule A5). These are DEV-CONTAINER numbers: they establish
> relative behaviour and scaling shape, and they do NOT replace the mandatory
> production-hardware re-benchmark before any search/discovery surface is
> wired live (rule A4; tech-stack §14).

## 15.1 How to reproduce

Benchmark harnesses (committed, loud-skip by default so CI never runs them):

- Backend: `spotme/backend/test/discovery-benchmark.e2e-spec.ts` — the file
  header documents the exact provisioning commands (`spotme_bench` database,
  PostGIS extension, `prisma db push`) and env (`RUN_DISCOVERY_BENCH=1`,
  `BENCH_DATABASE_URL`, `TEST_TYPESENSE_URL`/`TEST_TYPESENSE_API_KEY`).
- web-next: `spotme/web-next/test/discovery-perf.test.ts` with
  `RUN_DISCOVERY_BENCH=1`.

The dataset is **deterministic**: positions derive from an integer-hash
formula (recorded in the spec and in the emitted report), pseudo-uniform over
a ~50 km × 50 km box centred on a public landmark. No `random()`, no
time-derived seeds — a re-run reproduces the data byte-for-byte.

**Run recorded here (2026-08-03):**

| Parameter | Value |
|---|---|
| Hardware | 4 vCPU (Intel Xeon @ 2.10 GHz), 16.8 GB RAM, shared cloud container |
| PostgreSQL | 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1) |
| PostGIS | 3.4 (GEOS, PROJ, STATS) |
| Typesense | 27.1 (single local node) |
| Node | v22.22.2 |
| Scales seeded | 1k / 10k / 100k / 1M visible, discoverable profiles (largest achieved: **1M**) |
| Block rows | ~0.1% of scale + 50 involving the querying principal (the anti-join is never vacuous) |
| Query set | 5 fixed origins × radii {2, 5, 25} km, page size 30 |
| Warm method | 3 warm-ups, then 30 measured runs round-robin over origins (10 runs for 25 km at ≥100k) |
| Cold method | first post-`ANALYZE` execution — an approximation, NOT a cold-buffer restart |

## 15.2 PostGIS people query (production SQL via `PrismaDiscoveryPeopleRepository`)

Warm latency, ms (single connection, sequential):

| Scale | 2 km p50 / p95 | 5 km p50 / p95 | 25 km p50 / p95 |
|---|---|---|---|
| 1k | 3.4 / 4.2 | 4.9 / 6.3 | 35.1 / 42.5 |
| 10k | 36.7 / 45.3 | 144.9 / 187.6 | 2543 / 3153 |
| 100k | 134.7 / 160.3 | 184.0 / 241.1 | 682 / 791 |
| 1M | 948 / 1024 | 1026 / 1115 | 2756 / 3192 |

Seeding: 1M rows (users + projections + visibility + GIST maintenance) in
~46 s via batched `generate_series` inserts.

**Measured findings (not projections):**

1. **Latency scales with the candidate set inside the radius, not with page
   size.** The query computes `ST_Distance` for every in-radius candidate and
   sorts before `LIMIT 30`. `ST_DWithin` + GIST prunes by area, but a 2 km
   query over 1M uniformly-spread profiles still owns a ~5k-candidate set and
   costs ~950 ms p50 on this container.
2. **Wide radius is the bottleneck at every scale ≥10k.** 25 km covers ~78%
   of the seeded box, so the "spatial" query degenerates toward a full-table
   distance sort (measured p50 2.5–2.8 s at 10k and 1M).
3. **Plan instability between scales:** 25 km at 10k measured *slower* (p50
   2543 ms) than at 100k (p50 682 ms) — the planner picked different plans as
   statistics changed. Operationally this means `ANALYZE` freshness is
   load-bearing (runbook §16.2) and activation-time `EXPLAIN` capture is
   mandatory.
4. **Keyset pagination is stable at 1M:** 10 pages walked, 300 rows, zero
   duplicates, strict (distance, userId) order held; per-page latency stayed
   flat (0.89–1.24 s — each page re-runs the radius scan; no growth with page
   depth, which is the property keyset buys).

**Scaling triggers (act when measured, in this order):**

| Trigger (production numbers) | Change |
|---|---|
| p95 > ~250 ms at the default radius | Rewrite ordering to KNN `ORDER BY geog <-> origin` (index-ordered nearest-first) with an `ST_DWithin` recheck, so `LIMIT 30` stops the scan instead of sorting the whole candidate set |
| KNN insufficient (dense metros) | Pre-filter on `coarseCell` (already stored per ADR-018) before geography math; cells are the natural shard/partition key |
| Wide-radius product pressure | Keep the policy cap at 25 km but serve wide radii from a coarser aggregate, never the row-level scan |
| Single-node write ceiling | Partition `DiscoveryVisibility` by cell region; presence is ephemeral and per-region by nature |

## 15.3 Ranking, serialization, memory (in-process)

| Operation | p50 | p95 |
|---|---|---|
| `orderPeople` over 5,000 candidates | 5.2 ms | 9.3 ms |
| `explainPerson` × 30 (full page of breakdowns) | 0.05 ms | 0.09 ms |
| `rankCandidates` × 30 (closed-registry engine) | 0.14 ms | 0.20 ms |
| `JSON.stringify` of a full 30-result page | 0.03 ms | 0.05 ms |

Ranking and serialization are **negligible** next to the SQL — optimization
effort belongs in §15.2, nowhere else. Process memory after the full
workload: 1,012 MB RSS / 714 MB heap — an upper bound that includes the jest
harness and the benchmark's own buffers, not a NestJS service measurement.

## 15.4 Typesense (live local 27.1, adapter code path)

Search latency through `TypesenseSearchAdapter.search()` (timeout wrapper,
allow-list projection, exact-handle pin included), ms:

| Scale | exact handle p50 / p95 | prefix p50 / p95 | typo p50 / p95 | display name p50 / p95 |
|---|---|---|---|---|
| 1k | 9.7 / 22.0 | 6.8 / 11.6 | 6.3 / 10.5 | 7.1 / 10.8 |
| 10k | 6.3 / 10.9 | 6.4 / 9.9 | 5.8 / 9.8 | 5.9 / 10.1 |
| 100k | 14.9 / 30.4 | 11.1 / 14.8 | 10.2 / 13.8 | 10.6 / 14.4 |
| 1M | 43.8 / 62.4 | 37.8 / 45.0 | 38.0 / 43.9 | 41.1 / 46.5 |

Bulk import: 900k docs in ~22 s (JSONL import; the app path itself indexes
per-document through the adapter's allow-list).

**Findings:** sub-linear growth — 1000× the corpus cost ~6× the latency; all
query classes stayed under the adapter's 2 s timeout by >30× at 1M; every
query returned `ok` (breaker never opened). Search is NOT the discovery
platform's bottleneck at these scales; the PostGIS radius scan is.

## 15.5 web-next (jsdom under vitest — JS work only, no layout/paint)

| Measurement | p50 | p95 |
|---|---|---|
| Controller full search cycle (fixture API), 200 runs | 0.02 ms | 0.07 ms |
| State fan-out: 1,000 updates × 50 subscribers | 2.07 ms total | — |
| `ResultList` mount with a full 30-result page, 50 mounts | 6.9 ms | 14.4 ms |
| `StateBanner` mount across 4 transient states, 50 runs | 1.3 ms | 7.3 ms |

jsdom numbers exclude real browser layout/paint and are honest upper bounds
on JS work only. The state machine adds no measurable overhead; list
virtualization (fixed 132 px rows, ~6-row viewport) keeps the 30-result
mount under a frame budget even in jsdom.

## 15.6 Measured limits — the honest summary

- **Largest dataset achieved: 1,000,000 profiles** (both legs). Nothing
  beyond 1M is claimed.
- On dev hardware the current SQL is comfortable to ~10k in-radius
  candidates and visibly past its budget at metro-density 1M — **the KNN
  rewrite is expected activation-prerequisite work**, tracked as the first
  scaling trigger, not a rework of the architecture (ports and SQL isolate
  it to one method).
- Typesense at 1M is far inside budget on a single local node.
- Client-side cost is noise at page scale.
- All numbers here are single-connection sequential latencies on a shared
  4-vCPU container. Concurrency behaviour, connection-pool sizing, and
  production-hardware numbers are explicitly NOT claimed and belong to the
  pre-activation re-benchmark (A4).
