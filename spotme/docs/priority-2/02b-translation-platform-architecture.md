# 02b — Translation Platform: architecture, capability matrix, routing table

**Companion to** ADR-010b and the design `priority-2/02-translation-platform.md`
(where present). Scope: additive, layered-flag-gated (all default **false**), NOT
wired into the live path. The shipped engine is byte-identical to `origin/master`.

---

## 1. Module map (`web/src/lib/translation/`)

| File | Responsibility |
|---|---|
| `flag.js` | Master + five layered sub-flags; strict, default-off |
| `types.js` | Frozen vocabulary + JSDoc typedefs |
| `capabilities.js` | Capability matrix + economics (cost/retention/regions/…) |
| `ITranslationProvider.js` | The checkable provider contract; forbidden-secret surface |
| `registry.js` | Registry + `providersFor`/`capableOf`/`canDo` + matrix view |
| `scoring.js` | `score(p,r)` weighted sum + profile presets |
| `router.js` | Hard gates + scoring + `route()`/`execute()`; optional retry hook |
| `retry.js` | Transient/permanent classification, bounded retry, regional failover |
| `circuit-breaker.js` | `closed→open→half-open`, injected clock |
| `confidence.js` | Confidence bands + quality EWMA store |
| `verify.js` | Consensus, gated adjudication, derived confidence, uncertainty |
| `detect.js` | Ordered detection pipeline; reuses engine `scriptOk` |
| `context.js` | Bounded window, glossary, prefs, truncation, fingerprint |
| `privacy.js` | Modes→postures, PII classify/redact, safe telemetry |
| `cost.js` | Estimate, per-account counters, ceilings, fan-out budget |
| `cache.js` | Canonical key, TTL, safe negatives, LRU, version invalidation |
| `metrics.js` | Aggregate counters, percentiles, readiness |
| `pipeline.js` | The enabled execution path, composed |
| `adapters/*` | Thin registrations delegating to the engine port (inert by default) |
| `index.js` | `buildTranslationPlatform()` — assembles it all, gated |
| `integration.js` | Entry adapter; flag-OFF passthrough; streaming stub |

## 2. Request flow (enabled path, `pipeline.js`)

```
request
  │
  ├─ 1. CONTEXT     buildContext(window) → privacyMode, contextFingerprint
  ├─ 2. CACHE       keyFor(pair+version+privacyMode+fingerprint) → hit? return
  ├─ 3. ROUTE       router.route() — pure decision (hard gates + scoring)
  ├─ 4. COST GATE   estimate chosen → check ceiling → refuse if over
  ├─ 5. EXECUTE     router.execute() — primary + fallback chain + scriptOk + breakers
  ├─ 6. VERIFY      (cross-verify) second opinion → consensus → (adjudication)
  └─ 7. RECORD      quality EWMA, cache (if certain), metrics; attach privacy notice
```

Each numbered stage is gated by a flag; with a stage's flag OFF the request skips
it. `decide()` runs stage 3 only (shadow routing, no side effects, safe while the
master is OFF). Nothing calls a vendor by itself — the registered providers do,
and they are inert until wired.

## 3. Provider capability matrix (`capabilities.js`, verbatim)

| id | capabilities | quality | latency | cost | privacy | retention | romanized | batch | maxInput | cost model |
|---|---|---|---|---|---|---|---|---|---|---|
| device | translate | general | realtime | free | on-device | none | no | no | 5000 | none |
| google | translate, detect | high | fast | metered | cloud-contract | contract | yes | yes | 5000 | 0.02 µ$/char |
| azure | translate, detect, transliterate | high | fast | metered | cloud-contract | contract-no-trace | yes | yes | 10000 | 0.01 µ$/char |
| sarvam | translate, detect, transliterate | reference | medium | metered | cloud-contract | contract | yes | no | 1000 | 0.03 µ$/char |
| gemini | translate, detect, comprehend, adjudicate | high | medium | metered | cloud-contract | contract | yes | no | 8000 | 0.30 µ$/token |
| openai | comprehend, adjudicate | high | slow | premium | cloud-contract | contract | yes | no | 8000 | 2.50 µ$/token |
| anthropic | comprehend, adjudicate | high | slow | premium | cloud-contract | contract | yes | no | 8000 | 3.00 µ$/token |
| google-inputtools | transliterate | high | fast | free | cloud-keyless | unknown-no-contract | yes | no | 200 | 0 |
| elevenlabs | stt, tts, clone¹ | general | medium | metered | cloud-contract | contract | no | no | 5000 | 100 µ$/call |
| gtx | translate, detect | general | fast | free | cloud-keyless | unknown-no-contract | yes | no | 480 | 0 |
| mymemory | translate | fallback | medium | free | cloud-keyless | unknown-no-contract | no | no | 480 | 0 |

¹ Voice capabilities are **declaration-only** for the ③ live-voice substrate
(ADR-011); the text platform does not execute them. Costs are order-of-magnitude
governance estimates, not billing.

## 4. Routing decision table

Hard gates, applied in order (`router.js`). Any failure excludes a provider —
it cannot be scored back in. Every exclusion carries a machine-readable reason.

| Gate | Rule | Reason string |
|---|---|---|
| G_supports | declares + implements the required capability | `capability: no <cap>` |
| G_pair | `languagePairs(src,tgt) > 0` | `pair: unsupported` |
| G_override | not denied by a pair override | `override: denied for pair` |
| G_circuit | breaker not OPEN | `circuit: open` |
| G_allow | in the tenant's allow-list | `allow: not in tenant list` |
| G_privacy | posture admitted by tenant + privacy mode | `privacy: <posture>` |

Survivors are scored `w_fit·fit + w_qual·quality + w_lat·latency + w_cost·cost +
w_priv·privacy` and sorted descending; the argmax is `chosen`, the rest are the
fallback chain. Weight presets:

| profile | fit | quality | latency | cost | privacy |
|---|---|---|---|---|---|
| accuracy | 0.25 | 0.40 | 0.10 | 0.10 | 0.15 |
| latency | 0.20 | 0.20 | 0.40 | 0.05 | 0.15 |
| cost | 0.20 | 0.25 | 0.05 | 0.35 | 0.15 |

With `TRANSLATION_DYNAMIC_ROUTING_ENABLED` OFF the pipeline pins the `accuracy`
profile and ignores the quality feedback term (a static, predictable order); ON,
it honours the request's `routingProfile` and the rolling quality EWMA.

## 5. Confidence ladder (`verify.js`)

| outcome | how reached | derived confidence | band |
|---|---|---|---|
| agree | two engines agree on meaning-bearing chars | 0.95 | confirmed |
| adjudicated | they differ, a judge (read both + original) picked | 0.78 | adjudicated |
| single | one engine survived the wrong-script gate | 0.60 | single |
| uncertain | nothing met threshold / unresolved disagreement | ≤0.40 | fallback/degraded |

Confidence is derived from the outcome (a measured fact), never fabricated per
provider. An `uncertain: true` result still carries best-effort text, clearly
flagged, and the cache refuses to store it.

## 6. Flag inventory

| Flag (env) | Global override | Default | Gates |
|---|---|---|---|
| `TRANSLATION_PLATFORM_V2_ENABLED`¹ | `__SPOTME_TRANSLATION_PLATFORM_V2__` | false | the whole enabled path |
| `TRANSLATION_DYNAMIC_ROUTING_ENABLED` | `__SPOTME_TRANSLATION_DYNAMIC_ROUTING__` | false | scored vs static routing |
| `TRANSLATION_CROSS_VERIFY_ENABLED` | `__SPOTME_TRANSLATION_CROSS_VERIFY__` | false | second-opinion consensus |
| `TRANSLATION_ADJUDICATION_ENABLED` | `__SPOTME_TRANSLATION_ADJUDICATION__` | false | LLM judge fan-out |
| `TRANSLATION_CACHE_ENABLED` | `__SPOTME_TRANSLATION_CACHE__` | false | cache read/write |
| `TRANSLATION_COST_GOVERNANCE_ENABLED` | `__SPOTME_TRANSLATION_COST_GOVERNANCE__` | false | ceilings + fan-out budget |

¹ The legacy `TRANSLATION_V2_ENABLED` / `__SPOTME_TRANSLATION_V2__` also enable
the master, for backward compatibility with ADR-010a. Sub-flags are **layered**:
each is effective only when the master is on.
