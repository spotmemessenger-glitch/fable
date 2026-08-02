# ADR-010b — Translation Platform Completion (addendum to ADR-010 / ADR-010a)

**Status:** Accepted for an **additive, layered-flag-gated (all flags default
false), NOT-wired-in** build. Extends the abstraction landed in ADR-010a to the
full Priority ② platform: routing, quality/verification, circuit/retry/failover,
cost governance, privacy/redaction, caching, context, observability, and the
integration seam.
**Addendum to:** `adr/010-translation-platform.md` (controlling decision) and
`adr/010a-translation-provider-abstraction-addendum.md` (the abstraction).
**Grounding:** the shipped engine `web/api/translate.js` (902 lines),
`web/src/lib/translate.js` and `web/src/lib/english.js` are **byte-identical to
`origin/master`** (verified `git diff --quiet`). The whole platform is a module
under `web/src/lib/translation/`, exercised by the suite and unreachable from the
app (`test/translation-v2-not-shipped.test.js`).

---

## Context

ADR-010a landed the *structure* (interface, matrix, router, breaker, confidence,
detect, adapters), gated OFF. This addendum completes the platform to production
standard while keeping the same two guarantees: **the legacy engine is the
untouched code path underneath**, and **nothing runs until a flag is deliberately
turned on**. The completion is expressed as new modules beside the existing ones,
and as a layered flag scheme so the platform can be turned up one capability at a
time (routing → verification → adjudication → cache → cost).

## Decisions (realised in this branch)

1. **Layered flags** (`flag.js`). One master, `TRANSLATION_PLATFORM_V2_ENABLED`
   (backward-compatible with the original `TRANSLATION_V2_ENABLED`), and five
   sub-flags — `TRANSLATION_DYNAMIC_ROUTING_ENABLED`,
   `TRANSLATION_CROSS_VERIFY_ENABLED`, `TRANSLATION_ADJUDICATION_ENABLED`,
   `TRANSLATION_CACHE_ENABLED`, `TRANSLATION_COST_GOVERNANCE_ENABLED`. Every flag
   defaults **false**, and each sub-flag is **layered**: it reads true only when
   the master is also on, so one stray env var can never light up an expensive or
   privacy-sensitive path. Strict semantics (exact `true`/`'true'`) are inherited
   from ADR-010a.

2. **Capability registry, extended** (`capabilities.js`, `registry.js`). Each
   provider row gains cost model, data-retention posture, regional availability,
   romanized-input support, batch support, and a max input size. The registry
   answers "which provider can do task X" (`providersFor`, `capableOf`, `canDo`),
   testable with no live credentials.

3. **Retry / failover** (`retry.js`). Transient/permanent error classification,
   bounded exponential-backoff retry (default 1 attempt = the engine's behaviour),
   and regional failover that stops on a permanent failure. Injected clock/sleep,
   so deterministic. Exposed to the router as an **optional** `attempt` hook whose
   default is identity — existing routing is unchanged.

4. **Quality / verification** (`verify.js`). Cross-provider consensus (agreement
   on meaning-bearing characters), gated LLM adjudication, and an explicit
   `uncertain: true` result when nothing meets the threshold. **Confidence is
   DERIVED from the verification outcome, never fabricated** per provider.

5. **Cost governance** (`cost.js`). Per-request estimate from the provider's
   price signal and cost model, per-account daily/monthly counters, hard ceilings
   and soft warnings, and a fan-out budget that **refuses any fan-out without a
   recorded reason**. Cache-first advice and a cache-savings counter.

6. **Privacy / redaction** (`privacy.js`). Privacy MODES (`standard` /
   `sensitive` / `strict`) mapped to admissible provider postures; a router-shaped
   privacy gate derived from the mode; deterministic PII classification and a
   reversible redaction hook; a whitelist-based safe-telemetry stripper; and the
   honest, surfaced statement that **cloud translation is NOT E2E once plaintext
   leaves the device.**

7. **Caching** (`cache.js`). A canonical key over lang pair + engine version +
   privacy mode + context fingerprint, TTL expiry, safe-negative caching only,
   bounded LRU, and version invalidation. The load-bearing invariant — **a cache
   must not leak one user's private context into another's result** — is enforced
   by the key and proved in `test/translation-cache.test.js`.

8. **Context** (`context.js`). A window bounded in BOTH turns and characters,
   speaker labels, glossary hits, previous-turn language, per-conversation prefs,
   newest-first truncation, privacy-aware mode selection, and the fingerprint the
   cache key consumes.

9. **Observability** (`metrics.js`). Aggregate counters, latency/confidence
   percentiles, and a readiness view exposing flags, capability and circuit state
   — **no secret, no content, by construction.**

10. **Integration seam** (`pipeline.js`, `integration.js`). The enabled pipeline
    (cache → context → route → execute → verify → cost → metrics) and the entry
    adapter. **With the master flag OFF the entry is a pure passthrough to the
    legacy engine** — same result object, no platform side effect — so "flag-OFF
    is byte-identical to today" is a property of the code, proved by
    `test/translation-integration.test.js`. Streaming/live-voice is a declared
    interface **stub** (ADR-011, deferred); there is no live-call implementation.

## Non-goals / unchanged (restated)

- **No change to the shipped engine.** The three engine files are byte-identical.
- **No feature flag is enabled.** All six default false; a disabled platform
  refuses to `execute()` / `run()`. Pure `decide()` (shadow routing) is allowed.
- **No Priority 1 / crypto interaction.** ADR-008 §12 hard stop is unaffected.
- **No server-side plaintext persistence, no DB table, no SDK dependency.** The
  cache/counters/quality store are in-memory skeletons behind the durable shapes
  (design §13), deferred to owner decisions.
- **No live credentials in CI.** Every test uses deterministic fakes.

## Consequences

- The completed platform is reviewable, benchmarked and fully exercised while the
  live path remains exactly today's engine. Activation is a deliberate, layered
  rollout (see `priority-2/02e-translation-rollout-runbook.md`).
- Local orchestration overhead is a few microseconds per request (see
  `priority-2/02f-translation-benchmark-report.md`), negligible beside any vendor
  leg it routes between.

## Rollback / activation

Operationally nothing to roll back: no app file imports the platform and every
flag is OFF. To **remove**, delete `web/src/lib/translation/`, the
`test/translation-*.test.js` files, the benches, and the appended `package.json`
test entries. To **activate** (a separate, deliberate change), follow the runbook:
supply a real engine delegate, adopt the integration entry behind the master
flag, then enable sub-flags one at a time (shadow → canary → widen).
