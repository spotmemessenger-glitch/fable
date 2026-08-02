# 02a — Translation Provider Abstraction: build notes, rollback, benchmark

**Companion to** the design `priority-2/02-translation-platform.md` and the ADR
addendum `adr/010a-translation-provider-abstraction-addendum.md`.
**Scope of this PR:** additive, flag-gated (`TRANSLATION_V2_ENABLED`, default
**false**), NOT wired into the live translate path. The shipped engine
(`web/api/translate.js`) is untouched (byte-identical to `origin/master`).

---

## 1. What shipped (this branch)

A new, self-contained module under `web/src/lib/translation/`:

| File | Responsibility (design §) |
|---|---|
| `flag.js` | The single switch `TRANSLATION_V2_ENABLED`, default OFF |
| `types.js` | Frozen vocabulary (capabilities, classes, profiles, states) + JSDoc typedefs (§3.1) |
| `capabilities.js` | Provider capability **matrix as data** + `pairFitness()` (§4) |
| `ITranslationProvider.js` | The **typed contract**, checkable; forbidden-secret surface (§3.3) |
| `circuit-breaker.js` | `closed→open→half-open`, injected clock (§5.4, §10.2) |
| `scoring.js` | `score(p,r)` + weight-preset profiles + terms (§5.1–5.2) |
| `confidence.js` | Confidence taxonomy + quality **EWMA** feedback loop (§6.1–6.2) |
| `detect.js` | Language/script **detection pipeline shim**; reuses engine `scriptOk` (§7) |
| `registry.js` | Provider **registry** + capability-matrix view (§3) |
| `router.js` | **Routing engine**: hard gates + scoring + breaker + `RoutingDecision` (§5) |
| `adapters/engine-port.js` | Delegation seam to the engine; inert by default; reuses `scriptOk` |
| `adapters/providers.js` | Thin **adapters** (registrations, not rewrites) |
| `adapters/index.js` | Registers the incumbent providers |
| `index.js` | `buildTranslationPlatform()` — assembles, gated |

Tests (pure logic, no network) — 113 assertions, all green:
`test/translation-provider-contract.test.js` (25),
`test/translation-routing.test.js` (21),
`test/translation-circuit-breaker.test.js` (13),
`test/translation-confidence-detect.test.js` (22),
`test/translation-v2-not-shipped.test.js` (32, the fence).
Bench: `test/bench/translation-routing.bench.mjs`.

**Providers registered as adapters:** google, azure, sarvam, gemini, openai,
anthropic, google-inputtools, elevenlabs, device, gtx, mymemory — every one a
thin registration that delegates to the engine; none holds a key.

## 2. What was deferred (and why)

- **Server-side execution wiring.** The port is inert by default; adapters throw
  "not wired". Connecting the real engine delegate is a deliberate future step
  behind the flag (design §17.5).
- **Persistence** — the DB tables (design §13: `TranslationQualityScore`,
  `TranslationRoutingEvent`, `TranslationUsageCounter`,
  `TranslationProviderHealth`, and the owner-gated `TranslationCache`). The
  quality store and breaker state are in-memory skeletons behind the same shapes.
- **Tier-1 server cache** — blocked on owner decision C1 (§18). Not built.
- **Observability surface / `/metrics`, budgets enforcement** — design §14, owner
  decisions C3/C6. Counters are shaped, not persisted.
- **Batch/admin HTTP contracts** (design §8.2/§8.4) — the platform supports them
  structurally (router + registry matrix view) but no new endpoint is added.
- **PII redaction hook** (§12.4) — design hook only, not implemented.

None of the above is required for an additive, gated-OFF landing.

## 3. Rollback notes

**Operationally there is nothing to roll back:** the module is imported by no app
file and the flag is OFF, so the live translate path is exactly today's engine.
Enforced, not asserted, by `test/translation-v2-not-shipped.test.js`.

To **remove the code entirely** (single, clean revert surface):

1. `rm -rf web/src/lib/translation/`
2. `rm web/test/translation-provider-contract.test.js web/test/translation-routing.test.js web/test/translation-circuit-breaker.test.js web/test/translation-confidence-detect.test.js web/test/translation-v2-not-shipped.test.js`
3. `rm web/test/bench/translation-routing.bench.mjs`
4. In `web/package.json`, remove the five appended `&& node test/translation-*.test.js` entries from the `test` script (the only edit to an existing file).
5. `rm docs/adr/010a-*.md docs/priority-2/02a-*.md`

No existing file is otherwise modified; no migration to reverse; no key, flag or
crypto state to unwind. Mixed-version deploys are safe (the engine is unchanged).

**To activate later (NOT part of this PR):** supply a real engine delegate to the
port, add an app integration guarded by `isTranslationV2Enabled()`, set a
`policyVersion`, and follow the design §17.5 rollout (shadow → canary → widen).
Rollback of an *active* platform is a `policyVersion` revert (data, no deploy);
the legacy chain remains underneath.

## 4. Benchmark note

Roadmap V2 §8 requires environment, raw results, median and tail. The router is
pure, so these isolate the **cost of choosing** a provider — the overhead the
live path would pay on top of the existing engine — from the vendor legs
themselves (which the engine already documents: service p90 3.8 s, `?op=read`
p50 3.2 s / p90 6.6 s, detect 259–271 ms).

Environment: Node v22.22.2, Intel Xeon @ 2.10 GHz ×4, 16.9 GB, in-process, 50 000
iterations after a 5 000-iteration warmup. Reproduce:
`node web/test/bench/translation-routing.bench.mjs`.

| Path | p50 | p90 | p95 | p99 | mean |
|---|---|---|---|---|---|
| `route()` over the full 11-provider registry | 6.17 µs | 7.38 µs | 10.66 µs | 29.13 µs | 7.18 µs |
| `score()` a single provider | 0.44 µs | 0.83 µs | 0.85 µs | 1.14 µs | 0.60 µs |
| `route()` with breakers + quality store (enabled shape) | 6.33 µs | 11.79 µs | 13.10 µs | 26.68 µs | 7.88 µs |

**Reading:** a full routing decision is **sub-10 µs at p90** and sub-30 µs at
p99 — roughly one part in ~10⁵ of a single cloud vendor leg. The cost of routing
is negligible beside what it routes between; the latency budget is entirely the
vendors', which is exactly why latency-aware routing (choosing the faster vendor)
is where the wall-clock is won, not the router itself. These are in-process
Node numbers; a serverless cold start and the real vendor legs dominate any
end-to-end measurement and must be measured separately on the deploy target
before the platform is enabled.
