# 02 — Location & Privacy Engine

> Part of the [Discovery Platform Architecture Specification](README.md).
> Engineering spec — draft for owner review (stacked PR; documentation only,
> nothing here activates code). Numeric values are [PROPOSED] config defaults.

## 2.1 Service responsibilities

The Location & Privacy Engine is the platform service that owns **every
transformation between a device's precise GPS fix and anything another party
may see**. Every Discovery surface — Map, Exchange, Live Events, Moments, AI
Assistant — consumes location through this engine and only through it.

Responsibilities:

1. **Hold the precise domain device-local.** The precise fix exists only on
   the announcing device, for distance, centring, radius and routing
   ([ADR-019](../../adr/019-discovery-v2-privacy-model.md)).
2. **Produce the public position** — a deterministic, bounded, on-device
   approximation ([ADR-018](../../adr/018-deterministic-location-grid.md)).
3. **Enforce hidden/ghost mode**: `showOnMap=false` transmits no coordinates.
4. **Publish the honesty bound** (`maxDisplacementM`) so UI copy can say
   "shown within ~Xm" truthfully.
5. **Gate escalation through consent** — anything finer than the approximation
   is a per-interaction user choice, never a default (§2.5).
6. **Guard the boundary with mutation-style tests** so a regression that
   restores precise coordinates fails CI, not review (§2.7).

The engine is a **live-path privacy primitive, not dark Discovery-V2 code**:
it must run whenever presence is announced, regardless of any feature flag
([ADR-015](../../adr/015-compile-time-feature-flags.md) gates surfaces, never
this boundary). Honesty note: the implementation below lives in **draft PR
#60** and is **not on master**; until that PR merges, the v1
precise-broadcast defect still exists on master (ADR-019). Nothing in this
chapter may be described as shipped.

## 2.2 The approximation pipeline

`[REUSE]` `spotme/web/src/lib/geo-approx.js` (draft PR #60).

```
DEVICE — precise domain (nothing below the bar ever leaves the device)
┌────────────────────────────────────────────────────────────────────┐
│ precise fix {lat, lon}                                             │
│   (getCurrentPosition / watchPosition, high accuracy)              │
│    │                                                               │
│    ├──► device-local uses ONLY: distanceM, map centring, radius    │
│    │    bounding, routing origin (§2.4)                            │
│    ▼                                                               │
│ [1] snapToCell(lat, lon, {cellM})                                  │
│     → centre of the ~cellM privacy cell                            │
│    ▼                                                               │
│ [2] + per-person, per-window rotating BOUNDED offset               │
│     windowIdx = floor(now / windowMs)                              │
│     angle     = hash(id)·2π + windowIdx·(π/3)                      │
│     radiusM   = maxOffsetM · (0.5 + 0.5·hash(id + ":r"))           │
│    ▼                                                               │
│ [3] publicPositionFor(position, show, id, now)                     │
│     show=false or no usable fix → { lat: null, lon: null }         │
└───────────────┬────────────────────────────────────────────────────┘
                ▼   the ONLY location that crosses the wire
     PUBLIC position — approximate, displacement ≤ maxDisplacementM()
```

Each step buys a specific property:

- **Cell snap** (step 1) is the correlation-defeating step. All fixes inside
  one cell collapse to the **same** cell centre, so an observer averaging many
  announcements converges on the coarse cell — never the true point. A stable
  per-person jitter alone would average straight back to the home location;
  this is exactly the flaw in the superseded v1 helper (`coarse()` in
  `spotme/web/src/lib/discovery.js`, ~110 m rounding + stable jitter), which
  ADR-018 replaces.
- **Rotating bounded offset** (step 2) gives liveness — the point moves —
  while staying inside `maxOffsetM` of the cell centre. It is deterministic
  from `(id, window)`: stable inside a window, different across windows.
- **Fixed angular step per window** (π/3 → a full orbit every six windows)
  means consecutive windows sit one bounded chord apart: the point drifts, it
  never teleports.

## 2.3 API surface

`[REUSE]` `spotme/web/src/lib/geo-approx.js` — a pure module with no
app/browser imports, so tests can attack it directly.

| Export | Semantics |
|---|---|
| `snapToCell(lat, lon, {cellM})` | Centre of the ~`cellM` privacy cell containing the fix. Exported so the marker layer and privacy tests can reason about cells directly. |
| `approxPublicPosition(lat, lon, {id, now, cellM, windowMs, maxOffsetM})` | Full pipeline: snap + rotating bounded offset. Returns `{lat, lon}` or `null` for a non-finite/out-of-range input. `now` and `id` are the injected clock and seed. |
| `publicPositionFor(position, show, id, now)` | **THE single public-position boundary.** The one place a precise fix becomes the public lat/lon that presence announces. `show=false` (ghost/hidden) or no usable fix → `{ lat: null, lon: null }`; otherwise the approximation. Precise coordinates must never reach the wire through any other path. |
| `maxDisplacementM({cellM, maxOffsetM})` | Upper bound (metres) on public-vs-true displacement: `√2·(cellM/2) + maxOffsetM` — worst-case corner snap plus the offset cap (≈504 m at owner-approved values). Surfaced to UI as the honest "shown within ~Xm" copy. |

Consumption points `[REUSE]`:

- `spotme/web/src/lib/discovery.js` — the presence announcement spreads
  `publicPositionFor(position, show, p.id)` into the payload; the precise
  position never enters the announcement and never leaves the device (the
  module's `myPosition()` accessor exposes it **device-locally only**, for map
  centring and distance — an ADR-019-compliant local use, not a wire path).
- `spotme/web/src/lib/discovery-v2/people.js` — markers are built only from
  already-approximate announcements, carry `approximate: true`, whitelist
  their fields, and ship `assertNoPreciseLeak()` for defensive call sites.

## 2.4 Origin handling for search

The **precise fix stays device-local** and is used only for distance
computation, map centring and radius bounding
(`[REUSE]` `spotme/web/src/lib/discovery-v2/search.js`).

**What the dark code does today** (`[REUSE]`, and what
[ADR-019](../../adr/019-discovery-v2-privacy-model.md) permits): where a nearby
provider lookup **technically requires** an origin, `discovery-v2/search.js`
and `live-events/search.js` pass the device-local origin to the provider
adapter, under the never-store / never-log / distance-only discipline. The
origin is never stored, logged, or attached to results beyond the resulting
distance number.

**`[PROPOSED]` platform tightening (not current dark-code behaviour):** the
platform search port types its origin parameter as **coarse-only** —
cell-snapped via `snapToCell`, never the raw fix — through the provider port of
[05-PROVIDER-ABSTRACTION](05-PROVIDER-ABSTRACTION.md)
([ADR-017](../../adr/017-provider-neutral-adapters.md): a provider receives the
minimum). This goes beyond ADR-019's "technically requires an origin"
allowance, so the compiler — not discipline — keeps the precise fix out of
provider calls. Until the owner ratifies and the port lands, the mutation suite
must fence the origin path per surface. Chapters
[03](03-INTENT-GRAPH-AND-SEARCH.md), [06](06-AI-INTERFACES.md) and
[10](10-API-CONTRACTS.md) restate this rule; it is `[PROPOSED]` there too.

## 2.5 Consent-gate model

Visibility is layered, opt-in, and never inferred:

1. **Map visibility is opt-in** (`showOnMap`); off ("ghost") transmits no
   position at all while chat by name still works.
2. **Approximate-by-default**: opting in reveals only the §2.2 public
   position, with the `~` bound stated in the UI.
3. **Per-interaction escalation at handoff**: sharing anything finer
   (neighbourhood, venue, exact point) is an explicit, revocable, per-exchange
   user action at the consent gate — the model the Exchange PRD binds for
   matching and handoff
   ([exchange/07-PRIVACY](../../handbook/product/exchange/07-PRIVACY.md)
   §7.1–§7.2: two people can match without either learning the other's exact
   position; visibility is not consent; defaults are the privacy-preserving
   option).
4. Consent choices are recorded and editable; withdrawal takes effect for all
   future surfacing (Exchange PRD §7.2).

## 2.6 Configuration

Per the platform configuration principle
([11-FLAGS-CONFIG-OBSERVABILITY](11-FLAGS-CONFIG-OBSERVABILITY.md)):
ACTIVATION stays compile-time (ADR-015/
[ADR-016](../../adr/016-dark-shipping.md)); TUNING is runtime config in three
classes. The engine's parameters are class **`privacy-critical` — excluded
from ordinary runtime tuning entirely**:

| Key | Owner-approved value | Meaning |
|---|---|---|
| `discovery.privacy.cellM` | 500 | Privacy-cell edge (m) — the granularity the public position reveals |
| `discovery.privacy.windowMs` | 1800000 (30 min) | Rotation window — how often the in-cell offset changes |
| `discovery.privacy.maxOffsetM` | 150 | Cap on the in-cell offset (m), kept well under `cellM / 2` |

These are **NOT runtime-tunable at all** (owner directive, 2026-08-03:
privacy-guarantee-affecting values cannot be altered by ordinary runtime
configuration). The 500 m / 30 min / 150 m values are owner-approved (ADR-018,
PR #60 review) and **stay declared in code** as constants (`CELL_M`,
`WINDOW_MS`, `MAX_OFFSET_M`), with per-call overrides used only by tests. Any
change ships as a **code-reviewed change with explicit owner approval**, whose
same PR updates the mutation/privacy tests and re-validates the invariants
(`maxOffsetM < cellM / 2`; `windowMs ≥` a floor that keeps rotation
meaningful; all three finite and positive). The config registry lists the keys
**read-only, for visibility** ([11 §11.5](11-FLAGS-CONFIG-OBSERVABILITY.md)).
Weakening any of them is a privacy decision, never a tuning exercise.

## 2.7 Invariants the mutation tests pin

`[REUSE]` test pattern: `spotme/web/test/discovery-privacy.test.js` (draft PR
#60). The suite is mutation-style: reintroducing raw coordinates anywhere on
the public path must fail it.

1. **Deterministic** given `(id, clock)` — same inputs, same public position.
2. **Never equals the precise fix** for any valid input.
3. **Displacement bounded**: public-vs-true distance ≤ `maxDisplacementM()`.
4. **Stable within a window** — repeated announcements in one window agree.
5. **Rotates across windows** — adjacent windows produce different positions.
6. **No teleport** — consecutive-window positions sit within a bounded chord.
7. **Long-run centroid collapses to the cell centre**, not the true point
   (the anti-averaging property).
8. **Hidden transmits nothing** — ghost/no-fix yields `{lat:null, lon:null}`.
9. **No precise-coordinate string** appears in the serialized public model
   (announcements, markers, logs of them, DOM built from them —
   `assertNoPreciseLeak`).

## 2.8 Threat model summary

| Threat | Mechanism | Defeated by |
|---|---|---|
| **Home inference via averaging** | Collect many announcements; average out jitter to recover the true point | Cell snap: every announcement orbits the **cell centre**, so the average converges on the coarse cell (invariant 7), never the home |
| **Correlation / tracking** | Link positions across windows and sessions to build a fine-grained track | Offset derives from `(id, window)`, bounded and orbiting; the finest recoverable signal is the ~`cellM` cell; window rotation prevents refining within it |
| **Stalking / real-time approach** | Use a live marker to walk to a person | Public position is up to `maxDisplacementM()` off and honestly labelled; ghost mode withholds entirely; blocked users are filtered before markers exist; anything finer requires per-interaction consent (§2.5); distances render as "~X m", never exact |

Supporting rules (ADR-019): the precise fix is never persisted unnecessarily,
logged, put in analytics or URLs, exposed via debug handles, or recoverable
from a marker, event, or the DOM.

## 2.9 What other services receive — and never receive

**May receive (approximate only):** the public position, the
`approximate: true` flag and `accuracyM` bound, device-locally computed
distance numbers, coarse cell-snapped origins (§2.4), and coarse areas on
Exchange Needs/Offers (PRD §7.1). This covers
[03-INTENT-GRAPH-AND-SEARCH](03-INTENT-GRAPH-AND-SEARCH.md),
[04-RANKING-SERVICE](04-RANKING-SERVICE.md) (proximity inputs),
[07-NOTIFICATION-SERVICE](07-NOTIFICATION-SERVICE.md) (nearby triggers),
providers behind [05-PROVIDER-ABSTRACTION](05-PROVIDER-ABSTRACTION.md), and
the wire contracts of [10-API-CONTRACTS](10-API-CONTRACTS.md).

**No service, provider, log, store or contract may receive the precise fix.**
There is no privileged consumer; the only holder of the precise domain is the
device that produced it.

## 2.10 Deterministic testing

Injected: **clock** (`now`), **seed** (`id`), and **config** (`cellM`,
`windowMs`, `maxOffsetM` as explicit options) — the module is pure, so every
property in §2.7 is a plain unit assertion with no mocking of geolocation.
Tests advance the injected clock across window boundaries to pin stability,
rotation and the no-teleport chord, and sweep many windows to pin the
centroid collapse. The suite is the executable form of this chapter: a change
that passes review but violates §2.7 must still fail CI.

## 2.9 As built (Phase 2A/2B/2E — Draft PR, DARK): PostGIS query & index guide

**Storage.** `DiscoveryVisibility` holds ONLY the coarse public point
(`coarseLat`/`coarseLon`/`coarseCell` per ADR-018) plus a
`geography(Point,4326)` column (`geog`) written from the SAME coarse values,
indexed with GIST (`backend/prisma/migrations/20260803190000_discovery_postgis/`
— the migration header records rollback, permissions, retention and deletion
posture). `expiresAt` makes presence ephemeral; `visibilityVersion` is
monotonic for realtime staleness drops.

**The query** (`backend/src/discovery/discovery.prisma.repository.ts`): one
CTE with EVERY exclusion in SQL — enabled, non-null geog, unexpired, not
self, `ST_DWithin` radius bound, both-direction block anti-join,
`discoverable` projection join — so an unauthorized row is never fetched.
Ordering `ST_Distance ASC, userId ASC`; keyset continuation strictly after
`(distance, userId)`; `LIMIT` bound by policy (max page 30). The computed
distance is SERVER-INTERNAL: it derives the band and the cursor and never
serializes to a client (C12 fence). Clients receive distance BANDS only.

**Client boundary.** The precise device fix exists only inside the web-next
geolocation port scope; `coarsenForPublic` (`web-next/src/discovery/coarsen.ts`
— deterministic per-identity jitter ±~100 m + 3-decimal rounding, displacement
proven 1–250 m) is the ONLY constructor of the branded coarse type; the
privacy mutation battery scans every outbound surface for the raw values.

**Capacity.** Measured to 1M profiles — see
[15-PERFORMANCE-AND-CAPACITY](15-PERFORMANCE-AND-CAPACITY.md) §15.2 for the
latency tables, the wide-radius bottleneck, plan-instability observation and
the KNN scaling trigger. `ANALYZE` freshness is operationally load-bearing
(runbook §16.2).
