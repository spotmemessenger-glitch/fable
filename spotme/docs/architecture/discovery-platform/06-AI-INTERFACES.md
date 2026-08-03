# 06 — AI Interfaces

> Part of the [Discovery Platform Architecture Specification](README.md).
> Engineering spec — draft for owner review (stacked PR; documentation only,
> nothing here activates code). Numeric values are [PROPOSED] config defaults.

## 6.1 The assistive rule

One sentence governs everything in this chapter:

> **AI understands intent — the ranking engine decides — everything stays
> explainable.**

AI in Spot Me is an *input refiner*, never a decision-maker. A port may turn
free text into a structured query, score similarity between two intents,
classify content for safety, summarise authorized sources, or transcribe
speech. What it may **never** do is choose, order, or invent results: ordering
belongs exclusively to the transparent ranking engine
([04-RANKING-SERVICE](04-RANKING-SERVICE.md)), whose `scoreBreakdown` remains
the only explanation path. Every AI-touched output carries a rationale; there
is no hidden manipulation
([roadmap v2.0 §22](../../handbook/product/SPOT-ME-PRODUCT-ROADMAP-V2.md)).

## 6.2 Interface-first design

AI capabilities are defined as **ports** — stable contracts a surface codes
against — with providers as swappable adapters behind the provider seam of
[05-PROVIDER-ABSTRACTION](05-PROVIDER-ABSTRACTION.md)
([ADR-017](../../adr/017-provider-neutral-adapters.md): timeout, cancellation,
retry, circuit-breaker, cost accounting, normalized errors, `assertNoSecrets`).
Ports are **dark-shippable**: an interface plus a deterministic baseline can
merge and be exercised by tests with **no model, no network, and no
activation** — exactly how the intent seam shipped in draft PR #60.

```
 surface ──► Port (stable contract) ──┬── deterministic baseline  (pure, always present)
                                      └── provider adapter(s)     (DARK until owner-authorised)
                    output = structured input to search/ranking — never a result
```

## 6.3 Port catalogue

| Port | Contract | Feeds | Status |
|---|---|---|---|
| **IntentPort** | `parse(text) → {category?, filters?, timeframe?, budgetBand?, tags?, cleanedText?}` — structured intent; `similarity(a, b) → [0,1]` — free-text intent similarity | query orchestration ([03-INTENT-GRAPH-AND-SEARCH](03-INTENT-GRAPH-AND-SEARCH.md)); Exchange `intentFit` ([PRD §4.5](../../handbook/product/exchange/04-MATCHING-AND-RANKING.md)) | `parse` seam **dark** `[REUSE]` `spotme/web/src/lib/discovery-v2/intent.js` (draft PR #60); `similarity` `[PROPOSED]` |
| **SafetyPort** | `classifyText(text) → {verdict: allow\|flag\|block, categories, confidence}`; `classifyImage(ref) → same` | moderation gates (roadmap §23; Exchange PRD §6) | model-backed classify `[PROPOSED]`; deterministic filter **dark** `[REUSE]` `spotme/web/src/lib/live-events/safety.js` (draft PR #61) |
| **SummaryPort** | `summarize(sources[]) → {state: ok\|insufficient-evidence, summary?, citations[]}` — **authorized sources only**; must return `insufficient-evidence` rather than invent | review/result summaries (roadmap §17, future scope §27) | `[PROPOSED]` — no code |
| **VoicePort** | `start(opts) → session` emitting `partial(transcript)` / `final(transcript, language)` / `error`; language detection; **text fallback always available** | voice search: transcript → `IntentPort.parse` → normal pipeline | `[PROPOSED]` — no code |

Port rules, binding for all four:

- A port's output is **structured input** to search and ranking — never a
  place, event, match, count, or ETA. Fabricating any of those violates the
  honesty constitution ([01-PLATFORM-OVERVIEW §1.4](01-PLATFORM-OVERVIEW.md)).
- Explicit user statements win: `deriveIntent` merges parsed intent **without
  overriding** a category or filter the user set directly `[REUSE]`
  `spotme/web/src/lib/discovery-v2/intent.js`.
- `SummaryPort` output always carries citations to its authorized sources; a
  summary that cannot cite is `insufficient-evidence`. **No scraping.**
- `VoicePort` is an input method, not a separate intelligence: route/ETA
  questions inside a transcript go to the directions provider
  ([05-PROVIDER-ABSTRACTION](05-PROVIDER-ABSTRACTION.md)) — a straight line is
  never presented as a route.
- `SafetyPort` composes with, and never replaces, deterministic blocking:
  source-asserted restriction flags and the user's block list are applied
  regardless of any classifier verdict.

## 6.4 Deterministic baselines ship first

Every port has a **pure, deterministic baseline** that ships before (and
survives beside) any model-backed provider. The seam is exercised, not merely
declared:

| Port | Baseline | Status |
|---|---|---|
| IntentPort.parse | `baselineParse` — transparent keyword → category map, "open now" phrase detection, hint stripping; synchronous, pure, no I/O | **Dark, real** `[REUSE]` `spotme/web/src/lib/discovery-v2/intent.js` (draft PR #60, not on master) |
| IntentPort.similarity | token-overlap similarity (Exchange PRD §4.5) | `[PROPOSED]` |
| SafetyPort | source-asserted flags + injected block predicate — removes restricted/unsafe by default, invents no verdict | **Dark, real** `[REUSE]` `spotme/web/src/lib/live-events/safety.js` (draft PR #61) |
| SummaryPort | extractive only: attributed verbatim excerpts, else `insufficient-evidence`; zero generation | `[PROPOSED]` |
| VoicePort | typed text — the fallback *is* the baseline | `[PROPOSED]` |

The dark `parse` baseline is deliberately **synchronous and pure** so intent
can never become a latency or privacy surface. Extending the port to async,
provider-backed implementations is `[PROPOSED]` and goes through the provider
SDK's timeout/cancel discipline — the synchronous baseline remains the floor.

## 6.5 Activation governance

**No LLM, model call, or conversational assistant activates without explicit
owner authorisation** (roadmap v2.0 §17/§22; Exchange PRD §4.1; constitution).
Concretely:

- Ports and baselines are **dark-shippable** now (interfaces + pure code,
  fence-tested per [ADR-016](../../adr/016-dark-shipping.md)).
- Wiring any **model-backed adapter** is an activation: compile-time flag per
  [ADR-015](../../adr/015-compile-time-feature-flags.md), default false, hard
  master gate, tree-shaken, and a separate owner-authorised change per
  capability — runtime config may tune an activated adapter, never switch one
  on ([11-FLAGS-CONFIG-OBSERVABILITY](11-FLAGS-CONFIG-OBSERVABILITY.md)).
- The AI Assistant surface itself is Discovery **step 5** — nothing in this
  chapter builds it; this chapter only guarantees the seams it will need.

## 6.6 Provider neutrality and the fallback ladder

No provider may become a hard dependency (ADR-017; owner amendment: every AI
feature optimises **accuracy + latency + privacy simultaneously**). Routing
selects among authorized adapters on **quality, latency, privacy, cost** —
and always terminates in the baseline:

```
 authorized model provider (activated)          │ route on quality /
   └─ failure/degradation → alternate provider  │ latency / privacy / cost
        └─ none available → deterministic baseline  (always present, pure)
             └─ baseline inapplicable → honest degraded state — NEVER block,
                                                                NEVER invent
```

Worked degradations: intent port unavailable → Exchange `intentFit` =
structured fit only (PRD §4.5); a throwing intent provider degrades to "no
enrichment" — free-text search proceeds unchanged `[REUSE]` `deriveIntent`'s
catch path; `SummaryPort` without sufficient sources → `insufficient-evidence`
rendered as such; `VoicePort` failure → text input. Degradations surface
through the explicit result states of
[10-API-CONTRACTS](10-API-CONTRACTS.md) (`partial`/`unavailable`), never as
silently thinner results.

## 6.7 Privacy at the AI boundary

The AI boundary is a data-minimisation boundary
([ADR-019](../../adr/019-discovery-v2-privacy-model.md);
[02-LOCATION-PRIVACY-ENGINE](02-LOCATION-PRIVACY-ENGINE.md)):

- **Minimum data out**: a provider receives at most the origin and the query
  text/audio — no identity beyond what the call strictly requires, and
  `[PROPOSED]` at most a **coarse, cell-snapped origin, never the precise
  fix** (the coarse-only port typing is a platform tightening beyond current
  dark-code behaviour — see [02 §2.4](02-LOCATION-PRIVACY-ENGINE.md)).
  Payloads pass the whitelist normalization and `assertNoSecrets` discipline of
  [05-PROVIDER-ABSTRACTION](05-PROVIDER-ABSTRACTION.md).
- **No sensitive inference**: no port may infer or emit religious, health, or
  other sensitive attributes; a medical search never becomes a profile
  (roadmap §17). Port output schemas contain no fields for such attributes —
  the contract, not policy, forbids them.
- **Visible cloud boundaries**: whenever text or audio would leave the device
  for a model provider, the UI says so and the user has consented; on-device/
  baseline processing is the default. Consent is explicit and revocable
  (roadmap §2 constitution).
- **No retention by the platform** of provider-bound AI payloads beyond the
  request lifecycle; logging of query content follows
  [08-DATA-AND-CACHING](08-DATA-AND-CACHING.md) retention rules.

## 6.8 Determinism

Ports are **injectable**: every consumer takes its port instance as an
explicit argument (as `deriveIntent(text, {provider})` already does `[REUSE]`),
so tests substitute a scripted port with zero network. Baselines are **pure**:
same text → same parse, same pair → same similarity, no ambient clock or
randomness. Provider validity is checked structurally
(`isValidIntentProvider`), and an invalid or throwing provider degrades — a
port can misbehave without making the pipeline nondeterministic.

## 6.9 Deterministic testing

Injected: **ports** (scripted fakes per §6.8), **config** (routing/fallback
thresholds as explicit arguments), and — for any future async adapter —
**clock** and `AbortSignal` for timeout/cancel paths. Pinned: baseline purity
(same input → same output, table-driven over the keyword map); user-statement
precedence (an explicit category is never overridden by inference); the
throwing-provider degradation path; safety filtering defaults
(restricted/unsafe removed unless explicitly allowed; blocked sources removed)
and the origin-leak guard `assertNoOriginLeak` as a mutation-style test;
`insufficient-evidence` on empty/unauthorized sources; and fence tests proving
no model adapter is reachable or bundled while dark
(`*-not-shipped.test.js`, [ADR-016](../../adr/016-dark-shipping.md)).
`[REUSE]` test pattern: `spotme/web/test/discovery-v2-intent.test.js` and
`spotme/web/test/live-events-safety.test.js` (draft PRs #60/#61) pin the two
dark baselines today.
