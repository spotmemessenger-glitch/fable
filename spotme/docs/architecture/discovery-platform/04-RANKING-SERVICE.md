# 04 — Ranking Service

> Part of the [Discovery Platform Architecture Specification](README.md).
> Engineering spec — draft for owner review (stacked PR; documentation only,
> nothing here activates code). Numeric values are [PROPOSED] config defaults.

## 4.1 One engine, many profiles

The Ranking Service is the platform's single ordering discipline: **one
transparent, deterministic scoring engine**, consumed by every surface through
a per-surface **weight profile**. A surface never writes its own ranking; it
declares which registered signals it uses and what weights it proposes, and
the engine does the rest — scoring, breakdown, tie-break, and invariant
enforcement, identically everywhere.

This pattern already exists twice, dark, and the implementations are nearly
line-for-line the same machine:

- `[REUSE]` `spotme/web/src/lib/discovery-v2/ranking.js` (draft PR #60) —
  places profile.
- `[REUSE]` `spotme/web/src/lib/live-events/ranking.js` (draft PR #61) —
  events profile.

Neither is on `master`; both are dark (flag-off, fenced) on unmerged draft
PRs. The third profile (Exchange) is **specified but has no code** — its
signals and weights come from the
[Exchange PRD §4](../../handbook/product/exchange/04-MATCHING-AND-RANKING.md).
`[PROPOSED]`: the two dark modules converge into one shared engine
(`packages/domain` in the target monorepo,
[13-IMPLEMENTATION-MAP](13-IMPLEMENTATION-MAP.md)) parameterised by profile.

## 4.2 The scoring model

A score is an explicit weighted sum of named signals, each normalised to
[0,1]. There is no model, no learned component, and nothing opaque:

```
inputs (result + query + injected now)          weight profile (runtime config)
        │                                                │
        ▼                                                ▼
  signal functions  s_k ∈ [0,1]  ──►  score = Σ  w_k · s_k
        │                                                │
        ▼                                                ▼
  scoreBreakdown {signal, weight, weighted} per k   sort desc, tie-break by id
```

Signal functions are pure and honest: an unknown input contributes a **neutral
zero** (a null rating, an unsupplied popularity), never a guess — the engine
must not invent what a source did not supply (constitution;
[01-PLATFORM-OVERVIEW §1.4](01-PLATFORM-OVERVIEW.md)). Ranking reads **only
the result and the query** — never a person's attributes, and never any
sensitive trait ([roadmap v2.0 §22](../../handbook/product/SPOT-ME-PRODUCT-ROADMAP-V2.md)).

## 4.3 Signal registry

Every signal a profile may reference is registered once, with its domain,
source, and **class**. The class drives invariant validation (§4.7): the
validator does not know "distance" by name, it knows *proximity-class*.

| Signal | Class | ∈ [0,1] meaning | Source | Status |
|---|---|---|---|---|
| `proximity` / `distance` | proximity | 1 at origin, linear decay to 0 at falloff | device-local `distanceM` ([02-LOCATION-PRIVACY-ENGINE](02-LOCATION-PRIVACY-ENGINE.md)) | `[REUSE]` both dark engines |
| `rating` | quality | provider rating / 5; null → 0 | provider port ([05-PROVIDER-ABSTRACTION](05-PROVIDER-ABSTRACTION.md)) | `[REUSE]` discovery-v2 |
| `textMatch` / `relevance` | relevance | token/category overlap with the query; neutral 0.5 when nothing to match on | query + result fields | `[REUSE]` both dark engines |
| `openNow` | relevance | 1 only when the user asked and openness is KNOWN true | provider data | `[REUSE]` discovery-v2 |
| `time` | temporal | happening-now = 1; upcoming decays across the horizon; ended/cancelled = 0; postponed = 0.1 | `deriveEventState` `[REUSE]` `spotme/web/src/lib/live-events/time.js` + injected `now` | `[REUSE]` live-events |
| `popularity` | popularity | ONLY a source-supplied bounded figure; null → 0 | provider data | `[REUSE]` live-events |
| `intentFit` | relevance | structured fit + semantic similarity via the intent port ([06-AI-INTERFACES](06-AI-INTERFACES.md)) | intent port + rules | `[PROPOSED]` (Exchange PRD §4.5) |
| `availability` | temporal | time-window overlap vs the Need's timeframe | timeframe math | `[PROPOSED]` (Exchange PRD §4.3) |
| `trust` | trust | counterpart reputation + verification, non-sensitive only | reputation service (PRD §10) | `[PROPOSED]` |
| `freshness` | freshness | post recency, decaying over a horizon | timestamps + injected `now` | `[PROPOSED]` |

New signals require registration here (a spec change), not ad-hoc profile
additions — the registry is what keeps "one ranking discipline" true.

## 4.4 Weight profiles as runtime configuration

Per the configuration principle ([README](README.md) · ADR-015 reconciled):
the **behaviour** — weighted sum, breakdown, tie-break, invariants — is fixed
by this chapter; the **numbers** are runtime config, class `product`, with the
following `[PROPOSED]` defaults:

| Key | `[PROPOSED]` default | Grounding |
|---|---|---|
| `places.ranking.weights` | `{proximity: .45, rating: .25, textMatch: .20, openNow: .10}` | `[REUSE]` `spotme/web/src/lib/discovery-v2/ranking.js` `RANKING_WEIGHTS` (draft PR #60) |
| `events.ranking.weights` | `{time: .40, distance: .30, relevance: .20, popularity: .10}` | `[REUSE]` `spotme/web/src/lib/live-events/ranking.js` `RANKING_WEIGHTS` (draft PR #61) |
| `exchange.ranking.weights` | `{intentFit: .35, proximity: .25, availability: .20, trust: .15, freshness: .05}` | [Exchange PRD §4.4](../../handbook/product/exchange/04-MATCHING-AND-RANKING.md) `[PROPOSED]` |

Decay parameters are config in the same class, `[PROPOSED]` defaults from the
dark code and the PRD: `places.ranking.falloff.proximityM` = 50000 ·
`events.ranking.falloff.proximityM` = 100000 ·
`events.ranking.falloff.timeHorizonMs` = 259200000 (72 h) ·
`exchange.ranking.falloff.proximityM` = 50000 ·
`exchange.ranking.falloff.freshnessHours` = 168.

Two honest notes on the gap between the dark code and this spec:

1. **Constants → config.** In both dark modules the weights are frozen
   in-code constants. Lifting them into the config service (same values as
   defaults, same governance pattern as
   [02-LOCATION-PRIVACY-ENGINE §2.6](02-LOCATION-PRIVACY-ENGINE.md)) is
   `[PROPOSED]`, not done.
2. **Sum-to-1 is a tightening.** The dark code documents its weights as
   relative ("sum need not be 1"), though both existing profiles do sum to 1.
   The platform **requires** sum = 1 (§4.7) so scores are comparable across
   surfaces and time, which is what makes a threshold like
   `notify.match.threshold` ([07-NOTIFICATION-SERVICE](07-NOTIFICATION-SERVICE.md))
   meaningful.

## 4.5 scoreBreakdown and the explainability rule

Every scored result carries a full breakdown — the contract, `[REUSE]` from
both dark engines:

```
scoreBreakdown(result, query, now) → {
  score:      number,
  components: { <signalName>: { signal: s_k, weight: w_k, weighted: w_k·s_k }, … }
}
```

**The explainability rule:** the UI rationale ("closest match, open now",
"strong intent fit, available tonight") **renders from the breakdown** — the
same components the engine summed, exposed on the result as `rankReason`.
There is no second explanation path, so the explanation can never drift from
the score, and an auditor can recompute any ordering from the breakdown alone.
Ranking is **never a black box**: no component may enter the score without
appearing in the breakdown. The wire shape of `rankReason` is part of
[10-API-CONTRACTS](10-API-CONTRACTS.md).

## 4.6 Determinism

- **Pure**: scoring reads its arguments and the injected clock only; no I/O,
  no ambient time, no randomness.
- **Same inputs → same order.** Ties (equal score) break by stable id
  (`String(id)` comparison) so the order is total and reproducible — results
  never reshuffle under the user between renders. `[REUSE]` both dark engines.
- **Non-mutating**: ranking returns new objects carrying `score`/`rankReason`;
  inputs are untouched.
- Config is an explicit input: a profile change produces a *new* deterministic
  ordering, observable and attributable in the audit log
  ([11-FLAGS-CONFIG-OBSERVABILITY](11-FLAGS-CONFIG-OBSERVABILITY.md)).

## 4.7 Configuration-change validation

A proposed profile is validated **automatically, before acceptance** — an
invalid profile is rejected, never partially applied
([11-FLAGS-CONFIG-OBSERVABILITY](11-FLAGS-CONFIG-OBSERVABILITY.md)):

1. **Weights sum to 1** (within ε), every weight ≥ 0, every referenced signal
   is registered (§4.3).
2. **Proximity outranks popularity** (constitution, validated invariant): in
   every profile, the proximity-class weight strictly exceeds every
   popularity-class weight. Holds in all three defaults (.45 vs none; .30 vs
   .10; .25 vs none — popularity is not a first-class Exchange signal, and any
   future demand/density signal is popularity-class and capped by this rule).
3. **Decay bounds**: falloffs and horizons finite and positive; freshness
   horizon within retention bounds ([08-DATA-AND-CACHING](08-DATA-AND-CACHING.md)).
4. Every accepted change is **audited**: who, when, old → new, validation
   result.

## 4.8 Personalization seam — shipped OFF

Step 5 of the Discovery sequence
([roadmap v2.0 §17](../../handbook/product/SPOT-ME-PRODUCT-ROADMAP-V2.md)) may
add an **opt-in, bounded re-rank boost**. The seam is specified now so the
engine never needs restructuring; it ships **OFF** — in the dark code
personalization is deliberately absent, not merely disabled.

- **Opt-in only**, from editable, non-sensitive preferences; **no sensitive
  inference** ever (religious/health attributes are never derived; a medical
  search never becomes a profile).
- **Bounded and additive**: a `personalBoost ∈ [0, maxBoost]` term with
  `personalization.rerank.maxBoost` `[PROPOSED]` 0.05, validated strictly
  below every profile's proximity-class weight — the boost can re-order
  *within* the transparent ranking but **never overrides proximity or
  safety** filtering.
- **Explainable**: the boost appears in `scoreBreakdown` like any other
  component, with its preference source named ("because you saved cafés").
- **Resettable**: one action clears all preference input; the ranking returns
  to the unpersonalised order exactly.
- **Activation is compile-time** (ADR-015/[016](../../adr/016-dark-shipping.md))
  and separately owner-authorised; `maxBoost` merely tunes an activated seam.

## 4.9 Anti-gaming and sponsored separation

Inputs a poster or business can influence are bounded so they cannot buy rank:

- **Freshness is capped and cooled**: the freshness weight is small (.05) and
  re-posting within `exchange.freshness.repostCooldownHours` `[PROPOSED]` 24
  does not reset the freshness timestamp; detected repost-churn is penalised
  (Exchange PRD §4.8, §6).
- **Keyword stuffing is bounded**: text-match is a clamped token-containment
  fraction — repeating a token adds nothing beyond its one hit.
- **Popularity cannot be asserted**: only a source-supplied bounded figure
  counts; absent → 0, and the §4.7 invariant caps its influence regardless.
- **Sponsored placement is a separate, LABELED slot** — never mixed into the
  organic score, never present in `scoreBreakdown`, never able to override
  safety (Exchange PRD §10;
  [roadmap v2.0 §23](../../handbook/product/SPOT-ME-PRODUCT-ROADMAP-V2.md)).
  An organic result and a sponsored slot are different contract types in
  [10-API-CONTRACTS](10-API-CONTRACTS.md).

## 4.10 Deterministic testing

Injected: **clock** (`now` for time/freshness/availability signals),
**config** (the weight profile and decay keys as explicit arguments), and
fixed fixtures (no seed needed — the engine has no randomness). Pinned:
same-inputs-same-order and id tie-break totality; weights-sum-to-1 and
proximity-outranks-popularity as executable validators run against every
profile (defaults and any proposed change); breakdown-completeness (score
equals the sum of its own components — the explainability rule as an
assertion); neutral-zero honesty for null rating/popularity/openness;
mutation-style checks that no unregistered signal and no sponsored input can
reach the organic score. `[REUSE]` test pattern:
`spotme/web/test/discovery-v2-ranking.test.js` and
`spotme/web/test/live-events-ranking.test.js` (draft PRs #60/#61) pin the two
dark profiles today.

## 4.9 As built (Phase 2B/2D — Draft PR, DARK)

Two cooperating layers exist in code:

- **People ordering** (`backend/src/discovery/discovery.ranking.ts`):
  deterministic band → freshness → userId ordering; `explainPerson` emits a
  `RankingBreakdown` for every result with `omittedSignals` honestly declared
  (`mutual-context` is specified but not computed this phase).
- **Closed-registry engine** (`backend/src/discovery/discovery.ranking.engine.ts`):
  `RANKING_SIGNALS` = { intentMatch .30, proximity .30, relevance .15,
  freshness .10, sourceConfidence .10, availabilityEvidence .05 } —
  `[PROPOSED]` defaults per the Configuration Principle. `safetyEligible` is
  a HARD GATE before scoring; an unregistered signal throws
  `ClosedRegistryError` (no popularity/sponsored/engagement path can be added
  without changing the registry in review); confidence = evidence coverage;
  unknown evidence scores zero — never an invented benefit.

Proof obligations pinned in `backend/test/discovery-intent-ranking.spec.ts`:
closer-viable-beats-popular-distant, safety-exclusion-always-wins,
unknown-evidence-no-benefit, sponsored-signal-rejected, breakdown-mandatory.
Ranking cost is negligible at page scale (measured —
[15 §15.3](15-PERFORMANCE-AND-CAPACITY.md)).
