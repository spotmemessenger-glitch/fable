# 04 — Matching, AI Search & Ranking

> Reconstruction pending A5 ratification. Weights/thresholds are `[PROPOSED]`
> defaults chosen for testability, not final. Ranking is transparent and
> deterministic — no opaque "AI".

## 4.1 Principles

- **Intent, not keywords.** Matching keys on structured intent (category,
  timeframe, budget band, tags) plus semantic similarity of free text.
- **Interface-first AI.** Semantic similarity is defined behind a
  provider-neutral **intent port** (`[REUSE]` the Discovery query-intent seam).
  A deterministic baseline (structured + token/embedding-if-available) ships
  first; **no LLM/model activation without owner authorisation**.
- **Explainable & deterministic.** Same inputs → same order; every match carries
  a component breakdown. **Proximity outranks popularity.**
- **No sensitive inference.** Matching never reads/derives religious, health, or
  other sensitive attributes; personalization is opt-in and additive only.

## 4.2 Matching pipeline

```
 candidate set (opposite type, ACTIVE, in adaptive radius, safety-passed)
   │  [REUSE] adaptive radius 10→15→25→50→100 km, min-result stop
   ▼
 hard filters (category compatible? timeframe overlaps? budget bands compatible?
               blocked/hidden removed? safety/fraud gates?)
   ▼
 intent scoring (structured fit + semantic similarity via intent port)
   ▼
 match score = weighted sum of signals (§4.4)  →  rank (ties broken by id)
   ▼
 top-N proposed matches, each with rationale + score breakdown
```

- **Cancellation & staleness:** each run carries an epoch; a newer run supersedes
  an older one; `AbortSignal` cancels — `[REUSE]` the Discovery search
  orchestration.
- **Honest states:** ok / partial (some providers/inputs failed) / empty /
  unavailable / failed — never invented matches.

## 4.3 Signals

| Signal | Meaning | Source |
|---|---|---|
| `intentFit` ∈ [0,1] | structured compatibility (category, timeframe, budget) + semantic similarity of text | intent port + rules |
| `proximity` ∈ [0,1] | device-local distance, decaying to 0 at falloff `[PROPOSED 50 km]` | `geo-approx`/`distanceM` `[REUSE]` |
| `availability` ∈ [0,1] | time overlap / soonest availability vs the Need's timeframe | timeframe math |
| `trust` ∈ [0,1] | counterpart reputation + verification (§10), non-sensitive only | reputation service |
| `freshness` ∈ [0,1] | recency of the counterpart post; decays with age | timestamps |

Popularity is **not** a first-class signal; where a demand/supply density signal
is used it is capped so it can never outweigh proximity (constitution).

## 4.4 Ranking formula `[PROPOSED]`

```
matchScore =
    0.35 · intentFit
  + 0.25 · proximity
  + 0.20 · availability
  + 0.15 · trust
  + 0.05 · freshness
```

- Weights are explicit constants (sum = 1), reviewable and unit-pinned — the same
  transparent-ranking pattern as Discovery/Events `[REUSE]`.
- `scoreBreakdown` returns each `{signal, weight, weighted}` so the UI can render
  the rationale and an auditor can verify it.
- **Tie-break:** by stable id → total, reproducible order.
- **Constraint invariant (tested):** `proximity`'s weighted contribution ≥ any
  popularity/density contribution — proximity outranks popularity.

### Signal decays `[PROPOSED]`
- `proximity = clamp01(1 − distanceM / 50000)`.
- `availability`: 1 if the Offer covers the Need's window now; linear decay by
  hours until it opens; 0 if it cannot meet the window.
- `freshness = clamp01(1 − ageHours / 168)` (7-day horizon).

## 4.5 Intent scoring detail

- **Structured fit (deterministic):** category compatibility (exact/related via a
  transparent category graph), timeframe overlap, budget-band compatibility.
- **Semantic similarity (interface):** the intent port returns a [0,1] similarity
  for free-text intent. Baseline = token overlap; an approved on-device/embedding
  provider may raise quality later — **provider-neutral, no hard dependency**,
  route/fall back on quality/latency/cost.
- `intentFit = 0.6 · structuredFit + 0.4 · semanticSimilarity` `[PROPOSED]`.
- If the intent port is unavailable, `intentFit = structuredFit` (degrade
  honestly; never block).

## 4.6 AI Search & Unified Search

- **Unified search** runs one query across places · events · **exchange**, each
  via its provider-neutral search, merged into one result model and one map
  state `[REUSE]`. Exchange contributes Need/Offer results ranked by §4.4.
- **AI Search / natural language:** a query like "someone to fix a leaking tap
  tonight" is parsed by the intent port into `{category: services/plumbing,
  timeframe: tonight, type: offer-wanted}` and run through the pipeline. Parsing
  is interface-first; the rationale is always shown; **no LLM activation without
  owner authorisation.**
- **Voice search:** partial/final transcript, language detection, text fallback;
  never fabricates results; route/ETA questions use a directions provider.

## 4.7 Personalization (opt-in, additive)

- Only if the user opts in and only from **editable, non-sensitive** preferences
  (categories of interest, preferred radius, budget band, saved/hidden). It can
  **re-order within** the transparent ranking (a bounded boost), never override
  proximity/safety, and never infer sensitive traits. Fully resettable. This is
  Discovery step 5 territory — Exchange exposes the seam but ships it **off**.

## 4.8 Anti-gaming

- Ranking inputs a business can influence (freshness via re-posting, keyword
  stuffing) are bounded/penalised; sponsored placement is a **separate, labeled**
  slot (§10), never mixed into organic score.
