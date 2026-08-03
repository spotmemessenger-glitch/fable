# 12 — Scalability & Performance

> Reconstruction pending A5 ratification. Budgets `[PROPOSED]`.

## 12.1 Load shape

Exchange load is **local and bursty**: reads (search, browse, match lists)
dominate; writes (post, accept, message) are lower volume but latency-sensitive.
Density is geographic — hotspots are cities/events. Design for read-heavy,
geo-partitioned access.

## 12.2 Targets `[PROPOSED]`

| Path | Target |
|---|---|
| Search → first results | p95 < 800 ms (warm providers) |
| Match recompute after post | first proposals < 3 s |
| Map/list interaction | 60 FPS on supported devices `[REUSE]` |
| Notification fan-out | seconds, via durable outbox |

## 12.3 Techniques

- **Geo-partitioned queries** over discretized cells (§09) — no full scans; the
  adaptive radius bounds the candidate set (10→…→100 km, min-result stop)
  `[REUSE]`.
- **Caching:** hot cell/category candidate sets cached with short TTLs; respect
  privacy (no exact location cached; cache only where policy permits — scope
  §2.1).
- **Async matching:** matching runs off the write path via workers; results
  stream over WebSocket; the write returns immediately.
- **Backpressure & load shedding** on the realtime gateway; bounded queues;
  reconnect-storm protection (`MIGRATED_BUILD_MEMORY` §2.4) `[REUSE]`.
- **Expiry/purge sweeps** keep the active set small and queries fast (§09).
- **Provider cost governance:** every external call has cost accounting, timeouts,
  circuit breakers; intent/classifier calls are batched/cached where privacy
  permits; no provider is a hard dependency.

## 12.4 Horizontal scale

- Stateless API replicas behind the gateway; Postgres as source of truth with
  read paths optimised by indexes/cells; realtime fan-out via the scalable
  Socket.IO + Redis/DragonflyDB adapter of the target architecture. **No new
  datastore (PostGIS/H3/Redis) is introduced in v1 beyond what the platform
  already standardises** — Exchange reuses platform infrastructure.

## 12.5 Cost & abuse ceilings

- Per-user/area rate limits (§06) also bound compute and provider cost.
- Sponsored/business volume is metered separately.
- Observability: latency, error rate, provider cost, match quality, report rate —
  all monitored with alerts (Definition of Done, roadmap v2.0 §25).

## 12.6 Capacity notes

- The flywheel is **local density**; scale is achieved city-by-city, not as one
  global index — consistent with proximity-first design. Cold/low-density areas
  degrade honestly (empty states, radius expansion), never with fabricated
  supply.
