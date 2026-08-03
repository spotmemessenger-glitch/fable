# @spotme/search-bench

Benchmark harness comparing **Meilisearch** and **Typesense** on a synthetic
Spot Me corpus (usernames, places, Exchange-style listings). It **reports
numbers only** — it wires nothing into the app and expresses no preference. The
owner picks the engine from the table; only then is one wired in.

## Run

Bring up the engines (dev compose stack), then run the harness:

```bash
docker compose -f spotme/docker-compose.dev.yml up -d meilisearch typesense

cd spotme/packages/search-bench
npm install
MEILI_URL=http://127.0.0.1:7700 MEILI_KEY=<dev key> \
TS_HOST=127.0.0.1 TS_PORT=8108 TS_KEY=<dev key> \
CORPUS_SIZE=20000 node bench.mjs
```

Optionally pass `MEILI_PID`/`TS_PID` to read process RSS from `/proc`; otherwise
the harness falls back to each engine's self-reported memory figure.

Measures, on an identical seeded corpus for both engines:

- **index time** (and derived docs/s)
- **query latency** p50 / p95 across exact + partial queries (`QUERY_REPS` each)
- **typo-tolerance hit rate** — misspelled queries whose correct term is in the corpus
- **memory** — process RSS (or engine-reported)

## Recorded run — 2026-08-03 (migration container, single run)

Engines run from their official binaries (Meilisearch v1.10, Typesense 27.1),
20,000 docs, 30 reps/query. **Single representative run** — for a production
decision, re-run on target hardware with a production-scale corpus.

| Engine | Docs | Index (docs/s) | Query p50 | Query p95 | Typo hit rate | Mem RSS |
|---|---|---|---|---|---|---|
| Meilisearch | 20,000 | 28,283 | 44.06 ms | 48.07 ms | 100% | 58 MB |
| Typesense | 20,000 | 11,626 | 4.62 ms | 8.51 ms | 100% | 167 MB |

**Reading (no recommendation):** Meilisearch indexed ~2.4× faster and used ~⅓
the resident memory (disk-based LMDB; much of the index is page cache, not RSS);
Typesense answered queries ~10× faster (fully in-memory). Both resolved every
typo query. The tradeoff — query latency vs. memory footprint and index speed —
is the owner's call, against real target hardware and corpus.
