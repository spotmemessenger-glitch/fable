# 12 — Scalability

> Part of the [Discovery Platform Architecture Specification](README.md).
> Engineering spec — draft for owner review (stacked PR; documentation only,
> nothing here activates code). Numeric values are `[PROPOSED]` config defaults.

## 12.1 Load model

Discovery load is **read-heavy, geographically bursty, and density-driven**:

- **Read-heavy.** Searches, map pans, event lists, and match browsing dominate;
  writes (publish an intent, post a moment, accept a match) are far fewer but
  latency-sensitive. Optimise the read path first; keep the write path short
  and asynchronous (§12.3).
- **Geographically bursty.** Demand concentrates where people concentrate.
  A city centre on a Friday evening, a stadium at doors-open, a festival —
  these are **hotspots**: many users in a few cells querying the same supply
  at the same time. Load is not uniform and must not be modelled as uniform.
- **The city-density flywheel.** The product's value grows with *local*
  density (roadmap v2.0 §14; [Exchange PRD
  12](../../handbook/product/exchange/12-SCALABILITY.md)): more nearby supply →
  better answers → more usage → more supply. Scale is therefore achieved
  **city by city**, not as one uniform global index (§12.7).
- **Events amplify hotspots.** Live Nearby Events deliberately points many
  users at one venue at one time. Event-adjacent cells must be treated as
  cacheable hot sets, and notification classes around events must batch
  ([07-NOTIFICATION-SERVICE](07-NOTIFICATION-SERVICE.md) §7.4) rather than
  stampede.

## 12.2 Cell-bounded queries — no full scans

Every candidate set on the platform is bounded **by construction**:

- The **adaptive radius engine**
  ([03-INTENT-GRAPH-AND-SEARCH](03-INTENT-GRAPH-AND-SEARCH.md) §3.6) expands
  through the fixed ladder `discovery.radius.steps` = [10, 15, 25, 50, 100] km
  and stops at `discovery.radius.minResults` = 8 — so a query touches the
  smallest useful area and never more than the cap. `[REUSE]`
  `spotme/web/src/lib/discovery-v2/radius.js` (draft PR #60, not merged).
- Server-side, geo queries resolve to a **set of discretized cells**
  ([08-DATA-AND-CACHING](08-DATA-AND-CACHING.md) §8.7) and hit the
  cell-first composite indexes of [08-DATA-AND-CACHING](08-DATA-AND-CACHING.md)
  §8.4 — `(type, status, geoCell)` for candidate lookup, `(expiresAt)` for
  sweeps. There is **no query shape**
  that scans a whole table of intents, events, or moments; a query that cannot
  be cell-bounded is a design defect, not a tuning problem.
- **Expiry and purge sweeps** (ch [08](08-DATA-AND-CACHING.md) §8.5 —
  `events.retention.endedHours`, `data.retention.resolvedDays`,
  `events.ttl.staleMin`) keep the *active* set small, which keeps the bounded
  queries fast. Retention is a scalability mechanism, not only a privacy one.

## 12.3 Async pipelines — writes return immediately, results stream

Expensive work never sits on a user's write path:

```
  client write (post intent / publish / accept)
      │  validate → persist row + outbox row  (ONE transaction, Postgres)
      ▼
  202-style immediate return (honest state: accepted, matching pending)
      │
      ▼                          ┌────────────────────────────┐
  transactional outbox ────────▶ │ workers (apps/workers)     │
  (ch 07 §7.7; MIGRATED_        │  · matching recompute      │
   BUILD_MEMORY §2.3)           │  · ranking of candidates   │
                                 │  · notification fan-out    │
                                 └─────────────┬──────────────┘
                                               ▼
                    results stream to clients via the platform gateway (§12.4)
                    and land in read models the next query sees
```

- **Matching** (Exchange) runs in workers off the outbox; the first proposals
  stream back within the §12.6 budget. The write itself only persists and
  enqueues.
- **Notification fan-out** consumes the same outbox
  ([07-NOTIFICATION-SERVICE](07-NOTIFICATION-SERVICE.md) §7.7): durable,
  idempotent, batched by `notify.digest.windowMin`, gated by
  `notify.match.threshold`.
- Every worker job is **idempotent and replayable** (idempotency keys, durable
  cursors — canonical migrated build memory §2.3/§2.4), so retry under load never
  duplicates a match or a notification.

## 12.4 Realtime fan-out — the platform gateway, not a Discovery datastore

Streaming results, presence, and match updates ride the **platform realtime
gateway** of the canonical target architecture (canonical migrated build memory §2.4,
reconciled in roadmap v2.0 §9/§11): horizontally scalable **Socket.IO**
gateways with a **Redis/DragonflyDB adapter** for fan-out, presence, admission
and distributed coordination, with **PostgreSQL as the only source of truth**
and cursor-based replay for missed windows.

Two boundaries are deliberate and binding:

1. **This is a platform concern.** Discovery *consumes* the gateway through the
   event contracts of [10-API-CONTRACTS](10-API-CONTRACTS.md); it does not run
   its own realtime infrastructure.
2. **The Redis/Dragonfly adapter is fan-out plumbing, not a datastore.**
   Discovery v1 introduces **no new datastore** — no PostGIS, no H3, no
   Redis-resident Discovery state ([01-PLATFORM-OVERVIEW](01-PLATFORM-OVERVIEW.md)
   §1.6; ch [08](08-DATA-AND-CACHING.md) §8.7). Nothing Discovery persists may
   live only in the adapter; losing the adapter loses connections, never truth.

## 12.5 Overload protection

Per canonical migrated build memory §2.4, applied to Discovery classes:

- **Bounded queues everywhere.** Every worker queue and per-connection send
  buffer has an explicit depth bound (`ops.queue.maxDepth.<queue>` `[PROPOSED]`,
  class `ops`); unbounded queues are forbidden.
- **Backpressure before failure.** When a bound is neared, producers slow
  (batch more, defer non-urgent classes) before anything is dropped.
- **Load shedding by class.** Under sustained overload the platform sheds in a
  fixed order `[PROPOSED]`: digests → event reminders → non-urgent match
  notifications → streamed refinements — never safety-relevant messages, and
  never by fabricating a response. A shed request surfaces an honest
  `unavailable`/`partial` result state, never a silent empty `ok`.
- **Reconnect-storm protection.** Gateway restarts and network flaps produce
  thundering herds; admission control plus jittered exponential backoff
  (`ops.gateway.reconnectJitterMs` `[PROPOSED]`, class `ops`) flatten them, and
  replay-from-cursor makes a reconnect cheap (no full refetch).
- **Hotspot caching.** Hot cell/category candidate sets are cached with short
  TTLs (ch [08](08-DATA-AND-CACHING.md) §8.6) — only privacy-permitted, already
  approximate data is ever cached; nothing cache-resident may narrow a
  location below the [02-LOCATION-PRIVACY-ENGINE](02-LOCATION-PRIVACY-ENGINE.md)
  guarantees.

## 12.6 Performance budgets `[PROPOSED]`

Budgets are **runtime configuration** (class `ops`,
[11-FLAGS-CONFIG-OBSERVABILITY](11-FLAGS-CONFIG-OBSERVABILITY.md)) used as
alert thresholds and activation gates — they tune measurement, never behaviour,
and a missed budget yields an honest state, never a fabricated result.

| Path | Budget `[PROPOSED]` | Config key |
|---|---|---|
| Search → first ranked results (warm providers) | p95 < 800 ms | `perf.search.p95WarmMs` = 800 |
| Intent publish → first Exchange match proposals | < 3 s | `perf.match.firstProposalMs` = 3000 |
| Map interaction (pan/zoom/select) on supported devices | 60 FPS | `perf.map.targetFps` = 60 |
| Notification: outbox accept → provider handoff | p95 in seconds | `perf.notify.fanoutP95Ms` = 10000 |

The search and match budgets match the [Exchange PRD
12.2](../../handbook/product/exchange/12-SCALABILITY.md) targets; the 60 FPS
interaction rule is the target architecture's frontend rule
(canonical migrated build memory §2.2). Cold-provider and cold-cache paths are
measured separately and must degrade to `loading`/`partial`, not block.

## 12.7 Capacity strategy — city by city, honest where thin

- **Grow by density, not by geography.** Capacity (cache warmth, provider
  quota, worker allocation) follows measured per-city demand. One dense city
  beats ten empty ones; there is no launch-everywhere index to keep hot.
- **Low-density areas degrade honestly.** Where supply is thin the platform
  shows **real empty states** and **transparent radius expansion** ("expanded
  to 50 km to find these") per the honesty tenet
  ([01-PLATFORM-OVERVIEW](01-PLATFORM-OVERVIEW.md) §1.4; ch
  [03](03-INTENT-GRAPH-AND-SEARCH.md) §3.6/§3.8). **Never fabricated supply:**
  no synthetic listings, no padded counts, no "popular nearby" filler invented
  to hide sparseness.
- Hotspot handling (§12.1) and per-cell caching mean a single city's burst
  cannot degrade other regions: cell-bounded queries partition load naturally.

## 12.8 Provider cost governance at scale

Scale multiplies provider spend before it multiplies infrastructure spend.
Binding rules (ch [05-PROVIDER-ABSTRACTION](05-PROVIDER-ABSTRACTION.md);
canonical migrated build memory §2.9):

- Every provider call carries timeout, cancellation, retry policy, circuit
  breaker, and **cost accounting**; supersede/cancel guards (epoch +
  AbortSignal) stop paying for stale queries mid-flight.
- **Batch and cache where privacy permits** — hot-cell place/event lookups and
  repeated intent classifications are served from cache; only approximate,
  policy-permitted data is ever batched or cached (§12.5).
- **Ceilings and alerts:** per-user quotas and daily/monthly provider ceilings
  are `ops`-class config with alerting; breaching a ceiling routes to a
  fallback provider or an honest `unavailable` state — never silent overspend
  and never a hard vendor dependency.

## 12.9 Scale gates — before any activation

No Discovery surface activates on capacity assumptions. Before activation
(recorded per [13-IMPLEMENTATION-MAP](13-IMPLEMENTATION-MAP.md) §13.7):

1. **Load tests** replaying the §12.1 shape — hotspot bursts, not uniform
   traffic — must meet the §12.6 budgets on staging topology.
2. **Soak tests** must show flat memory/queue-depth over sustained load
   (no leak, no unbounded queue).
3. **Chaos tests** must prove overload honesty: kill the adapter, a worker
   pool, a provider — clients see honest states and recover by replay; no
   fabricated data, no truth lost (Postgres remains authoritative).
4. Budgets, ceilings, and dashboards live per the Definition of Done
   (roadmap v2.0 §25; canonical migrated build memory §5); **owner approves
   activation**.

## 12.10 Deterministic testing

Load behaviour is tested deterministically below the load tests: injected
clock/seed/config drive queue-bound, shed-order, and backoff logic (no wall
clock, no real network); invariant tests pin that radius steps are strictly
ascending and every query shape is cell-bounded; mutation-style tests prove
shedding and caching never emit fabricated results, never turn `partial` into
`ok`, and never let cached data narrow a location past the privacy engine.
Reconnect storms are simulated with seeded jitter so backoff distributions are
reproducible.
