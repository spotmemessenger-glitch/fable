# 05 — Provider Abstraction

> Part of the [Discovery Platform Architecture Specification](README.md).
> Engineering spec — draft for owner review (stacked PR; documentation only,
> nothing here activates code). Numeric values are [PROPOSED] config defaults.

## 5.1 Service responsibilities and target home

Every external capability Discovery consumes — maps, POIs, events, routing,
geocoding, safety classification, intent parsing, push delivery — is reached
through a **port** (a small provider-neutral contract) implemented by
**adapters** (one per vendor). The rest of the platform sees only stable
Spot Me models; no vendor shape, endpoint, or credential leaks upward
([ADR-017](../../adr/017-provider-neutral-adapters.md), Accepted).

Target home: **`packages/provider-sdk`** in the canonical TypeScript monorepo
(canonical migrated build memory §2.1 — "provider-neutral AI, map,
notification and media ports"), consumed by `apps/api` and `apps/web`.
Secret-bearing providers are called **only from controlled backend proxies**
(memory §2.11); no provider secret, private endpoint, or privileged token ever
reaches a browser bundle (memory §2.1).

Honesty about today: **no `packages/provider-sdk` exists.** What exists are
dark JavaScript modules on unmerged draft PRs #60/#61
(`spotme/web/src/lib/discovery-v2/`, `spotme/web/src/lib/live-events/`) that
implement this chapter's contracts in miniature. They are **behaviour-proven
precursors**, cited `[REUSE]` below; the migration of their behaviour into the
shared package is sequenced in
[13-IMPLEMENTATION-MAP](13-IMPLEMENTATION-MAP.md). Nothing runs on `master`.

## 5.2 Provider classes

| Class | Port operation (shape) | Consumed by | Today — honest |
|---|---|---|---|
| Map / POI | `search(query, ctx) → Promise<candidate[]>` | Map surface; Intent Graph pull source ([03 §3.4](03-INTENT-GRAPH-AND-SEARCH.md)) | Dark port + orchestration `[REUSE]` `spotme/web/src/lib/discovery-v2/search.js` (draft PR #60) |
| Events | `searchEvents(query, ctx) → Promise<candidate[]>`; optional `detail(event)` enrichment | Events surface | Dark `[REUSE]` `spotme/web/src/lib/live-events/{contracts,search,detail}.js` (draft PR #61) |
| Directions | `route(from, to, {signal}) → Promise<{durationS?, distanceM?, geometry?}>` | Map; any surface offering "take me there" | Dark `[REUSE]` `spotme/web/src/lib/discovery-v2/directions.js` (PR #60) — no router ⇒ honest straight-line, never a fabricated ETA |
| Geocoding | `geocode(text)` / `reverse(lat, lon)` | Search (address input), Intent Graph | **[PROPOSED]** — no code exists |
| Safety classification | `classify(record) → {restricted, unsafe, reasons}` | Events, Moments, Exchange moderation ([exchange/06](../../handbook/product/exchange/06-MODERATION-AND-FRAUD.md)) | Port **[PROPOSED]**; dark precursor is the injected-predicate filter `[REUSE]` `spotme/web/src/lib/live-events/safety.js` (PR #61) |
| Intent / embedding | `parse(text)` — synchronous, pure ([06-AI-INTERFACES](06-AI-INTERFACES.md)); embedding port future | Search pipeline ([03 §3.5](03-INTENT-GRAPH-AND-SEARCH.md)) | Deterministic baseline dark `[REUSE]` `spotme/web/src/lib/discovery-v2/intent.js` (PR #60); embedding **[PROPOSED]**, no code |
| Push notification | transport port (`INotificationTransport`-style: FCM / APNs / Web Push) | [07-NOTIFICATION-SERVICE](07-NOTIFICATION-SERVICE.md) | Prior art: dark push-platform foundation, draft PRs #48/#52 (inert, not Discovery code); canonical port per memory §2.8 |

New classes join by defining a port here; they inherit every rule in this
chapter automatically.

## 5.3 The adapter contract and duck-typed validation

An adapter is a plain object: a public `name` plus the port operation(s).
Registration validates it **duck-typed** — a boolean check, not a throw — so a
malformed adapter is **skipped, never allowed to crash the search**:

- `[REUSE]` `isValidProvider` (`spotme/web/src/lib/discovery-v2/contracts.js`)
  — requires non-empty `name` and a `search` function.
- `[REUSE]` `isValidEventProvider` (`spotme/web/src/lib/live-events/contracts.js`)
  — same discipline for `searchEvents`.
- `[REUSE]` `isValidIntentProvider` (`spotme/web/src/lib/discovery-v2/intent.js`).

The registry filters on validity, then runs the credential check (§5.5), which
**does** throw — a malformed adapter is harmless and skippable; a
credential-carrying one is a security defect and fails loud
(`[REUSE]` `createSearch` in `discovery-v2/search.js` applies exactly this
order). A misbehaving adapter at call time degrades, never propagates: its
errors are counted into `partial`/`failed` result states
([03 §3.8](03-INTENT-GRAPH-AND-SEARCH.md)), and a throwing intent provider
degrades to "no enrichment" (`[REUSE]` `deriveIntent`).

## 5.4 The normalisation boundary

Adapters return **candidates**; the boundary turns candidates into **frozen
Spot Me models** by **whitelist copy** — only named fields are read into a
fresh object, and the raw provider payload (API-key echoes, tracking ids,
attribution tokens, billing metadata) **never propagates** into app state,
logs, or the wire:

- `[REUSE]` `normalizePlace` (`spotme/web/src/lib/discovery-v2/contracts.js`):
  whitelists id/name/coords/category/address/rating; clamps lat/lon and
  rating; `raw` is deliberately frozen-empty; a candidate missing the minimum
  (id, name, usable coordinates) yields `null` — never a half-built record.
- `[REUSE]` `normalizeEvent` (`spotme/web/src/lib/live-events/contracts.js`):
  adds time/timezone/lifecycle/attribution; `popularity` is accepted only as
  an explicit bounded figure from the source, never inferred; unsupplied
  fields stay `null` — never guessed.

The generalised intent record ([03 §3.2](03-INTENT-GRAPH-AND-SEARCH.md))
follows the same rule. Stable ids are `${provider}:${providerId}` — the dedup
and tie-break key platform-wide. Nothing downstream of this boundary may ever
receive or store a provider's raw response.

## 5.5 Credential rules

- Credentials live in the **adapter's closure or injected configuration** —
  never as enumerable fields on the adapter object.
- `[REUSE]` `assertNoSecrets` (`spotme/web/src/lib/discovery-v2/contracts.js`)
  **throws** on any secret-shaped own-property (`key`, `apiKey`, `token`,
  `secret`, `password`, `authorization`, `bearer`, `credential`, …) so an
  adapter cannot be serialised into logs, telemetry, or a debug handle with a
  credential aboard. It runs at registration, before any call.
- Secret-bearing or billed providers are proxied through `apps/api`; the
  client holds no provider credential (memory §2.1/§2.11). Client-side
  adapters may exist only for credential-free public endpoints.
- No secret in the repository — injected via the secrets manager (memory
  §2.13).

## 5.6 Resilience — required on every provider call

Per the canonical migrated build memory §2.3, **every** provider call carries:

| Requirement | Rule | Config `[PROPOSED]` (class `ops`) |
|---|---|---|
| Timeout | No call waits unbounded; timeout expiry is a counted provider error, not a crash | `providers.call.timeoutMs` = 5000; per-class override `providers.<class>.timeoutMs` |
| Cancellation | `AbortSignal` threads through every call; supersede/abort resolves `superseded` `[REUSE]` epoch + signal discipline, `discovery-v2/{search,radius}.js` | — (behaviour, not tunable) |
| Retry policy | Idempotent reads only; bounded, jittered backoff; never retries into a superseded query | `providers.retry.max` = 1 |
| Circuit breaker | A failing provider is opened out of rotation and probed on cooldown; open ≠ error — routing simply skips it | `providers.breaker.errorThreshold` = 0.5 · `providers.breaker.cooldownMs` = 30000 |
| Cost accounting | Every call is metered per provider; ceilings alert and then shed to fallbacks | `providers.cost.dailyCeiling` per provider |
| Normalised errors | Vendor errors map to one platform error taxonomy; per-provider failures are counted into the envelope's `partial`/`failed`/`unavailable` states — one provider's outage never throws past the boundary `[REUSE]` `discovery-v2/search.js` | — |

Status: cancellation, error-counting, and honest degraded states exist dark
`[REUSE]`; timeouts, retries, breakers, and cost metering are **[PROPOSED]**
for `packages/provider-sdk`. All numbers are runtime config
([11-FLAGS-CONFIG-OBSERVABILITY](11-FLAGS-CONFIG-OBSERVABILITY.md));
invariants: timeouts and cooldowns positive, threshold in (0, 1], retry count
bounded.

## 5.7 Routing and failover policy

Adapter selection is a routing decision over four measured signals — never a
hardcoded vendor preference (owner principle; roadmap
[v2.0](../../handbook/product/SPOT-ME-PRODUCT-ROADMAP-V2.md);
[ADR-017](../../adr/017-provider-neutral-adapters.md)):

1. **Quality** — result acceptance/coverage per class and region.
2. **Availability** — health checks and breaker state (§5.6).
3. **Cost** — metered spend against ceilings.
4. **Response time** — rolling latency percentiles.

Rules: **no provider is a hard dependency** — every class defines its
degraded answer with zero providers (`unavailable` state; directions fall to
labelled straight-line `[REUSE]`; intent falls to the deterministic baseline
`[REUSE]`). Routing order and weights are runtime config (class `ops`), not
code. Failover is silent to the user in mechanics but honest in results:
states are reported, and fabricating results to mask an outage is prohibited
(constitution). The same routing principle governs AI providers
([06-AI-INTERFACES](06-AI-INTERFACES.md)): accuracy + latency + privacy +
cost, simultaneously.

## 5.8 Licensing — authorized sources only, no scraping

Adapters wrap **licensed, authorized integrations only**. Scraping —
unlicensed harvesting of listings, events, reviews, or POI data — is
prohibited regardless of technical ease. Each adapter records its source
agreement and required attribution; the events attribution record
(`[REUSE]` `live-events/contracts.js` — public provider/source name and URL,
no credentials) is the pattern: every result can credit where it came from so
users can judge trust. Provider licensing review is part of the Wave 8 exit
gate (memory §3) and precedes any activation.

## 5.9 The adapter-change-only rule

Adding, swapping, or removing a provider is **an adapter change only** —
never a change to search, ranking, map, notification, or any surface. The
proof obligation: every port has ≥ 1 fake adapter in the test suite, and the
entire Discovery test suite passes with only fakes configured. If integrating
a new vendor requires touching anything outside its adapter (and config),
the port is wrong and this chapter must be amended first.

## 5.10 Deterministic testing

**Injected:** fake adapters per class (scripted responses, failures,
delays), clock (breaker cooldowns, latency measurement), config (timeouts,
retry/breaker/routing values), `AbortSignal`/epoch. No live provider in CI;
real-provider tests run separately with credentials (memory §4.8).
**Mutation/invariant tests pin:** normalised models carry no raw payload
(a tracking field injected into a candidate must not survive `normalizePlace`
/ `normalizeEvent`); a secret-shaped adapter field throws at registration
(`assertNoSecrets`); a malformed adapter is skipped and the search still
answers; one failing provider yields `partial`, all failing `failed`, none
configured `unavailable` — never a crash, never fabricated results; abort and
supersede between calls resolve `superseded`; the search origin never appears
on any result (`[REUSE]` `assertNoOriginLeak`, `live-events/safety.js`); and
routing under a downed provider selects a fallback without any non-adapter
code change.

## 5.9 As built (Phase 2C — Draft PR, DARK): provider integration guide

Ports: `PlaceSearchPort`, `PlaceDetailsPort`, `DirectionsPort`
(`backend/src/discovery/places/place.ports.ts`). Adapters shipped this phase:
`DeterministicInMemoryPlaceAdapter` (fixtures routed through the SAME
normalizer as any future live provider), `UnavailablePlaceAdapter` (typed
unavailability), `StraightLineDirectionsAdapter` (straight-line distance +
label only — no route, no ETA, no fabricated navigation). The places layer
makes NO network call (C12 fence).

Integrating a real provider later means: implement the port; run every
response through `place.normalize.ts` (**normalize-or-drop** — a result that
cannot be normalized is dropped, never patched; `looksSecretShaped` refuses
credentialed URLs/keys/JWT-shaped strings anywhere in provider payloads);
`openNow` stays `null` unless the provider supplies a boolean (unknown ≠
open — the open-now filter EXCLUDES unknown); attribution is mandatory and
rendered; provider identity is carried in `source`. Provider credentials are
owner-provisioned host-side env only. Amendment A8 binds every adapter:
open-now applies ONLY to place results with authorized provider evidence and
never to people or usernames.
