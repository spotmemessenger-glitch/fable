# ADR-010a — Translation Provider Abstraction (addendum to ADR-010)

**Status:** Accepted for an **additive, flag-gated (`TRANSLATION_V2_ENABLED`,
default false), NOT-wired-in** build (Priority ② — translation platform, owner
execution order 2026-08-01).
**Addendum to:** `spotme/docs/adr/010-translation-platform.md`. This file does
**not** rewrite ADR-010 in place; it records the concrete abstraction decisions
realised in code, which ADR-010 §7 lists as "what does NOT exist" and the design
doc `priority-2/02-translation-platform.md` §16 proposes. ADR-010 remains the
controlling decision; where this addendum is more specific, it is the
implementation of ADR-010, not a replacement.
**Grounding:** the shipped engine `web/api/translate.js` (902 lines) is
untouched by this work — verified byte-identical to `origin/master`. The whole
platform is a new module under `web/src/lib/translation/`, exercised by the
suite and unreachable from the app (`test/translation-v2-not-shipped.test.js`).

---

## Context

ADR-010 formalises the multi-provider engine that grew organically and names
five things that do not yet exist: a declared provider interface, routing as
data, confidence scoring, quality as a feedback loop, and cost-aware routing +
observability. The design doc turns those into an implementation-ready spec.
This addendum is the build decision: land the **structure** of that spec —
interface, matrix, router, breaker, confidence, detection, adapters — additively
and OFF, so it can be reviewed, benchmarked and exercised before a single
request routes through it, and with the legacy engine as the untouched code path
underneath (ADR-010 §Rollback).

## Decisions (realised in this branch)

1. **Typed provider interface as a checkable contract**
   (`ITranslationProvider.js`). `translate / detectLanguage / detectScript /
   transliterate / comprehend / adjudicate` are optional operations; `capabilities /
   health / priceSignal` are required. Modelled on the shipped
   `transport/ITransportAdapter.js`: a required-method list, a **forbidden
   surface** (no `apiKey / secret / token / endpoint / fetch` — adapters carry no
   vendor secret), and an assertion that runs in tests. Every declared *text*
   capability must have its method; voice capabilities (stt/tts/clone) are
   declaration-only for the ③ substrate (ADR-011).

2. **Capability matrix as data** (`capabilities.js`). The design §4 table,
   verbatim in spirit, one frozen row per provider. `languagePairs` is stored as
   a declarative descriptor and computed by `pairFitness()` (0..1), so the source
   of truth is data, not a function literal. Fitness 0 is a hard gate — Sarvam
   scores 1.0 into Indic, **0 into French** (target-gated, since it can only
   translate into languages it speaks); on-device scores 0 without a known source
   (the engine's own rule).

3. **Routing as data** (`router.js`, `scoring.js`). `score(p,r) = w_fit·fit +
   w_qual·quality + w_lat·latency + w_cost·cost + w_priv·privacy`, every term in
   [0,1], every weight preset summing to 1.0. Three profiles —
   **accuracy / latency / cost** — are the policy knobs. Hard gates, in the
   design's order: `G_supports, G_pair, G_circuit, G_allow, G_privacy`. `route()`
   is a **pure decision** returning the documented `RoutingDecision` (chosen,
   fallback chain, per-candidate gated-out reason, `policyVersion`); `execute()`
   walks it, driving the breakers and applying the reused `scriptOk` gate.

4. **Circuit breaker** (`circuit-breaker.js`). `closed → open → half-open` with
   the design's defaults (5 failures / 60 s window / 30 s cooldown / 1 probe),
   driven by an **injected clock** so every transition is deterministic in tests.
   Timeouts and wrong-script disqualifications count as failures (policy applied
   by the router). This is genuinely new — today a dead provider is retried every
   request.

5. **Confidence + quality feedback loop** (`confidence.js`). The design's five
   confidence bands (`confirmed 0.90+ … degraded <0.30`) with `classifyConfidence`
   /`confidenceFor`; and the rolling EWMA (`α 0.1`, seed 0.6) that turns the
   adjudicator verdicts and wrong-script disqualifications the engine computes and
   throws away into the router's `quality` term. Skeleton, no persistence yet —
   the durable `TranslationQualityScore` table (design §13) is deferred.

6. **Language/script detection pipeline shim** (`detect.js`). The design §7
   ordered steps: English guard first (reused `english.js`), local script
   detection, the non-Latin shortcut, then a provider-detect step that is
   **injected** so the module stays pure/offline. The wrong-script gate is the
   engine's own `scriptOk`, **imported and reused, not copied**, so the two
   guards can never drift.

7. **Adapters are registrations, not rewrites** (`adapters/`). Each provider is a
   thin object that declares its matrix row and **delegates** its operations to a
   single engine port. The port reuses `scriptOk` from `api/translate.js` and is
   **inert by default** (throws "not wired") — the honest state while OFF. A
   dormant `createHandlerDelegate()` wraps the engine's `handler` for the eventual
   enabled path; it is not the default and is never invoked by the suite. No
   adapter holds a key, a hostname, or a vendor fetch (enforced by the contract
   and the fence test).

## Non-goals / unchanged (restated for the reviewer)

- **No change to the shipped engine.** `api/translate.js`, `src/lib/translate.js`
  and `english.js` are byte-identical to `origin/master`.
- **No feature flag is enabled.** `TRANSLATION_V2_ENABLED` defaults false; a
  disabled platform refuses to `execute()`. Pure `decide()` (shadow routing) is
  allowed while OFF because it has no side effects.
- **No Priority 1 / crypto interaction.** No signing key, prekey, ratchet or
  multi-device code is touched; **ADR-008 §12 hard stop is unaffected.**
- **No server-side plaintext cache, no new DB table, no SDK dependency.** Tier-1
  cache (design §11/§18-C1) and the schema (§13) are deferred to owner decisions.

## Consequences

- The engine's hardcoded order becomes expressible as a scored table with the
  legacy chain intact underneath; migration is reversible by `policyVersion`
  (ADR-010 §Rollback, design §17.5).
- A routing decision costs ~6 µs p50 / ~13 µs p95 over the full 11-provider
  registry (see the benchmark note) — negligible beside any vendor leg.
- The provider/latency abstraction is the substrate ADR-011 (live voice) reuses
  for its text leg (design §G6), so live voice does not fork provider selection.

## Rollback / activation

Nothing to roll back operationally: the module is not imported by the app and the
flag is OFF, so the live path is exactly today's engine. To **remove**, delete
`web/src/lib/translation/`, the five `test/translation-*.test.js` files, the
bench, and the appended entries in `web/package.json`'s test script. To
**activate later** (a separate, deliberate change): supply a real engine delegate
to the port, add an app integration behind `isTranslationV2Enabled()`, set a
`policyVersion`, and follow the design §17.5 rollout (shadow → canary → widen).
