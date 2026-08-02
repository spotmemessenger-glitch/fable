# Benchmark note — Push Notification Platform foundation (Priority 2, PR A)

Measured, not asserted (crypto-guide discipline). This covers the pure,
server-side hot paths that are runnable now without Postgres or a network; the
DB and on-device numbers are CI-/P10-gated and mapped below to the design's
B1–B9 plan (`01-push-notifications.md` §14).

## Environment

- Node **v22.22.2**, single thread, compiled `dist/` output.
- 500,000 ops per case, 10,000-op warm-up, `process.hrtime.bigint()` timing.
- Machine: the CI/dev container for this branch (relative figures matter more
  than absolute; re-measure on target hardware before any GA claim).

## Results (pure paths, this branch)

| Path | µs/op | ops/sec | Notes |
|---|---|---|---|
| `router.route` (event → full routing) | ~1.5 | ~660k | catalog + dedupe/collapse keys + opaque id + text |
| `router.deriveWireCollapseId` (SHA-256) | ~1.0 | ~1.0M | opaque collapse id; not a key, one-way hash |
| `envelope.build` (content-less) | ~1.5 | ~650k | the shipped wire payload builder |
| `preference.evaluate` (DND, tz-aware) | ~2.1 | ~480k | **after** formatter cache (see finding) |
| `backoff.nextBackoffMs` | ~0.28 | ~3.6M | exponential + full jitter |
| `sealRichPayload` (GATED) | ~157 | ~6.4k | X25519 keygen+ECDH+HKDF+AES-256-GCM |
| `unsealRichPayload` (GATED) | ~73 | ~13.7k | device side; ECDH+HKDF+AES-GCM open |

**Full-jitter distribution** (attempt=4, 32 s ceiling, 100k draws, eight 4 s
buckets): ~12.2k–12.7k per bucket — uniform, confirming no synchronised retry
stampede (design B5).

## Finding: cache the timezone formatter

The tz-correct DND evaluation first measured **~62 µs/op** — dominated by
constructing an `Intl.DateTimeFormat` on every call. Caching one formatter per
IANA zone (`dnd-window.ts`) cut it to **~2.1 µs/op (~30×)** with identical
correctness (the preference matrix + midnight-crossing + invalid-tz tests still
pass). At ~480k evals/sec per replica this is comfortably off the enqueue
critical path (one eval per notification).

## Interpretation vs the design targets

- **B1 (enqueue overhead < 1 ms p95):** the enqueue-side compute is
  route + evaluate + build ≈ **~5 µs** total before the single indexed upsert —
  three orders of magnitude under the 1 ms budget. The DB upsert latency itself
  is the real B1 figure and is CI-gated (needs Postgres).
- **B5 (retry storm safety):** the jitter spread above is the evidence — bounded,
  uniform, per-replica independent.
- **Server crypto cost (B9, seal side):** the content-less floor performs no
  per-message encryption (SHA-256 collapse id ~1 µs). The GATED encrypted seal
  measures **~157 µs/op (~6.4k seals/sec/replica)**, dominated by the fresh
  ephemeral X25519 keygen + ECDH per message (the price of per-message forward
  secrecy). Unseal (device side) is ~73 µs. At ~6.4k/sec/replica this comfortably
  covers a notification workload and, being gated, adds ZERO cost to the shipped
  floor. Measured on the same host with 50k-op runs against `dist/`. When the
  §12 review authorises activation, a per-batch ephemeral-key reuse (one ECDH per
  multicast batch rather than per token) is the obvious optimisation, deferred.

## CI-gated (need a real Postgres) — not run here

- **B2 fan-out throughput**, **B3 fan-out latency**, **B4 coalescing
  effectiveness**, **B6 batch efficiency**, **B7 claim-scan cost at 10⁵/10⁶
  rows** — all exercise the `FOR UPDATE SKIP LOCKED` claim, coalescing, and the
  `@@index([status, nextAttemptAt])` hot path. The queries and indexes are in
  place (`outbox.service.ts`, the additive migration); the integration harness
  runs against a provisioned Postgres in CI. No `DATABASE_URL` is available in
  this environment, so these are recorded as pending, not run.

## P10-gated (need the mobile app / device)

- **B8 device wake / battery** and **B9 device decrypt latency** need an
  on-device Android build (and iOS at P10) plus the native messaging service /
  NSE — out of scope for this server-side foundation.

## Reproduce

Build (`npm run build`) then run the micro-benchmark against `dist/` — it
imports `router`, `envelope`, `preference-evaluator`, and `backoff` and prints
the table above. (The script lived in the session scratchpad; it depends only on
the compiled module, no DB.)
