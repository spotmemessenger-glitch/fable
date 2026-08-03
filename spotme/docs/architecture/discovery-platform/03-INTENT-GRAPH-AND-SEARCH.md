# 03 — Intent Graph & Search Orchestration

> Part of the [Discovery Platform Architecture Specification](README.md).
> Engineering spec — draft for owner review (stacked PR; documentation only,
> nothing here activates code). Numeric values are [PROPOSED] config defaults.

## 3.1 Service responsibilities — the Intent Graph is a platform service

Owner directive (2026-08-03): **Exchange is not a module.** It is realised
here as the **Intent Graph** — a platform service that holds the common
registry of local intents (needs, offers, places, events, moments), whatever
surface produced them, and answers every Discovery query from that one
registry ([ADR-023](../../adr/023-exchange-platform-service-intent-graph.md),
Proposed; [exchange/01-CONCEPT-AND-SCOPE §1.8](../../handbook/product/exchange/01-CONCEPT-AND-SCOPE.md)).

Responsibilities:

1. **Hold intents, not silos.** Every surface publishes into one graph; a
   query is answered across kinds, not per-surface.
2. **Expose a stable service boundary** (§3.3): sources integrate via
   contract; the core never changes because a source was added.
3. **Orchestrate unified search** (§3.5): one pipeline from raw text to one
   ranked, state-tagged result envelope and one shared map state.
4. **Own the adaptive radius** (§3.6) and **cancellation/staleness** (§3.7)
   disciplines every surface inherits.
5. **Inherit the privacy constitution unchanged**: intents carry approximate
   location only ([02-LOCATION-PRIVACY-ENGINE](02-LOCATION-PRIVACY-ENGINE.md),
   [ADR-019](../../adr/019-discovery-v2-privacy-model.md)); providers sit
   behind [05-PROVIDER-ABSTRACTION](05-PROVIDER-ABSTRACTION.md).

Honesty: the Intent Graph service itself is **entirely [PROPOSED] — no code
exists**. What exists is its behavioural substrate on **unmerged draft PRs
#60/#61** (`spotme/web/src/lib/discovery-v2/`, `spotme/web/src/lib/live-events/`),
cited `[REUSE]` below. Nothing in this chapter runs on `master`.

## 3.2 The intent record `[PROPOSED]`

One record shape spans every kind. It generalises the dark `Place`
(`[REUSE]` `spotme/web/src/lib/discovery-v2/contracts.js`) and `EventRecord`
(`[REUSE]` `spotme/web/src/lib/live-events/contracts.js`) plus the Exchange
item ([exchange/09-DATABASE-SCHEMA](../../handbook/product/exchange/09-DATABASE-SCHEMA.md)):

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable id, `${source}:${sourceId}` — the dedup and tie-break key |
| `kind` | enum | `need` \| `offer` \| `place` \| `event` \| `moment` |
| `category` | string | Source-kind taxonomy value, normalised (whitelisted, else `other`) |
| `intent` | object | Structured intent: cleaned text, category, filters, budget band, tags — the output shape of the intent port (§3.5) |
| `timeframe` | object\|null | `{fromUTC, toUTC, timezone}`; null for timeless kinds (places) |
| `location` | object\|null | **Approximate only** `{lat, lon}` — already coarsened per chapter [02](02-LOCATION-PRIVACY-ENGINE.md); never a precise fix |
| `geoCell` | string\|null | Discretized cell id for indexing (the v1 geo index — no PostGIS/H3) |
| `sourceSurface` | string | Which surface published it (map/exchange/events/moments/…) — audit + routing, not display prominence |
| `attribution` | object | `{provider, source, url}` public credit, as in the events record `[REUSE]`; plus `trustRef` — an opaque reference into the reputation service ([exchange/10](../../handbook/product/exchange/10-BUSINESS-AND-REPUTATION.md)), never an inlined score |
| `distanceM` | number\|null | Filled at query time from the **device-local** origin; never stored |

Normalisation follows the proven boundary rule `[REUSE]` (both contracts
modules): whitelist-copy into a fresh frozen record; a candidate missing the
minimum (id, title/name, usable location where the kind requires one) yields
`null`, never a half-built record; raw source payloads never propagate.

## 3.3 Publish/consume contracts — the service boundary `[PROPOSED]`

Three operations are the entire boundary. New sources integrate via contract;
**the core is unchanged as sources grow** (owner directive):

```
registerIntentSource(source)
  source = { name, kinds: [...], search(query, ctx) → Promise<candidate[]> }
  — duck-type validated and assertNoSecrets-checked at registration
    [REUSE] isValidProvider/assertNoSecrets, discovery-v2/contracts.js;
    a malformed source is skipped, a credential-carrying one fails loud.

publishIntent(candidate, sourceName) → IntentRecord | null
  — push path for surfaces that create intents (Exchange compose, Moments,
    consented shares). Normalises per §3.2, enforces the privacy invariants
    (approximate location only, consent recorded), persists to the graph.

queryIntents(rawQuery, opts) → Promise<ResultEnvelope>
  — the single consume path: the unified pipeline of §3.5. Every surface,
    and the assistant seam of [06-AI-INTERFACES](06-AI-INTERFACES.md),
    reads through this and only this.
```

Pull-style sources (place/event providers) implement `search` and are queried
live through [05-PROVIDER-ABSTRACTION](05-PROVIDER-ABSTRACTION.md); push-style
sources call `publishIntent` and are served from the graph's own store
([08-DATA-AND-CACHING](08-DATA-AND-CACHING.md)). The wire form of these
operations is specified in [10-API-CONTRACTS](10-API-CONTRACTS.md), aligned
with [exchange/08-API-CONTRACTS](../../handbook/product/exchange/08-API-CONTRACTS.md).

## 3.4 The source registry

| Source | Kind(s) | Status | Integration |
|---|---|---|---|
| Place providers | `place` | Dark code exists (draft PR #60) | Pull, via provider port `[REUSE]` `discovery-v2/search.js` |
| Event providers | `event` | Dark code exists (draft PR #61) | Pull, via event-provider port `[REUSE]` `live-events/search.js` |
| Exchange items | `need`, `offer` | Planned — PRD pending A5 ratification | Push (`publishIntent`) from compose; queried from the graph store |
| Nearby Moments | `moment`, `offer` | Future source — **seam only** | Push, once the Moments mission is approved |
| Business inventory | `offer` | Future source — **seam only** | Push at scale, Business Platform |
| Consented friend shares | `need` | Future source — **seam only** | Push, per-share explicit consent (Messaging) |
| Communities & Channels | `need`, `offer` | Future source — **seam only** | Push (`publishIntent`) from group posts ("Volunteer needed Saturday" → `need`) |

Future sources are named here so the contract is designed for them; **no
implementation is implied**. Sources are authorized integrations only — no
scraping ([ADR-017](../../adr/017-provider-neutral-adapters.md)).

## 3.5 The unified search pipeline

One pipeline serves every surface. Steps marked `[REUSE]` exist as dark code
on draft PRs #60/#61; the fan-out across *heterogeneous kinds* is the
[PROPOSED] generalisation of the proven per-surface orchestrators
(`[REUSE]` `spotme/web/src/lib/discovery-v2/search.js`,
`spotme/web/src/lib/live-events/search.js`).

```
 raw query (text, optional category/filters, device-local origin)
   │
   ▼
 normalizeQuery                      [REUSE] discovery-v2/contracts.js
   │   whitelist → frozen {text, category, filters, origin}
   ▼
 intent parse via IntentPort         see 06-AI-INTERFACES.md
   │   deterministic baseline [REUSE] discovery-v2/intent.js;
   │   explicit user category ALWAYS wins over inference;
   │   port failure degrades to "no enrichment", never blocks
   ▼
 route to registered sources         §3.3/§3.4 — kinds relevant to the intent
   ▼
 per-source bounded search           adaptive radius §3.6, per-source timeout;
   │   errors counted, never thrown up (→ partial/failed)
   ▼
 normalize (per kind, §3.2) → merge + dedup (by stable id, inclusive
   │   widening re-covers inner discs [REUSE] discovery-v2/radius.js)
   ▼
 rank                                04-RANKING-SERVICE.md — one type-agnostic
   │   order; deterministic; tie-break by id; proximity outranks popularity
   ▼
 ONE result envelope                 {state, results, radiusKm, query, providerErrors}
   +
 shared map state                    [REUSE] discovery-v2/mapstate.js — map and
                                     list are two views of ONE store, never copies
```

The envelope shape is the dark envelope `[REUSE]`; `results` carries §3.2
records. The map/list single source of truth (`setResults`, `select`, `hover`,
pruning of vanished selections) is reused as-is.

**The routing rule (behaviour — fixed by this spec, not config):**

1. **Default fan-out:** the query goes to every registered source whose
   declared `kinds` intersect the intent's candidate kinds. A parsed intent of
   kind `offer-wanted` reaches place providers, business inventory and
   Exchange offers; a `need`-shaped post query reaches need-consuming sources.
2. **No parseable intent → all sources.** A low-confidence or empty parse
   never narrows the search silently; the query fans out to all registered
   sources and relevance is left to ranking.
3. **Explicit user filters always narrow and are never overridden** — the
   user's stated category/kind wins over inference (the same
   user-category-wins rule the intent seam already enforces `[REUSE]`
   `discovery-v2/intent.js`).
4. **Unavailable sources degrade honestly:** a registered source that is dark,
   unreachable or erroring is skipped and counted (→ `partial`), never
   silently dropped from the answer's claim of coverage.

## 3.6 The adaptive radius engine

`[REUSE]` `spotme/web/src/lib/discovery-v2/radius.js` (draft PR #60; also
consumed unchanged by Live Events, draft PR #61). Behaviour is fixed by this
spec; the numbers are runtime configuration
([11-FLAGS-CONFIG-OBSERVABILITY](11-FLAGS-CONFIG-OBSERVABILITY.md), class
`product`):

| Key | Default `[PROPOSED]` | Meaning |
|---|---|---|
| `discovery.radius.steps` | `[10, 15, 25, 50, 100]` km | The expansion ladder; validation invariant: strictly ascending |
| `discovery.radius.minResults` | `8` | Stop expanding once this many distinct results are in hand |

Fixed behaviour:

- **Min-result stop:** widen step by step only until `minResults` distinct
  results exist, then stop (`stoppedBy: 'min-results'`). A dense area answers
  at the first step; a sparse one keeps reaching.
- **Inclusive-widening dedup:** each step re-covers the inner disc, so batches
  are merged and deduped by id — never assumed disjoint rings.
- **Hard cap:** the last rung is the ceiling (`stoppedBy: 'max-radius'`);
  the engine never searches past it.
- **Origin privacy:** the ladder runs against the device-local fix. The
  current dark code passes the device-local origin to a provider where the
  lookup technically requires one (ADR-019-permitted); typing the provider
  port **coarse-origin-only** is a `[PROPOSED]` tightening, not current
  behaviour — see [02 §2.4](02-LOCATION-PRIVACY-ENGINE.md).
- **TRANSPARENT-EXPANSION rule:** the envelope reports the radius actually
  used (`radiusKm`) and **the app tells the user when it expanded** — e.g.
  "no nearby results within 10 km; showing results within 50 km". Silent
  widening is a dishonest distance claim and is prohibited (constitution:
  disclose radius expansion).

## 3.7 Cancellation and staleness

`[REUSE]` the epoch + `AbortSignal` discipline of
`spotme/web/src/lib/discovery-v2/{radius,search}.js`, inherited verbatim by
`live-events/search.js`:

- Every `queryIntents` run takes the next value of a monotonic **epoch**; a
  newer run bumps it, and the older run — checked between radius steps and
  after each fetch — resolves `superseded` with its results dropped. A stale
  response can never render over a fresher one.
- An **`AbortSignal`** cancels outright (navigation away, input cleared);
  aborts surface as `superseded`, never as an error dialog.
- Supersede/abort checks run **after** awaited fetches too, because a fetch
  can straddle the boundary.

## 3.8 Result states — the seven states and their exact meanings

Every query resolves to exactly **one** state
(`[REUSE]` `discovery-v2/contracts.js` defines six; `live-events/contracts.js`
adds `loading`; the platform set is the union):

| State | Exact meaning |
|---|---|
| `loading` | The query is in flight; no answer yet. A UI state, never a final envelope state. |
| `ok` | Every consulted source answered; at least one result. |
| `partial` | Results exist, but one or more sources failed or timed out — shown, and labelled as incomplete. |
| `empty` | Sources answered; zero matches. An honest "nothing nearby", never padded. |
| `unavailable` | No source is configured/reachable for this query. **Never faked** with invented results. |
| `failed` | Every consulted source errored; nothing usable returned. |
| `superseded` | A newer query replaced this one (epoch or abort, §3.7); results dropped, nothing rendered. |

Fabricating results, counts, ETAs or matches in any state is prohibited
(constitution); `unavailable` and `empty` are answers, not gaps to fill.

## 3.9 Intent-first composition — "the nearest solution"

Owner directive: **organize by intent, not type.** "I need a turbocharger"
queries every registered source — businesses, individuals, marketplace items,
nearby requests, groups, consented friend shares, business inventory, events,
and AI recommendations — and returns **one type-agnostic ranked answer**: the
nearest solution, ranked by the profile-weighted rules of
[04-RANKING-SERVICE](04-RANKING-SERVICE.md), never a type-siloed list.
Per-kind grouping (tabs, section headers, kind badges) is **presentation
only**, applied after ranking; it must never re-rank, filter, or privilege a
kind — a filter chip is the user narrowing scope, not the platform composing
by type. `sourceSurface` is audit metadata, not a ranking signal
([ADR-021](../../adr/021-spotme-unified-product-ecosystem.md);
[exchange/04-MATCHING-AND-RANKING §4.6](../../handbook/product/exchange/04-MATCHING-AND-RANKING.md)).

## 3.10 Deterministic testing

Injected: **clock** (`now`, as in `live-events/search.js` `[REUSE]`),
**seed/epoch** (ids and epoch counters are explicit), **config**
(`steps`, `minResults`, source lists and `fetchAtRadius` are parameters —
`[REUSE]` `expandingSearch` is driven by stubs). Mutation/invariant tests pin:
the radius ladder stops at min-results and at the cap; inclusive-widening
dedup (duplicate ids across steps collapse); supersede/abort between and
across steps yields `superseded`, never stale rendering; each terminal state
of §3.8 is reachable and exclusive; zero sources → `unavailable` (no fake
results — the fence for the no-fabrication rule); explicit user category
survives intent parsing; ranking order is reproducible with ties broken by id;
and no precise coordinate appears in any published intent, envelope, or map
snapshot (chapter [02 §2.7](02-LOCATION-PRIVACY-ENGINE.md) boundary suite).
