# 08 — Data & Caching

> Part of the [Discovery Platform Architecture Specification](README.md).
> Engineering spec — draft for owner review (stacked PR; documentation only,
> nothing here activates code). Numeric values are [PROPOSED] config defaults.

## 8.1 Service responsibilities and target home

This chapter fixes **where Discovery data may live, what shape it may take,
how long it may exist, and how it is cached** — one data discipline for all
five surfaces, so the privacy boundary
([02-LOCATION-PRIVACY-ENGINE](02-LOCATION-PRIVACY-ENGINE.md)) is enforced in
the schema, not just in code paths.

Target home: **PostgreSQL + Prisma** behind `apps/api`, with reviewed
migrations (canonical migrated build memory §2.3); durable client data in
**IndexedDB repositories** in `apps/web` (memory §2.2); shared row/record
types from `packages/{contracts,domain}` — no duplicated domain contracts
between client and server (memory §2.1).

Honesty about today: **no Discovery table, migration, or server store
exists.** The dark code on draft PRs #60/#61 is client-side and pure — it
persists nothing. The Exchange schema is a `[PROPOSED]` Prisma sketch in the
PRD ([exchange/09](../../handbook/product/exchange/09-DATABASE-SCHEMA.md)),
pending A5 ratification. Everything in this chapter is `[PROPOSED]` except the
behavioural precursors cited `[REUSE]`.

## 8.2 Per-surface data ownership

One owner per entity; every other service reads through that owner's contract
([10-API-CONTRACTS](10-API-CONTRACTS.md)) — never through its tables.

| Surface / service | Entities | Server-side persistence — the rule |
|---|---|---|
| Discovery Map (presence) | live presence announcements | **EPHEMERAL.** Presence exists only in the realtime layer while announced; **no location-history table, ever** ([ADR-019](../../adr/019-discovery-v2-privacy-model.md); [02 §2.9](02-LOCATION-PRIVACY-ENGINE.md)). Hidden mode transmits nothing, so there is nothing to store. |
| Discovery Map (places) | provider place results | **None.** Read-through from providers ([05-PROVIDER-ABSTRACTION](05-PROVIDER-ABSTRACTION.md)); short-TTL caches only (§8.6). |
| Exchange / Intent Graph | `ExchangeItem`, `Match`, `Reputation`, `Report`, `ConsentRecord` | **Owned, persisted** in PostgreSQL per the PRD sketch ([exchange/09](../../handbook/product/exchange/09-DATABASE-SCHEMA.md)) `[PROPOSED]`. The only durable Discovery **domain/content** store in v1 (the notification outbox of [07-NOTIFICATION-SERVICE](07-NOTIFICATION-SERVICE.md) and the client IndexedDB queues of [09-OFFLINE-SYNC](09-OFFLINE-SYNC.md) are separate durable *operational* state). |
| Live Nearby Events | normalised event records | **NO persisted event store.** Events are read-through from providers and pruned by TTL/retention (§8.5) `[REUSE]` `spotme/web/src/lib/live-events/time.js` (draft PR #61). |
| Nearby Moments | moment posts | **Future** — planned surface; schema is specified when its mission is approved, bound by §8.3 in advance. |
| AI Assistant & Personalization | opt-in personalization signals | **Future**, consent-gated ([06-AI-INTERFACES](06-AI-INTERFACES.md)); no store exists or is proposed here. |
| Notification Service | delivery/digest state | Owned by [07-NOTIFICATION-SERVICE](07-NOTIFICATION-SERVICE.md); payloads obey §8.3. |

## 8.3 Platform schema conventions — binding on every surface

These conventions are **specification, not tunables**; a migration that
violates one is rejected at review:

1. **No exact-coordinate column anywhere.** A row may carry only
   **approximate cell values** (`approxCellLat`/`approxCellLon` — cell-snapped
   on device, [ADR-018](../../adr/018-deterministic-location-grid.md)/019)
   plus a **discretized `geoCell`** id for indexing.
   The cell derivation is the snap primitive `[REUSE]`
   `snapToCell` (`spotme/web/src/lib/geo-approx.js` — live-path privacy code).
   No column, index, log, or backup may reconstruct a precise fix.
2. **No sensitive-attribute column** (religion, health, orientation, …) and no
   derived proxy for one ([exchange/07 §7.4](../../handbook/product/exchange/07-PRIVACY.md);
   constitution — no sensitive-trait inference).
3. **Owner-scoped rows.** Every user-generated row carries its `ownerId`;
   reads and mutations are authorised against it (memory §2.3 — controllers
   validate and authorize). Owner scoping is what makes export/delete (§8.5)
   complete by construction.
4. **Banded values, not exact amounts** where a range serves the product —
   e.g. `budgetBand`, never a precise budget
   ([exchange/09](../../handbook/product/exchange/09-DATABASE-SCHEMA.md)).
5. **Provider payloads never persist raw.** Only whitelist-normalised models
   ([05 §5.4](05-PROVIDER-ABSTRACTION.md)) may be stored or cached.

## 8.4 PostgreSQL, Prisma, and migration discipline

- **PostgreSQL + Prisma** is the canonical persistence stack (memory §2.3);
  Discovery adds tables to it — it does not add a datastore (§8.7).
- Migrations are **reviewed and rehearsed against production-like data**
  (memory §2.3).
- **No destructive migration without an explicit rollback or forward-repair
  plan** (memory §2.3). Dropping or rewriting a column that the honesty rules
  depend on (e.g. a state or audit column) additionally requires the owner's
  sign-off, as does any migration touching a `privacy-critical` shape (§8.3).
- Hot-path indexes follow the PRD sketch: `(type, status, geoCell)` for
  candidate lookup, `(ownerId, status)` for owner views, `(expiresAt)` for
  sweeps, `(needId, status, score)` for match ranking `[PROPOSED]`.

## 8.5 Retention and purge

Retention is behaviour fixed here; the windows are runtime configuration
([11-FLAGS-CONFIG-OBSERVABILITY](11-FLAGS-CONFIG-OBSERVABILITY.md)):

| Config key `[PROPOSED]` | Default | Class | Meaning |
|---|---|---|---|
| `data.retention.resolvedDays` | 30 | `product` | Resolved/expired Exchange items and their matches are purged after this window ([exchange/07 §7.3](../../handbook/product/exchange/07-PRIVACY.md)); minimal safety/audit records are kept per policy. |
| `events.retention.endedHours` | 6 | `product` | Ended events older than this are removed from the surface `[REUSE]` `DEFAULT_RETENTION_MS`, `isExpired` (`spotme/web/src/lib/live-events/time.js`). |
| `events.ttl.staleMin` | 15 | `ops` | A fetched event record older than this is stale `[REUSE]` `DEFAULT_TTL_MS`, `isFresh` (same module). |

Rules:

- **Sweep jobs are idempotent** and driven by the transactional outbox
  (memory §2.3): the expiry sweep transitions `ACTIVE → EXPIRED` past
  `expiresAt`, then purges past the retention window
  ([exchange/09 §9.3](../../handbook/product/exchange/09-DATABASE-SCHEMA.md)).
  Re-running a sweep is a no-op; a crashed sweep resumes without double
  effects.
- **Event pruning never overrides the source's lifecycle**: cancelled and
  postponed listings are not "expired away" by clock maths `[REUSE]`
  `live-events/time.js` (the source wins).
- **User export and delete rights** are honoured platform-wide: a user can
  export their Discovery data and delete an item (with its matches) at any
  time; deletion takes effect immediately for future surfacing
  ([exchange/07 §7.7](../../handbook/product/exchange/07-PRIVACY.md)). Owner
  scoping (§8.3) makes both operations enumerable.
- Validation invariants: retention and TTL values positive and bounded;
  `events.ttl.staleMin` strictly shorter than `events.retention.endedHours`.

## 8.6 Caching layers

```
device                          apps/api                       providers
┌──────────────────┐   ┌─────────────────────────┐   ┌──────────────────┐
│ IndexedDB read    │   │ candidate-set cache      │   │ provider response │
│ cache ("as of t") │ ← │ (short TTL, in-process)  │ ← │ cache (only where │
│ [09-OFFLINE-SYNC] │   │                          │   │ policy permits)   │
└──────────────────┘   └─────────────────────────┘   └──────────────────┘
```

1. **Client read cache (IndexedDB).** Last-synced items, matches, and browse
   results, labelled "as of \<time\>" and never presented as live — the read
   model of [09-OFFLINE-SYNC](09-OFFLINE-SYNC.md).
2. **Server candidate-set caches.** Normalised candidate sets (per cell
   neighbourhood + query class) may be cached **in-process with short TTLs**
   to absorb repeat queries — `cache.candidates.ttlS` = 60 `[PROPOSED]`
   (class `ops`). A cache hit is still ranked fresh
   ([04-RANKING-SERVICE](04-RANKING-SERVICE.md)); staleness never reorders
   honesty states.
3. **Provider response caches — only where policy permits.** A provider's
   responses are cached only when its licence **and** the privacy policy allow
   it ([05 §5.8](05-PROVIDER-ABSTRACTION.md)); cached entries are the
   whitelist-normalised models, never raw payloads.

**Cache keys never contain precise coordinates.** Keys are built from the
discretized cell (or cell neighbourhood), radius step, and normalised query —
the same discipline as the wire ([02 §2.9](02-LOCATION-PRIVACY-ENGINE.md)). A
precise fix in a cache key is a privacy leak into whatever observes the cache
(metrics, logs, memory dumps) and is mutation-tested against (§8.9).

## 8.7 Geo indexing — discretized cells; no new datastore in v1

Spatial lookup is **cell-based**: rows carry `geoCell` (§8.3); a radius query
enumerates the cells covering the current adaptive-radius step
([03 §3.6](03-INTENT-GRAPH-AND-SEARCH.md)) and filters within them.
Cell-centre distance is sufficient — public positions are only cell-accurate
anyway (ADR-018), so a finer index would add precision the data deliberately
does not have.

**Explicitly out of scope for v1: PostGIS and H3**, and any new datastore
introduced *by Discovery* — no Redis/Dragonfly, no search engine, no
geo-store (roadmap reconciliation; [README](README.md)). The canonical memory
(§2.11) lists PostGIS/H3 as long-term stack; adopting them is a later,
owner-approved wave, not a v1 dependency. The platform's realtime layer
(Socket.IO + Redis adapter, memory §2.4) is a **platform concern** that
presence rides on — Discovery does not introduce it and does not use it as a
database.

## 8.8 Invalidation rules

- **Supersede beats caches.** A newer query invalidates the older in-flight
  one; a stale result set is dropped, never rendered `[REUSE]` the
  epoch + `AbortSignal` guard (`spotme/web/src/lib/discovery-v2/search.js`,
  draft PR #60; [03 §3.7](03-INTENT-GRAPH-AND-SEARCH.md)).
- **TTL expiry marks, then removes.** Stale event records fall out via
  `pruneStaleEvents` `[REUSE]` (`live-events/time.js`); between TTL and
  removal the UI labels the data's age, never claims liveness.
- **Writes invalidate their scope.** A mutation (item created/updated,
  match accepted) invalidates candidate-set cache entries for the affected
  cells and the owner's cached views; matches are marked `SUPERSEDED`, not
  deleted mid-flight ([exchange/09 §9.3](../../handbook/product/exchange/09-DATABASE-SCHEMA.md)).
- **Config changes invalidate derived caches**: a change to ranking weights or
  radius steps ([11-FLAGS-CONFIG-OBSERVABILITY](11-FLAGS-CONFIG-OBSERVABILITY.md))
  flushes candidate-set caches so no user sees a mixture of old and new
  policy.

## 8.9 Deterministic testing

**Injected:** clock (TTL, retention, sweep timing — every time-dependent
function takes `now`, the discipline `[REUSE]` `live-events/time.js`
established), config (retention/TTL/cache keys), seeded fixtures, fake stores.
**Mutation/invariant tests pin:** no schema or cache key ever carries a
precise coordinate (a precise lat/lon planted in a row, cache key, or export
must fail the suite — the [02 §2.7](02-LOCATION-PRIVACY-ENGINE.md) boundary
extended to storage); sweeps are idempotent (running twice equals running
once); purge honours the configured windows exactly at the boundary instant;
cancelled/postponed events survive expiry pruning (source wins); a raw
provider payload planted in a cache entry fails normalisation checks; and
export/delete for an owner enumerates every row that owner created. Capacity
and load behaviour of these stores is [12-SCALABILITY](12-SCALABILITY.md);
migration sequencing is [13-IMPLEMENTATION-MAP](13-IMPLEMENTATION-MAP.md).
