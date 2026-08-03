# 16 — Operations Runbook (Dark Foundation)

> **Status:** the discovery platform is a DARK foundation — `DiscoveryModule`
> is not imported by `AppModule`, web-next is not deployed, Typesense and any
> realtime broker are unwired, and no provider credentials exist. These
> runbooks are written NOW so activation day starts from procedures, not
> improvisation. Sections marked **[post-activation]** apply only once the
> owner activates the corresponding surface; the *dark rollback* and *privacy
> incident* sections apply from the first merged PR onward.

All instrumentation referenced here is checkpoint 14's
(`backend/src/discovery/discovery.observability.ts`): metrics gate on
`METRICS_ENABLED=true`, structured logs on `LOG_FORMAT=json`, and every log
line carries an opaque `correlationId` (never a user id). Metric names below
are members of the closed `DISCOVERY_METRICS` registry.

---

## 16.1 Typesense unavailable **[post-activation]**

**Detection.**
- `discovery_search_provider_duration_seconds{provider="typesense",outcome="timeout"|"error"}` rising.
- `discovery_search_breaker_transitions_total{provider="typesense",to_state="open"}` incrementing — the adapter's circuit breaker (threshold 3 failures, 30 s cool-down, half-open probe) has opened.
- Logs: `component=discovery` lines with `outcome=provider-unavailable`.

**Expected behaviour (by design — verify, don't fight it).** Search returns
the typed `provider-unavailable` state; the UI shows the honest degraded
banner (P4 — never fabricated results, never silent emptiness). People-nearby
and places continue working: PostGIS and the place ports do not depend on
Typesense.

**Actions.**
1. Confirm blast radius is search-only: people/places query metrics (`discovery_query_duration_seconds`) should be unaffected.
2. Check the Typesense process/host (it is a separate service; the backend holds no SDK — plain HTTP).
3. If Typesense returns, the breaker half-opens and recovers on the first successful probe — no restart needed.
4. If the outage is prolonged: nothing to disable — the adapter already degrades typed. Do NOT point `TYPESENSE_URL` at an unvetted replacement instance; the index would need re-verification (index-content policy, C-INDEX-MIN).
5. Rebuild after data loss: the index is a DERIVED projection — re-index from `DiscoveryPublicProfileProjection` (discoverable rows only) through the adapter's allow-list `indexDoc`. Nothing is lost with the index.

## 16.2 PostGIS degradation **[post-activation]**

**Detection.**
- `discovery_query_duration_seconds{scope="people"}` p95 climbing across radius buckets, or `outcome="error"` appearing.
- Postgres-side: `pg_stat_statements` for the discovery CTE; GIST index bloat; `SELECT count(*) FROM "DiscoveryVisibility" WHERE "expiresAt" > now()` growth.

**Actions.**
1. Verify the GIST index is used: `EXPLAIN (ANALYZE, BUFFERS)` on the repository query (14-PRIVACY-ABUSE-THREAT-MODEL §enforcement points documents the canonical SQL; 15-PERFORMANCE-AND-CAPACITY records the measured baseline to compare against).
2. Check `ANALYZE` freshness on `DiscoveryVisibility` — the planner needs current stats after presence churn.
3. Expired-row accumulation is the most likely cause — see §16.3.
4. Wide-radius (25 km) queries are the measured bottleneck (ch. 15): if p95 breaches its recorded baseline at scale, the recorded scaling triggers apply (KNN `<->` rewrite / cell pre-filter) — an engineering change, not an ops toggle.
5. Under sustained overload, discovery is LOAD-SHEDDABLE by design: it is additive product surface; messaging and crypto do not depend on it. The immediate valve is §16.6 rollback of the discovery surface, never a shared-database failover improvisation.

## 16.3 Stale presence accumulation

**What accumulates.** `DiscoveryVisibility` rows whose `expiresAt` has
passed. They are ALREADY invisible to every query (the predicate excludes
them — threat model C-EXPIRE); the cost is table/index growth and planner
drift, not privacy.

**Detection.** `SELECT count(*) FROM "DiscoveryVisibility" WHERE "expiresAt" <= now()` trending up; `discovery_expired_presence_swept_total` flat while the count grows (sweeper not running).

**Actions.**
1. Sweep: `DELETE FROM "DiscoveryVisibility" WHERE "expiresAt" <= now() - interval '1 day'` (the 1-day grace keeps a re-enable cheap: the row's `visibilityVersion` continuity is preserved for rows deleted later by their owner). Batch with `LIMIT` on large backlogs.
2. Record the sweep through `countExpiredSwept({outcome:'ok'}, n)` when instrumented.
3. `ANALYZE "DiscoveryVisibility"` after large sweeps.
4. Retention posture (migration header, ADR-018): presence is EPHEMERAL — no history table exists, and none may be created as a "fix" for anything in this runbook.

## 16.4 Realtime unavailable **[post-activation]**

**Detection.** `discovery_realtime_publish_total{outcome="error"}` rising, or client-side staleness reports while HTTP queries succeed.

**Expected behaviour.** The realtime plane is an OPTIMIZATION. The contract
(`realtime.port.ts`) is fail-open-to-polling: the Disabled adapter validates
and drops, and the UI state machine works entirely from request/response.
Presence freshness degrades to the query interval; nothing breaks.

**Actions.**
1. Confirm publishes are failing (adapter outcome) vs. never attempted (module dark — `outcome` absent entirely).
2. Broker restart/recovery: events carry `visibilityVersion`, and consumers drop stale versions (C-REPLAY), so replays after recovery are safe.
3. Do not buffer/queue events during an outage — presence events expire faster than any backlog drains; drop is correct.
4. Publish-time guard failures (`assertPublishable` throwing) are a CODE bug, not an ops event: treat as §16.5 (an event nearly carried forbidden content).

## 16.5 Privacy incident response

Applies from today (dark) onward. A privacy incident here means: precise
coordinates, identity-linked presence, or private profile data appearing
anywhere it must not — logs, metrics labels, realtime payloads, API
responses, or the search index.

1. **Contain.** Stop the leaking surface first: for a live surface use §16.6 (dark rollback); for logs/metrics, disable the sink (`LOG_FORMAT` unset, `METRICS_ENABLED` unset) — both are env-gated no-ops by design.
2. **Preserve evidence.** Capture the offending lines/payloads and their `correlationId`s (opaque — safe to share in an incident doc) plus timestamps. Do NOT paste leaked values into tickets; reference them.
3. **Scope.** Determine which principals' data leaked and over what window. For coordinates note the resolution: the system should only ever hold COARSE values (ADR-018/019) — a PRECISE value anywhere server-side means the client boundary failed and the web-next mutation-test battery (checkpoint 11) missed a surface; that is a sev-1.
4. **Eradicate.** Fix the code path AND add the leaked shape to the relevant fence (json-logger redaction spec, `assertDiscoveryLabels`, `assertPublishable`, the C12 fence spec, or the mutation battery) so the class of leak becomes a failing test forever.
5. **Purge.** Expire/rotate the affected sink (log retention delete, metrics scrape retention, index rebuild from projections).
6. **Report.** Owner notification with scope, window, and the fence added. Handbook `DECISIONS.md` gets an entry if any policy changed.

## 16.6 Immediate dark rollback

The discovery platform is built for one-commit reversibility at every layer.
Order matters — outermost surface first:

| Step | Surface | Action | Effect |
|---|---|---|---|
| 1 | Client | Un-deploy / feature-flag off the web-next discovery shell (it is currently NOT deployed — this step exists only post-activation) | No user can issue discovery traffic |
| 2 | Backend | Remove `DiscoveryModule` from `AppModule` imports (today it is ALREADY absent — activation is a one-line import; rollback is deleting that line) | All discovery routes 404; no discovery SQL runs |
| 3 | Realtime | Swap the bound adapter back to `DisabledRealtimeAdapter` | Publishes validate-and-drop |
| 4 | Search | Unset `TYPESENSE_URL`/`TYPESENSE_API_KEY` | Adapter reports `unconfigured`; no outbound calls |
| 5 | Data (optional, only if warranted) | `UPDATE "DiscoveryVisibility" SET "enabled" = false` or delete rows; drop the projections ONLY with owner sign-off — they are derived and rebuildable, but deletion is still a data operation | Even a re-activated backend serves nothing |

Verification after rollback: the C12 fence spec
(`backend/test/discovery-dark-fences.spec.ts`) passing IS the definition of
"dark restored" — run it, plus a smoke check that messaging/crypto suites
still pass (discovery shares no runtime dependency with them; a rollback
must not have touched anything outside the table above).

What rollback does NOT touch: migrations stay applied (additive tables are
inert when unqueried — rollback-of-schema is its own reviewed operation per
the migration header), contracts stay published (types are inert), and the
handbook records the rollback with its reason.
