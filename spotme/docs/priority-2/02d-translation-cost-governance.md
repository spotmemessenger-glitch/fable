# 02d — Translation Platform: cost governance report

**Companion to** ADR-010b. Scope: additive, gated behind
`TRANSLATION_COST_GOVERNANCE_ENABLED` (default false, layered under the master).
The engine is byte-identical to `origin/master`.

---

## 1. Why

The engine spends the owner's money at five vendors on every request and has no
idea how much. A headline feature has already gone dark because a key ran out of
credit. Cost governance makes spend **visible** and **bounded** before it happens
— and never becomes a hard dependency: with the flag OFF it does nothing, and
even ON it only ever REFUSES an over-budget call, never blocks one it can afford.

## 2. Estimation (`cost.js`)

`estimateMicroUsd(priceSignal, costModel)` = `microUsdPerUnit × estimatedUnits`.
The provider supplies the units via its `priceSignal(request)`; the published
`costModel` supplies the rate. Estimates are order-of-magnitude, carry no account
or invoice, and free providers are 0.

Published cost models (µ$ = micro-USD; 1 000 000 µ$ = $1.00):

| provider | unit | µ$/unit | note |
|---|---|---|---|
| device, gtx, mymemory, google-inputtools | — | 0 | free / on-device / keyless |
| azure | char | 0.01 | cheapest metered |
| google | char | 0.02 | |
| sarvam | char | 0.03 | Indic specialist |
| gemini | token | 0.30 | LLM leg |
| openai | token | 2.50 | premium LLM |
| anthropic | token | 3.00 | premium LLM |
| elevenlabs | call | 100 | voice (declaration-only here) |

## 3. Governance (`createCostGovernor`)

- **Counters.** Per-account spend, rolled up per day and per month (in-memory;
  the durable `TranslationUsageCounter`, design §13, is deferred). Day/month keys
  come from an injected clock, so rollover is deterministic and tested.
- **Ceilings.** `check(account, estimate)` refuses a call that would exceed the
  daily OR monthly ceiling (`hardBlocked`), and warns first at a soft ratio
  (default 0.8) so the product can shed optional cost (drop the second opinion)
  before it fails. Defaults: **$5.00/account/day, $50.00/account/month**; per-
  account overrides widen or narrow a single account.
- **Fan-out budget.** Cross-verify and adjudication cost EXTRA calls.
  `fanout(account, reason)` caps fan-outs per window (default 6/min) and — the
  design's rule — **refuses any fan-out with no recorded reason.** The pipeline
  passes the fan-out gate to `verify.resolve` as `onFanout`, so a disagreement is
  only escalated to a judge when the budget AND a reason both exist.
- **Cache-first.** `shouldCheckCacheFirst()` is always true; the pipeline honours
  it (stage 2 before stage 5), and `recordCacheSaving` counts avoided spend.

## 4. Where each control fires in the pipeline

```
route() → estimate(chosen) → check(account) ──over?──▶ refuse (uncertain, blocked)
                                    │ ok
                                    ▼
                              execute() → record(actual)
                                    │
                cross-verify? ─▶ record(second)   adjudicate? ─▶ fanout(reason) gate
```

## 5. Metrics (`cost.snapshot()`, surfaced via `readiness`)

`{ estimated, recorded, blocked, softWarnings, fanouts, cacheSavings, accounts }`
— amounts and counts only, never content. Feeds the observability surface.

## 6. Owner decisions required

- **Ceiling values.** The $5/day, $50/month defaults are placeholders — set real
  per-tier limits before enabling `TRANSLATION_COST_GOVERNANCE_ENABLED`.
- **Cost model accuracy.** The µ$/unit figures are public order-of-magnitude
  estimates; reconcile against actual vendor pricing/contracts before relying on
  the estimate for hard refusals.
- **Durable counters.** In-memory counters reset on process restart; a durable
  store (design §13) is required for real monthly enforcement and is an owner
  decision (not built here).
- **Fan-out budget.** 6/min/account is a placeholder; tune against measured
  adjudication rates.
