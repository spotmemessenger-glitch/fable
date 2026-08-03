# 10 — API Contracts

> Part of the [Discovery Platform Architecture Specification](README.md).
> Engineering spec — draft for owner review (stacked PR; documentation only,
> nothing here activates code). Numeric values are [PROPOSED] config defaults.

## 10.1 One contract source — and what exists today (honest)

Every Discovery surface speaks the same wire conventions, defined **once**, in
**typed, versioned contracts shared client↔server from `packages/contracts`**
of the target monorepo (migrated build memory §2.1/§2.3). The rule is the
memory's own: **no duplicated domain contracts between client and server** — a
shape is written once, imported by both sides, and validated on both sides
(§10.10). Surfaces add *entities* (a Place, an EventRecord, an Exchange item);
they never add private envelope, error, paging, or realtime conventions.

Honesty about today: `packages/contracts` **does not exist yet** — no code.
What exists is the behavioural reference, dark on unmerged draft PRs:
`[REUSE]` `spotme/web/src/lib/discovery-v2/contracts.js` (draft PR #60) and
`[REUSE]` `spotme/web/src/lib/live-events/contracts.js` (draft PR #61) define
the result states, the normalisation boundary, and `assertNoSecrets`; the
[Exchange PRD ch 08](../../handbook/product/exchange/08-API-CONTRACTS.md) is
the worked endpoint example, itself `[PROPOSED]` pending A5 ratification.
Migration of these into `packages/contracts` is sequenced in
[13-IMPLEMENTATION-MAP](13-IMPLEMENTATION-MAP.md).

## 10.2 The standard result envelope

Every search/list answer is the same envelope, on every surface:

```jsonc
{
  "state":    "ok",          // one of the seven states, §10.3
  "results":  [ ... ],        // typed entities; ranked results carry score + rankReason
  "radiusKm": 15,             // the radius that produced the answer — expansion DISCLOSED
  "cursor":   "opaque|null"   // next page, §10.5; null ⇒ no more
}
```

`[REUSE]` grounding: the dark client engine already returns
`{ state, results, radiusKm, query, providerErrors }`
(`spotme/web/src/lib/discovery-v2/search.js`, draft PR #60); the wire envelope
standardises that shape and adds `cursor`
([Exchange PRD §8.3](../../handbook/product/exchange/08-API-CONTRACTS.md)).
`radiusKm` is not decoration — it is how the honesty rule "disclose radius
expansion" reaches the UI ([03-INTENT-GRAPH-AND-SEARCH §3.6](03-INTENT-GRAPH-AND-SEARCH.md)).
Ranked results carry `score` and `rankReason` rendered from `scoreBreakdown` —
the wire form of the explainability rule
([04-RANKING-SERVICE §4.5](04-RANKING-SERVICE.md)); sponsored slots are a
separate, labelled contract type, never mixed into `results`
([04-RANKING-SERVICE §4.9](04-RANKING-SERVICE.md)).

## 10.3 The seven result states

The platform state set is the union defined by the dark contracts
(`[REUSE]` `discovery-v2/contracts.js` — six; `live-events/contracts.js` adds
`loading`): `loading · ok · partial · empty · unavailable · failed ·
superseded`. Exact semantics are specified once, in
[03-INTENT-GRAPH-AND-SEARCH §3.8](03-INTENT-GRAPH-AND-SEARCH.md); this chapter
fixes their **wire discipline**:

- A server response body carries only the five terminal server states
  `ok | partial | empty | unavailable | failed`.
- `loading` (in flight) and `superseded` (a newer query's epoch replaced this
  one, [03-INTENT-GRAPH-AND-SEARCH §3.7](03-INTENT-GRAPH-AND-SEARCH.md)) are
  **client-envelope states** — assigned by the client runner, never sent by
  the server. The full seven-state union is the UI contract.
- The state enum is **closed**: adding a state is a breaking change (§10.9).
  `unavailable` and `empty` are honest answers — never padded, never faked.

## 10.4 The normalized error envelope

Every error, on every endpoint, is `{ code, message, retryable }`
([Exchange PRD §8.6](../../handbook/product/exchange/08-API-CONTRACTS.md)):

- `code` — a stable, documented, machine-readable string from a registered
  set (e.g. `VALIDATION_FAILED`, `NOT_FOUND`, `RATE_LIMITED`,
  `CURSOR_EXPIRED`, `CONSENT_REQUIRED`, `PROVIDER_UNAVAILABLE`). Codes are
  contract; copy is not.
- `message` — human-safe, localisable, and **generic at the provider seam**.
- `retryable` — drives client backoff honestly; `429` responses include
  backoff guidance.

**Never leaks provider internals or secrets.** Provider errors are normalised
at the adapter boundary ([05-PROVIDER-ABSTRACTION §5.6](05-PROVIDER-ABSTRACTION.md));
no upstream status text, vendor error body, endpoint URL, or credential echo
crosses the seam — the same whitelist-and-drop discipline as
`normalizePlace`/`assertNoSecrets` (`[REUSE]`
`spotme/web/src/lib/discovery-v2/contracts.js`, [ADR-017](../../adr/017-provider-neutral-adapters.md)).

## 10.5 Writes and reads — idempotency and cursors

**Every mutating endpoint takes an idempotency key** (memory §2.3): the client
sends a per-operation key; the server stores `key → outcome` for a bounded
window and replays the stored outcome on retry — a retried create never makes
two items, and side effects ride the transactional outbox so a replay never
re-notifies ([07-NOTIFICATION-SERVICE §7.7](07-NOTIFICATION-SERVICE.md)).
`api.idempotency.windowHours` `[PROPOSED]` 24, class `ops`.

**Every list is cursor-paginated with bounded pages** — no offsets. Cursors
are opaque, encode a position in a **total order** (ranking's tie-break by id
makes every ordering total — [04-RANKING-SERVICE §4.6](04-RANKING-SERVICE.md)),
and expire honestly (`CURSOR_EXPIRED`, `retryable: false` → restart the
query). `api.page.defaultSize` `[PROPOSED]` 20 · `api.page.maxSize`
`[PROPOSED]` 50, class `ops`; both register in the config registry
([11-FLAGS-CONFIG-OBSERVABILITY §11.5](11-FLAGS-CONFIG-OBSERVABILITY.md)).

## 10.6 Endpoint namespaces

One REST grammar per surface, versioned at the path
(memory §2.3: REST for request/response, WebSocket gateway for realtime):

| Namespace | Surface | Status |
|---|---|---|
| `/v1/discovery` | Smart Nearby Discovery Map — places, people markers, directions | `[PROPOSED]` (behaviour dark client-side, draft PR #60; no API exists) |
| `/v1/events` | Live Nearby Events | `[PROPOSED]` (behaviour dark client-side, draft PR #61; no API exists) |
| `/v1/exchange` | SpotMe Exchange / Intent Graph | `[PROPOSED]` — worked example below |
| `/v1/moments` | Nearby Moments | **Future** — namespace reserved; nothing defined until the mission is approved |

The **worked example** is `[REUSE]`
[Exchange PRD ch 08](../../handbook/product/exchange/08-API-CONTRACTS.md):
items CRUD with idempotency keys, `POST /v1/exchange/search` returning the
§10.2 envelope, ranked matches with `rankReason`, and consent-gated
`POST /v1/exchange/handoff` — every future namespace follows that grammar
(`POST /v1/<surface>/search`; resource nouns; explicit consent endpoints).

## 10.7 Realtime conventions — REST is the source of truth

Realtime rides the platform WebSocket gateway (memory §2.4); Discovery adds
conventions, not infrastructure:

- **Channel naming**: `<surface>.<entity>.<event>` — e.g.
  `exchange.match.proposed`, `exchange.item.status`
  (`[REUSE]` [Exchange PRD §8.4](../../handbook/product/exchange/08-API-CONTRACTS.md)).
- **Epoch-tagged, supersede-safe payloads**: every push carries the subject's
  epoch/version; clients apply the same discipline as search — a stale push
  never renders over fresher state
  ([03-INTENT-GRAPH-AND-SEARCH §3.7](03-INTENT-GRAPH-AND-SEARCH.md)).
- **Cursor replay** on reconnect (durable, bounded), **bounded queues and
  backpressure**, **idempotent processing** — memory §2.4.
- **REST state is the source of truth.** A push is an accelerant; a missed
  push is a missed acceleration, never missed data — state is correct on next
  fetch/reconciliation ([09-OFFLINE-SYNC](09-OFFLINE-SYNC.md),
  [07-NOTIFICATION-SERVICE §7.7](07-NOTIFICATION-SERVICE.md)).

## 10.8 Wire privacy rules — absolute

Bound by [ADR-018](../../adr/018-deterministic-location-grid.md)/
[ADR-019](../../adr/019-discovery-v2-privacy-model.md) and
[02-LOCATION-PRIVACY-ENGINE](02-LOCATION-PRIVACY-ENGINE.md):

1. **No precise coordinate ever crosses the wire** — not in a request body,
   response, realtime payload, header, URL, or error. Public objects carry
   **approximate positions only**, coarsened **on-device before send**
   (§2.2; markers flagged `approximate: true`).
2. **Search sends a coarse origin** (cell-snapped) — never the raw fix. The
   precise fix is device-local; `distanceM` is computed device-side. (For the
   *provider* port this coarse-only typing is a `[PROPOSED]` tightening beyond
   current dark-code behaviour — [02 §2.4](02-LOCATION-PRIVACY-ENGINE.md); for
   the `[PROPOSED]` server APIs above it is a design rule from day one.)
3. **Escalation only through consent-gated endpoints**: anything finer than
   the public approximation moves only via an explicit, revocable,
   per-interaction consent call (`POST /v1/exchange/handoff { matchId,
   consent }` — §2.5; [exchange/07-PRIVACY](../../handbook/product/exchange/07-PRIVACY.md)).
   No read endpoint returns another user's exact coordinates or more identity
   than the approved public projection.
4. Hidden/ghost mode transmits **no** position at all; contract types mark
   location fields coarse-only (`[PROPOSED]` typed tightening, §2.4) so the
   compiler, not discipline, holds the boundary.

## 10.9 Versioning and deprecation `[PROPOSED]`

- **Major version in the path** (`/v1/...`); the `packages/contracts` package
  is semver-versioned and is the single change point.
- **Within a major, changes are additive only**: new optional fields, new
  endpoints. Removing/renaming fields, changing semantics, or widening closed
  enums (result states, error codes clients must branch on) is **breaking** →
  new major namespace, dual-served beside the old.
- **Deprecation is announced in-band** (`Deprecation`/`Sunset` headers and
  changelog) and old majors are served for
  `api.deprecation.windowDays` `[PROPOSED]` 90 (class `product`); removal is
  an owner-visible change, never silent.
- Clients ignore unknown *fields* (forward-compatible) but treat unknown
  *states/codes* as `failed`/non-retryable — honest degradation, no guessing.

## 10.10 Contract tests — mismatch fails CI

- **One schema source** in `packages/contracts`; server DTO validation
  (class-validator, memory §2.3) and client-side parsing are both **derived**
  from it — hand-copied shapes are the defect this chapter exists to prevent.
- **Both sides validate at the boundary**: the server rejects malformed
  requests (`VALIDATION_FAILED`); the client validates responses in dev/test
  builds against the same schema.
- **Golden fixtures** round-trip every envelope, entity, error, and realtime
  payload; a producer/consumer schema mismatch **fails CI** — a wire drift is
  a build failure, not a field incident.
- The dark modules already carry the seed of this suite `[REUSE]`:
  `spotme/web/test/discovery-v2-*.test.js` and
  `spotme/web/test/live-events-*.test.js` (draft PRs #60/#61) pin
  normalisation, states, and the no-secrets guard today.

## 10.11 Deterministic testing

**Injected:** clock (idempotency-window and cursor expiry), fixed fixtures and
explicit ids (no randomness in contracts), config (page bounds, windows) as
plain objects. **Mutation/invariant tests pin:** a coordinate-precision
scanner over every serialised envelope, event payload, and error fixture fails
on any location finer than the approximation bound (the
[02 §2.7](02-LOCATION-PRIVACY-ENGINE.md) boundary suite, extended to the
wire); a secret-shaped-key scan on every payload (`assertNoSecrets` pattern
`[REUSE]` `spotme/web/src/lib/discovery-v2/contracts.js`); replaying a write
with the same idempotency key yields the same outcome exactly once; walking
all cursors of a fixed dataset yields each result exactly once in a stable
order; each of the five server states is reachable and exclusive, and no
server fixture ever carries `loading`/`superseded`; and schema round-trip of
every golden fixture — the CI gate of §10.10 as an executable assertion.
