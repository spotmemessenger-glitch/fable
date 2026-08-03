# 01 — Platform Overview

> Part of the [Discovery Platform Architecture Specification](README.md).
> Engineering spec — draft for owner review (stacked PR; documentation only,
> nothing here activates code). Numeric values are `[PROPOSED]` config defaults.

## 1.1 The shared-foundation thesis

Five Discovery surfaces ship in a fixed order
([DISCOVERY-PROGRAMME](../../handbook/product/DISCOVERY-PROGRAMME.md)). They
differ in *what* they show — places, needs and offers, events, moments, an
assistant — but they are the same machine underneath: take a device-local
position, derive a privacy-safe public one, search authorized sources within an
adaptive radius, rank transparently, notify honestly, cache and degrade
gracefully offline. The DPAS builds that machine **once** as ten platform
services with stable contracts. A surface is then thin: contracts + UI + a
weight profile. The payoff is not only less duplication — it is that every
privacy, honesty, and provider invariant is enforced in exactly one place and
tested in exactly one place.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         DISCOVERY SURFACES (five)                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────────┐  │
│  │ 1 Smart  │ │ 2 SpotMe │ │ 3 Live   │ │ 4 Nearby │ │ 5 AI Assistant &   │  │
│  │  Nearby  │ │ Exchange │ │  Nearby  │ │  Moments │ │   Personalization  │  │
│  │   Map    │ │          │ │  Events  │ │          │ │  (opt-in only)     │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └─────────┬──────────┘  │
└───────┼────────────┼────────────┼────────────┼─────────────────┼─────────────┘
        │      every surface consumes the same services;         │
        │      every surface publishes intents into Exchange     │
┌───────┴────────────┴────────────┴────────────┴─────────────────┴─────────────┐
│                        COMMON PLATFORM SERVICES                              │
│  ┌───────────────────────────┐  ┌────────────────────────────────────────┐   │
│  │ Location & Privacy Engine │  │ Intent Graph & Search Orchestration    │   │
│  │ (device-local GPS → cell) │  │ (intent routing · adaptive radius)     │   │
│  └───────────────────────────┘  └────────────────────────────────────────┘   │
│  ┌─────────┐ ┌──────────────────────┐ ┌───────────────┐ ┌────────────────┐   │
│  │ Ranking │ │ Provider Abstraction │ │ AI Interfaces │ │ Notifications  │   │
│  └─────────┘ └──────────────────────┘ └───────────────┘ └────────────────┘   │
│  ┌────────────────┐ ┌──────────────┐ ┌───────────────┐ ┌────────────────┐    │
│  │ Data & Caching │ │ Offline Sync │ │ API Contracts │ │ Flags · Config │    │
│  │                │ │              │ │               │ │ · Observability│    │
│  └────────────────┘ └──────────────┘ └───────────────┘ └────────────────┘    │
│  Datastores (v1): PostgreSQL (server) · IndexedDB (client). Nothing else.    │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 1.2 Service inventory

| Service | Responsibility (one line) | Chapter |
|---|---|---|
| Location & Privacy Engine | Keep precise GPS device-local; emit only cell-snapped, offset-rotated public positions; hidden mode transmits nothing | [02-LOCATION-PRIVACY-ENGINE](02-LOCATION-PRIVACY-ENGINE.md) |
| Intent Graph & Search Orchestration | Accept published intents from every surface; route one query across all sources with adaptive radius; return "the nearest solution" | [03-INTENT-GRAPH-AND-SEARCH](03-INTENT-GRAPH-AND-SEARCH.md) |
| Ranking Service | Deterministic, explainable scoring with per-surface weight profiles, scoreBreakdown, and id tie-break | [04-RANKING-SERVICE](04-RANKING-SERVICE.md) |
| Provider Abstraction | Ports/adapters over external providers; whitelist normalization; failover on quality/latency/privacy/cost; no secrets client-side | [05-PROVIDER-ABSTRACTION](05-PROVIDER-ABSTRACTION.md) |
| AI Interfaces | Assistive, interface-first seams (query intent, future assistant); AI understands, the ranking engine decides; no LLM activation | [06-AI-INTERFACES](06-AI-INTERFACES.md) |
| Notification Service | Match/digest notifications above a threshold, batched, content-minimal, privacy-safe | [07-NOTIFICATION-SERVICE](07-NOTIFICATION-SERVICE.md) |
| Data & Caching | Database boundaries, cache tiers, TTLs, retention windows | [08-DATA-AND-CACHING](08-DATA-AND-CACHING.md) |
| Offline Synchronization | IndexedDB-backed offline behaviour, queued writes, honest staleness on reconnect | [09-OFFLINE-SYNC](09-OFFLINE-SYNC.md) |
| API Contracts | Versioned request/response and event shapes; explicit result states shared by every surface | [10-API-CONTRACTS](10-API-CONTRACTS.md) |
| Feature Flags, Configuration & Observability | Compile-time activation (ADR-015/016), runtime tuning in three config classes, audit and telemetry | [11-FLAGS-CONFIG-OBSERVABILITY](11-FLAGS-CONFIG-OBSERVABILITY.md) |

Cross-cutting chapters: [12-SCALABILITY](12-SCALABILITY.md) (budgets and load
model) and [13-IMPLEMENTATION-MAP](13-IMPLEMENTATION-MAP.md) (reuse, migration,
sequencing, gates).

## 1.3 The Intent Graph (owner directive)

**Exchange is a platform service, not a module.** The owner's directive
(2026-08-03, recorded in proposed
[ADR-023](../../adr/023-exchange-platform-service-intent-graph.md)): Exchange
must not become one more self-contained screen. It becomes the **universal
Intent Graph** — a publish/consume service boundary through which *every* Spot
Me surface expresses what people **need** and what is **available** near them.
An intent is a structured, privacy-filtered statement (`need` or `offer`, with
category, coarse location, availability window, and consent scope) — never raw
content and never a precise position.

Every surface is a publisher:

| Publisher surface | Example intent published into Exchange |
|---|---|
| Smart Nearby Discovery Map | Nearby business — "pharmacy, open now, ~600 m" becomes a discoverable *offer* |
| Live Nearby Events | Tickets — "two spare tickets for tonight's concert" |
| Nearby Moments | "I have camping gear" — a moment's caption becomes a consented *offer* |
| Business Platform | Inventory — "turbocharger in stock at AutoParts Käpylä" |
| Communities & Channels | "Volunteer needed Saturday" — a group post becomes a *need* |
| Messaging | "My friend needs a phone charger" — surfaced only with explicit consent |

**Organize by intent, not by type.** Today's information systems silo by
content type: businesses in one index, listings in another, events in a third,
friends' needs nowhere. The Intent Graph inverts that. One query — *"I need a
turbocharger"* — is parsed once (deterministic intent interface, chapter
[06](06-AI-INTERFACES.md)), then searched across **businesses, individuals,
marketplace listings, nearby requests, groups, consented friends, business
inventory, events, and AI recommendations** in a single orchestration
([03-INTENT-GRAPH-AND-SEARCH](03-INTENT-GRAPH-AND-SEARCH.md)), ranked by one
transparent engine ([04](04-RANKING-SERVICE.md)), and answered with **"the
nearest solution"** — which may be a shop 2 km away, a neighbour selling one,
or a garage offer published an hour ago. The product framing lives in the
[Exchange PRD](../../handbook/product/exchange/README.md) (esp.
[04-MATCHING-AND-RANKING](../../handbook/product/exchange/04-MATCHING-AND-RANKING.md));
this spec provides the engineering contracts beneath it.

## 1.4 Design tenets (constitution digest)

Every chapter of this spec is bound by the constitution
(roadmap v2.0 §2; [DISCOVERY-PROGRAMME](../../handbook/product/DISCOVERY-PROGRAMME.md)):

1. **Precise GPS is always device-local**
   ([ADR-019](../../adr/019-discovery-v2-privacy-model.md)); public location is
   approximate by default — ~500 m cell, rotating bounded offset ≤150 m per
   30 min ([ADR-018](../../adr/018-deterministic-location-grid.md)); hidden
   mode transmits nothing; exact position is never recoverable from markers,
   logs, events, or DOM.
2. **Provider-neutral** ([ADR-017](../../adr/017-provider-neutral-adapters.md)):
   ports/adapters, whitelist normalization, `assertNoSecrets`, no vendor hard
   dependency; route and fall back on quality, latency, privacy, cost.
   Authorized sources only.
3. **Compile-time dark shipping**
   ([ADR-015](../../adr/015-compile-time-feature-flags.md)/[016](../../adr/016-dark-shipping.md)):
   flags default false, hard master gate, tree-shaken, fence-tested.
4. **Transparent deterministic ranking:** explicit weights, scoreBreakdown,
   tie-break by id; **proximity outranks popularity** (validated invariant);
   no sensitive-trait inference; personalization strictly opt-in.
5. **AI is assistive and interface-first:** AI understands intent; the ranking
   engine decides; no LLM or assistant activation without owner authorisation.
6. **Honesty:** explicit result states
   (loading/ok/partial/empty/unavailable/failed/superseded); never fabricate
   ETAs, events, matches, or counts; disclose radius expansion; a straight
   line is never presented as a route.
7. **Deterministic testing:** inject clock, seed, and config; supersede/cancel
   guards (epoch + AbortSignal).
8. **v1 datastores:** PostgreSQL plus client-side IndexedDB — see §1.6.

**Deterministic testing (platform-wide note).** Every service chapter names
its injected inputs (clock/seed/config) and its pinned tests. Platform-level:
fence tests prove dark subsystems are unreachable and tree-shaken
(`*-not-shipped.test.js`); mutation-style tests prove precise coordinates
cannot leak past the privacy engine; invariant tests pin weights-sum-to-1,
proximity-outranks-popularity, and strictly ascending radius steps.

## 1.5 Current state — honest

Nothing below is on `master`; draft PRs #60/#61 are open and unmerged. The
discovery-v2 and live-events **engines** are dark (flag-off, fenced,
tree-shaken) even on their branches — but with one deliberate exception:
`geo-approx.js` and the `discovery.js` presence boundary are **live-path
privacy code**, not flag-gated, and take effect the moment #60 merges (they fix
the v1 precise-GPS defect; [ADR-019](../../adr/019-discovery-v2-privacy-model.md)).
Repo paths are branch paths, cited `[REUSE]` because the code is real and
reviewed.

| Service | Today | Evidence |
|---|---|---|
| Location & Privacy Engine | **Implemented on draft PR #60 — live-path on merge, not flag-gated** (the privacy fix activates with the merge itself) | `[REUSE]` `spotme/web/src/lib/geo-approx.js` (draft PR #60): 500 m cell snap, 30 min rotating window, ≤150 m bounded offset, deterministic from (id, window) |
| Intent Graph & Search Orchestration | Search orchestration + adaptive radius **dark**; the Intent Graph itself **green-field** (ADR-023 Proposed) | `[REUSE]` `spotme/web/src/lib/discovery-v2/{search,radius}.js` (PR #60), `spotme/web/src/lib/live-events/search.js` (PR #61) |
| Ranking Service | Two **dark** weight profiles exist | `[REUSE]` `spotme/web/src/lib/discovery-v2/ranking.js` (PR #60), `spotme/web/src/lib/live-events/ranking.js` (PR #61) |
| Provider Abstraction | Provider seams + whitelist normalization **dark** within the two engines; no shared package yet | `[REUSE]` `spotme/web/src/lib/discovery-v2/{search,directions,people}.js`, `spotme/web/src/lib/live-events/{search,detail,safety}.js` |
| AI Interfaces | Deterministic query-intent seam **dark** (no LLM, no network) | `[REUSE]` `spotme/web/src/lib/discovery-v2/intent.js` (PR #60) |
| Notification Service | **Green-field** for Discovery (the separate push-platform draft PRs #48/#52 are prior art, not Discovery code) | — |
| Data & Caching | **Green-field** (retention/TTL values proposed in ch. [08](08-DATA-AND-CACHING.md)) | — |
| Offline Synchronization | **Green-field** for Discovery (messaging's IndexedDB media baseline is merged prior art) | — |
| API Contracts | Result-state + model contracts **dark** in both engines | `[REUSE]` `spotme/web/src/lib/discovery-v2/contracts.js`, `spotme/web/src/lib/live-events/{contracts,time,linking}.js`, map-state sync `discovery-v2/mapstate.js` |
| Feature Flags, Configuration & Observability | Compile-time flag pattern **dark and proven** (layered flags, inert engines, fences); runtime config service **green-field** | `[REUSE]` `spotme/web/src/lib/discovery-v2/{flags,index}.js`, `spotme/web/src/lib/live-events/{flags,index}.js` |

Surfaces: Map (step 1) and Events (step 3) have the dark foundations above;
Exchange (step 2), Moments (step 4), and AI Assistant (step 5) have **no code**.
Authoritative status:
[03-IMPLEMENTATION-STATUS](../../handbook/03-IMPLEMENTATION-STATUS.md).

## 1.6 Non-goals (v1)

- **No PostGIS, no H3, no new datastores introduced by Discovery.** Geo
  indexing uses discretized cells over PostgreSQL; client persistence is
  IndexedDB. The platform's target realtime layer (Socket.IO + Redis adapter,
  per the canonical migrated build memory) is a platform concern — Discovery
  does not add a Redis/Dragonfly datastore of its own.
- **No LLM or assistant activation.** AI interfaces ship as deterministic
  seams only ([06-AI-INTERFACES](06-AI-INTERFACES.md)); activation requires
  separate owner authorisation.
- **Personalization is off.** Nothing profiles users; opt-in, explainable
  personalization is step 5 and is not built here.
- **No scraping.** Authorized, licensed sources only; where evidence is
  insufficient the platform says so rather than inventing content.
- **No activation of any kind by this spec.** Documentation only; ships dark
  when built ([ADR-016](../../adr/016-dark-shipping.md)); activation is a
  separate owner-authorised change per surface.
