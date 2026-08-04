# Nearby Moments — Operations, Performance & Activation (Phase 5E)

> **Status: Implemented (Draft PR — DARK).** Dark fences + the full M9
> verification battery, closed metrics on the 1G gates, measured performance,
> runbooks, and the activation checklist. Nothing here activates code;
> `createMomentsMetrics` has no call sites yet.

## 1. Dark fences + M9 battery (`backend/test/moments-dark-fences.spec.ts`, 12)

`AppModule` imports neither `MomentsModule`/`MediaModule` nor their subtrees;
no outside module imports them; the web-next entry mounts no `MomentsShell`;
the media queue factory is INERT without env (behavioral); the **EXIF strip is
re-proven at fence level** (the GPS fixture comes out clean); **private/friends
never enter the projection** (building one THROWS; coordinate tokens stripped;
city cell only); the **ranking invariant** re-runs every forbidden signal and
they all throw; the **import-graph scan** proves no camera-branch / bullmq /
S3-SDK import in any moments file (storage only via the seam); the
**dependency scan** proves no media/AI binary dependency was added; no
age/gender/payment/counter field; no flag true, crypto flags false, no secret
literal; the **build-artifact scan** covers `dist/moments*` +
`dist/moment-media*`; a non-vacuous cluster→test map. Together with the secret
scan, a11y, privacy-mutation, and dark-fence batteries this is the full M9 set.

## 2. Instrumentation (`backend/src/moments/moments.observability.ts`)

Closed `MOMENTS_METRICS` (6 names) on the shared Phase 1G registry (gated by
`METRICS_ENABLED`); per-key CLOSED value enums; `assertMomentsLabels` refuses
author/viewer/coordinate/free-text keys, decimal-shaped values, and any
off-enum value. No call sites yet (dark).

## 3. Performance (measured, honest — never extrapolated)

Harness: `backend/test/moments-benchmark.e2e-spec.ts` (loud-skip;
`RUN_MOMENTS_BENCH=1`). Run recorded 2026-08-04 on the dev container.
**Largest achieved: 100,000 moments.** Nearby-feed query (`ST_DWithin` +
tier/block filters + keyset), warm latency:

| Scale | p50 | p95 |
|---|---|---|
| 1,000 | 4.94 ms | 7.30 ms |
| 10,000 | 39.79 ms | 43.26 ms |
| 100,000 | 389.16 ms | 422.06 ms |

(Dev container: Node 22, PostgreSQL 16 + PostGIS 3.4.)

**Honest flag:** growth is roughly linear here — the two per-row `NOT EXISTS`
block subqueries and the spatial filter dominate at 100k. This is acceptable
for a dark foundation but NOT for activation; the pre-activation checklist
includes query tuning (pre-joined block sets, tighter partial indexes, and a
`{feed-refresh}` materialization seam already reserved in M8) and a
re-benchmark on production hardware.

Measured = first-page nearby-feed latency vs corpus size. NOT measured:
deep-page latency at fixed corpus (a keyset design property, not swept here)
or any scale beyond the largest achieved. Seed caveat: synthetic uniform grid;
real corpora are skewed. A production-hardware re-benchmark with a
representative distribution is required before activation.

## 4. Runbooks (dark foundation)

- **Moderation surge** — reports land sanitized on `{moderation}`; triage by
  reason; `limited` reduces reach before a `removed` verdict; thresholds and
  staffing are owner-retained. **[post-activation]**
- **Child-safety report handling (M6, MANDATORY path)** — `child-safety`
  reports enter the priority lane; the handling duty is: immediate
  `moderation-hidden`/`removed` on confirmation, evidence preservation,
  escalation to the designated authority per the legal-review outcome, and no
  ordinary-queue dwell time. Staffing + legal sign-off are HARD activation
  prerequisites (§5). **[post-activation]**
- **Media backlog** — `{moment-media}` jobs are contracts; a backlog is
  drained by scaling workers (activation infrastructure); thumbnails are
  rebuildable from stored (stripped) originals; dedup prevents re-processing.
- **Privacy incident** — same containment procedure as discovery ch. 16 §16.5;
  additionally verify the EXIF-strip fence and the projection fence still pass
  before declaring containment.
- **Immediate dark rollback** — remove the `MomentsModule`/`MediaModule`
  imports from `AppModule` (today already absent). "Dark restored" = the
  moments dark-fence spec passing.

## 5. Activation checklist (owner-gated)

Every box is owner-retained. HARD prerequisites first:

1. **Moderation staffing** — a staffed queue with the child-safety lane
   covered 24/7 is a HARD prerequisite; no activation without it.
2. **Legal review** — child-safety reporting duties, takedown process, and the
   D6 age policy ([PROPOSED] 18+ for location/public posts) reviewed and
   signed off; a HARD prerequisite.
3. ADR-028 ratification (the 5A PR review) + ranking-weight/TTL/threshold
   ratification (config seams ship [PROPOSED] defaults).
4. Storage provider + spend approval; wire the media workers (FFmpeg/libvips
   per the job contracts) and the M8 queues onto the 1C foundation.
5. Wire instrumentation; enable sinks. Search provider config if used.
6. Add the module imports to `AppModule` in a reviewed activation PR; privacy
   re-review; staged rollout + executed rollback drill.

## 6. Non-goals

No AI (M7), no payments/ads/sponsored ranking, no engagement optimization, no
production storage credentials, no camera unfreeze, no activation.
