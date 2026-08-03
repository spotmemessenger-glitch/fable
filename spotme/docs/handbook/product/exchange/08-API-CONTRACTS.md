# 08 — API Contracts

> Reconstruction pending A5 ratification. Shapes `[PROPOSED]`, targeting the
> canonical architecture (NestJS REST + WebSocket gateway, typed contracts in
> `packages/contracts`). Provider-neutral ports for all external calls.

## 8.1 Principles

- **Typed, versioned contracts** shared client↔server from `packages/contracts`
  (no duplicated domain types).
- **REST** for request/response; **WebSocket** for live match/state updates.
- **Approximate location only** crosses the wire for public objects; the precise
  fix stays on-device (§07). The client sends a **coarse origin** for search.
- **Idempotency keys** on writes; **cursor pagination** on lists; normalized
  error envelope; every provider call has timeout/cancel/retry/circuit-breaker/
  cost-accounting (`MIGRATED_BUILD_MEMORY` §2.3).

## 8.2 REST endpoints `[PROPOSED]`

```
POST   /v1/exchange/items                 # create Need or Offer (idempotency-key)
GET    /v1/exchange/items/:id             # read one (authz: owner or public-approx view)
PATCH  /v1/exchange/items/:id             # edit (owner) — status, fields
DELETE /v1/exchange/items/:id             # withdraw/delete (owner)
GET    /v1/exchange/items                 # my items (filters: type,status,cursor)

POST   /v1/exchange/search                # unified/exchange search (see 8.3)
GET    /v1/exchange/items/:id/matches     # proposed matches for my item (ranked)
POST   /v1/exchange/matches/:id/accept    # accept → begins handoff
POST   /v1/exchange/matches/:id/decline   # decline/dismiss (feeds non-sensitive signal)

POST   /v1/exchange/items/:id/report      # safety report
POST   /v1/exchange/handoff               # {matchId, consent} → creates a knock (reach.js)
```

## 8.3 Request/response shapes `[PROPOSED]`

```jsonc
// POST /v1/exchange/items
{
  "type": "need",                       // "need" | "offer"
  "category": "services/plumbing",
  "text": "Leaking kitchen tap, need it fixed tonight",
  "timeframe": { "from": "2026-08-03T18:00:00Z", "to": "2026-08-03T23:00:00Z" },
  "budgetBand": "low",                  // optional, banded not exact
  "radiusKm": 10,
  "locationPrecision": "approximate",   // approximate | neighbourhood | exact-on-connect
  "approxLocation": { "lat": 12.9716, "lon": 77.5946 }, // ALREADY coarsened on-device
  "expiresInHours": 24
}
// -> 201 { "id": "...", "status": "active", "state": "active", ... }  (no precise coords ever)

// POST /v1/exchange/search
{ "text": "fix a leaking tap tonight", "type": "offer",
  "origin": { "lat": 12.97, "lon": 77.59 },   // coarse origin
  "filters": { "category": "services/plumbing", "openNow": true }, "cursor": null }
// -> { "state": "ok|partial|empty|unavailable|failed", "results": [ ... ], "radiusKm": 10, "cursor": "..." }
```

- **Match object** returned to the owner includes `score` and `rankReason`
  (component breakdown, §04) for the explainable rationale.
- **No endpoint** returns another user's exact coordinates or identity beyond the
  approved public projection; the handoff endpoint is the only path to escalate,
  and only with `consent`.

## 8.4 Realtime (WebSocket) `[PROPOSED]`

- `exchange.match.proposed` / `exchange.match.updated` — live match changes for
  the owner's active items (supersede-safe, epoch-tagged).
- `exchange.item.status` — status transitions (matched/resolved/expired/removed).
- Backpressure, idempotent processing, cursor replay `[REUSE]` the realtime
  gateway (`MIGRATED_BUILD_MEMORY` §2.4). Realtime is an accelerant; REST state is
  the source of truth.

## 8.5 Provider-neutral ports `[PROPOSED]`

Defined in `packages/provider-sdk`; adapters normalise to stable Spot Me models
(ADR-017); credentials in closures/injected config, never on the wire or object:

- **IntentPort** — `parse(text) → structuredIntent`, `similarity(a,b) → [0,1]`.
- **SafetyPort** — `classifyText/Image(...) → {labels, score}`.
- **GeoPort** — coarse geocode/reverse within privacy limits.
- **NotificationPort** — push fan-out `[REUSE]` push platform.

No port is a hard dependency; route/fall back on quality, latency, availability,
cost. All are **interface-first**; model activation requires owner authorisation.

## 8.6 Errors & limits

- Normalized error envelope `{ code, message, retryable }`; never leaks provider
  internals or secrets.
- Rate limits and quotas per §06; `429` with backoff guidance.
- All list endpoints cursor-paginated with bounded page sizes.
