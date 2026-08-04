# Exchange Platform — Operations, Performance & Activation (Phase 3E)

> **Status: Implemented (Draft PR — DARK).** Dark integration fences,
> instrumentation on the Phase 1G gates, measured performance, runbooks, and the
> activation checklist. Nothing here activates code. The `[when instrumented]`
> caveat applies: `createExchangeMetrics` has no call sites yet.

## 1. Dark integration fences (`backend/test/exchange-dark-fences.spec.ts`, 9)

Load-bearing assertions over source, manifests, and build artifacts:
`AppModule` imports neither `ExchangeModule` nor the exchange subtree; no
backend module outside `src/exchange` imports it (static or dynamic); `main.ts`
is exchange-free; the search index type carries no coordinate field; no
age/gender/payment field exists anywhere in the exchange subtree; the business
seam is dark (no reachable business flow — D4); no exchange feature flag is
true and crypto flags stay false; no secret-shaped literal; the compiled
`dist/exchange/*` output carries no Typesense endpoint or secret; and a
non-vacuous cluster→test map (every exchange module has a proving suite).

## 2. Instrumentation (`backend/src/exchange/exchange.observability.ts`)

Rides the Phase 1G gates: metrics register on the SHARED prom-client registry
only when `METRICS_ENABLED=true`; the metric set is CLOSED
(`EXCHANGE_METRICS`, 6 names) with per-metric label allow-lists and per-key
CLOSED value enums. `assertExchangeLabels` refuses non-allow-listed keys,
identity/position keys, decimal-shaped values, and any value outside its key's
enum — a label can never become an identity/position channel. There are **no
call sites yet** (dark); wiring them is an activation step.

## 3. Performance (measured, A5-honest)

Harness: `backend/test/exchange-benchmark.e2e-spec.ts` (loud-skip;
`RUN_EXCHANGE_BENCH=1`). Run recorded 2026-08-04 on the dev container (4 vCPU,
PostgreSQL 16.13 + PostGIS 3.4). **Largest achieved: 100,000 intents.** Browse
keyset query (category + kind + visibility + status, keyset on `(createdAt,
id)`), warm latency:

| Scale | p50 | p95 |
|---|---|---|
| 1,000 | 2.5 ms | 4.6 ms |
| 10,000 | 11.1 ms | 14.2 ms |
| 100,000 | 44.3 ms | 47.8 ms |

Sub-linear growth; the indexed keyset query stays flat with page depth (same
property the discovery keyset buys). These are dev-container numbers and do
NOT replace a production-hardware re-benchmark before activation (A4). Nothing
beyond 100k is claimed. The lifecycle/idempotency/concurrency paths are
covered by the e2e suite, not separately micro-benchmarked.

## 4. Runbooks (dark foundation)

- **Prohibited-content / fraud report spike** — reports land on
  `ExchangeLifecycleEvent`-adjacent moderation state; the pre-check + async
  classifier pipeline (§threat model T-EX-1/2/15) gates publish; a spike is
  triaged by the two-reviewer rule for safety-critical actions. **[post-activation]**
- **Stale/expired intents** — expired rows are already unqueryable (the
  discoverable query excludes `expiresAt <= now`); sweep with
  `DELETE FROM "ExchangeIntent" WHERE "expiresAt" <= now() - interval '7 days' AND status IN ('expired','withdrawn','removed')`, then `ANALYZE`. Retention: no
  history table beyond the append-only lifecycle audit.
- **Search unavailable** — the adapter is unconfigured/dark; browse (PostGIS)
  is independent and unaffected. **[post-activation]**
- **Public projection / index rebuild** — the search projection is derived and
  rebuildable from `ExchangeIntent` via `toSearchProjection` (sanitized,
  allow-list). The projection is deleted with the intent (cascade).
- **Privacy incident** — same procedure as discovery ch. 16 §16.5: contain
  (env-gate the sink), preserve evidence (correlation ids only), scope,
  eradicate + add a fence, purge, report.
- **Immediate dark rollback** — remove the `ExchangeModule` import from
  `AppModule` (today it is already absent — activation is the one-line import;
  rollback deletes it). "Dark restored" = the exchange dark-fence spec passing.

## 5. Activation checklist (owner-gated)

Every box is owner-retained. Exchange builds on the discovery activation
prerequisites (DPAS §13.9.1) plus:

1. **A5 ratification** of the Exchange PRD — ranking weights, TTL/retention,
   category allow-list, notification thresholds (all config seams with
   documented defaults here; none is an approved decision yet).
2. **D4 business participation** — currently a dark seam (individuals-only v1);
   activating any business flow is a separate owner decision.
3. Wire the checkpoint instrumentation into service/adapters (no call sites
   yet), then enable sinks (`METRICS_ENABLED`, `LOG_FORMAT=json`).
4. Search provider: provision `EXCHANGE`/Typesense config host-side; rebuild the
   index from projections through the sanitized allow-list.
5. Moderation pipeline staffed; report/block/appeal + two-reviewer rule live.
6. Add `ExchangeModule` to `AppModule` in a reviewed activation PR; privacy
   re-review (threat model ch. 01 controls re-verified on the diff); staged
   rollout + executed rollback drill.

## 6. Non-goals

No payments/escrow/checkout, no advertising/sponsored ranking, no business
flow, no activation, no production wiring.
