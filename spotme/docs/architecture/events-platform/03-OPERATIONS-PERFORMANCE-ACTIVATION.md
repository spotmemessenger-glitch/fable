# Live Nearby Events — Operations, Performance & Activation (Phase 4D)

> **Status: Implemented (Draft PR — DARK).** Dark integration fences,
> instrumentation on the Phase 1G gates, measured performance, runbooks, and the
> activation checklist. Nothing here activates code. `createEventsMetrics` has
> no call sites yet.

## 1. Dark integration fences (`backend/test/events-dark-fences.spec.ts`, 11)

Load-bearing assertions over source, schema, and build artifacts: `AppModule`
imports neither `EventsModule` nor the events subtree; no backend module outside
`src/events` imports it (static or dynamic); `main.ts` is events-free; the
**web-next entry (`App.tsx`/`main.tsx`) mounts neither `EventsShell` nor the
events subtree**; the search index type carries **no coordinate field**; **no
user-origin column/field persists** anywhere (schema + subtree; the
`assertNoOriginLeak` guard is the sole, deliberate mention); no
age/gender/payment field exists; **behaviorally**, the normalize boundary
coarsens the venue (a precise input never survives) and never mints an unsourced
popularity (C2); no events flag is true and crypto flags stay false; no
secret-shaped literal; the compiled `dist/events/*` carries no provider endpoint
or secret; and a non-vacuous cluster→test map.

## 2. Instrumentation (`backend/src/events/events.observability.ts`)

Rides the Phase 1G gates: metrics register on the SHARED prom-client registry
only when `METRICS_ENABLED=true`; the metric set is CLOSED (`EVENTS_METRICS`, 6
names) with per-metric label allow-lists and per-key CLOSED value enums.
`assertEventsLabels` refuses non-allow-listed keys, identity/position/
attribution keys (`source`, `organizer`, `origin`, `lat`, `lon`, `url`, …),
decimal-shaped values, and any value outside its key's enum. Crucially the
`provider` label enum is adapter **types** (`fixture`/`unconfigured`/
`unavailable`) — never a source or organizer name. There are **no call sites yet**
(dark); wiring them is an activation step.

## 3. Performance (measured, A5-honest)

Harness: `backend/test/events-benchmark.e2e-spec.ts` (loud-skip;
`RUN_EVENTS_BENCH=1`). Run recorded 2026-08-04 on the dev container. **Largest
achieved: 50,000 events.** Nearby browse query (`ST_DWithin` + category + keyset
on `(startAt, id)` with the `geog` GIST index), warm latency:

| Scale | p50 | p95 |
|---|---|---|
| 1,000 | 2.58 ms | 6.21 ms |
| 10,000 | 11.34 ms | 14.70 ms |
| 50,000 | 43.57 ms | 71.45 ms |

(Dev container: Node 22, 4 vCPU, PostgreSQL 16 + PostGIS 3.4. `ST_DWithin` over
the `geog` GIST index + category + keyset.)

**What was measured:** first-page nearby-browse latency as the corpus grows to
50k. **What was NOT measured:** deep-page latency at fixed corpus (a design
property of keyset pagination — the query seeks on `(startAt, id)` and scans no
`OFFSET` prefix — but not swept here) and any scale beyond 50k. **Seed caveat:**
the harness seeds synthetic events on a small coarse-cell grid with uniform
categories; real corpora are skewed, which changes index selectivity — these are
an order-of-magnitude sanity check, not a production SLA. A production-hardware
re-benchmark with a representative distribution is required before activation.

## 4. Runbooks (dark foundation)

- **Provider poisoning / bad feed** — a compromised feed injects only whitelisted
  fields (raw payload never persisted); source confidence + provenance are
  carried; block by provider/source/organiser removes it; low-confidence
  handling is a config seam. **[post-activation]**
- **Fake-event / lure report spike** — reports feed moderation; the pre-publish
  classifier gates ingest; triage by the two-reviewer rule for safety-critical
  actions. **[post-activation]**
- **Stale / cancelled events** — source cancel/postpone overrides the clock and
  is shown with provenance; ended events past retention carry `expiresAt` and are
  hidden by the browse query; sweep with `repo.sweepExpired(now)` (or
  `DELETE FROM "Event" WHERE "expiresAt" <= now()`), then `ANALYZE`.
- **Search unavailable** — the adapter is unconfigured/dark; nearby browse
  (PostGIS) is independent and unaffected. **[post-activation]**
- **Projection / index rebuild** — the search projection is derived and
  rebuildable from `Event` via `toEventSearchProjection` (sanitized allow-list).
- **Free-text self-disclosure** — the platform coarsens venue location and strips
  coordinate tokens from the projection, but does not redact arbitrary
  user-visible provider text; moderation + report/takedown cover it. **[post-activation]**
- **Immediate dark rollback** — remove the `EventsModule` import from `AppModule`
  (today already absent — activation is the one-line import; rollback deletes it).
  "Dark restored" = the events dark-fence spec passing.

## 5. Activation checklist (owner-gated)

Every box is owner-retained. Exchange/Discovery activation prerequisites apply,
plus:

1. **A5 ratification** — ranking weights, retention/TTL, category allow-list
   (config seams with documented defaults here; none is an approved decision).
2. **Provider integration** — provision a real feed adapter host-side (no
   provider or credential ships); each new adapter passes `assertNoSecrets` and
   the normalize allow-list; decide any labeled sponsorship policy (owner-retained).
3. Wire the checkpoint instrumentation (no call sites yet), then enable sinks
   (`METRICS_ENABLED`, `LOG_FORMAT=json`).
4. Search provider: provision config host-side; rebuild the index from
   projections through the sanitized allow-list.
5. Moderation pipeline staffed; fake-event/lure report + block/appeal live.
6. Add `EventsModule` to `AppModule` in a reviewed activation PR; privacy
   re-review (threat model ch. 01 controls re-verified on the diff); staged
   rollout + executed rollback drill.

## 6. Non-goals

No payments/ads/sponsored ranking, no production provider, no activation, no
production wiring.
