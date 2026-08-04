# Exchange Platform — Backend & Persistence (Phase 3B, as built)

> **Status: Implemented (Draft PR — DARK).** The dark `ExchangeModule` and its
> additive PostGIS persistence. NOT imported by `AppModule` — no `/v1/exchange`
> route exists until an owner-authorized activation. Business participation is a
> dark seam (D4): the table exists, no business flow is reachable (individuals-
> only v1).

## Persistence (`backend/prisma/schema.prisma` + migration `20260804120000_exchange_backend`)

Five additive tables, mirroring the Phase 2 coarse-spatial representation:

| Model | Holds | Notes |
|---|---|---|
| `ExchangeIntent` | need/offer/service item | coarse `coarseLat/Lon/Cell` + `geography(Point,4326)` (`geog`, GIST-indexed); `versionSeq` (optimistic concurrency); `@@unique([ownerId, idempotencyKey])`; `expiresAt`; no age/gender/payment column |
| `ExchangeSearchProjection` | sanitized public search projection | labels + coarse cell only — never coordinates/private/PII (T-EX-19) |
| `ExchangeLifecycleEvent` | append-only audit | closed reason codes, no free text |
| `ExchangeMatchProjection` | need↔offer match | `epoch` supersede guard; distance is a band; `@@unique([needId, offerId])` |
| `ExchangeBusinessParticipation` | business seam | DARK — no reachable flow (D4) |

The `geog` GIST index is raw-SQL-managed (Prisma-`Unsupported` column); the
migration header documents the drift caveat and deliberately does not drop the
discovery GIST index. `ON DELETE CASCADE` removes a user's intents, lifecycle,
matches and projections with the account.

## Module (`backend/src/exchange/`)

`ExchangeController` (`/v1/exchange`, `JwtAuthGuard`, principal-keyed) →
`ExchangeService` (lifecycle engine) → `ExchangeIntentRepository` port
(`PrismaExchangeIntentRepository`). `ExchangeModule` is **not** imported by
`AppModule`.

Guarantees, each pinned by a test:

- **Privacy boundary** (`exchange.policy.ts`): precise-shape refusal, exact-key
  allow-list (an `age`/`gender`/`priceAmount` field is `UNSUPPORTED_FIELD`, A3 +
  no-payments), WGS84 range, server-side re-quantization to the coarse grid, and
  a server-computed bounded TTL. `validateIntentInput` is the only path a
  coordinate enters — stored values are coarse by construction.
- **Idempotent create**: a repeated `(ownerId, idempotencyKey)` returns the same
  row (`idempotentReplay: true`).
- **Optimistic concurrency**: every mutation carries `expectedVersion`; a stale
  version raises `VERSION_CONFLICT` (enforced by a `versionSeq`-guarded
  `updateMany` in a transaction).
- **Closed lifecycle** (`EXCHANGE_TRANSITIONS`): draft → active → paused/matched
  → fulfilled/expired/withdrawn/removed; an illegal jump is `ILLEGAL_TRANSITION`.
  Every transition appends a lifecycle-event audit row atomically.
- **Ownership isolation**: a non-owner gets a uniform `NOT_FOUND` (never a
  distinct `FORBIDDEN` that would leak existence).
- **Discoverable query** keeps every exclusion in SQL — hidden, removed,
  expired, and self intents are never fetched; keyset pagination on
  `(createdAt, id)` with a signed depth-bounded cursor (no OFFSET, no total
  count).

## Tests

- `backend/test/exchange-policy.spec.ts` (15) — validation refusals, cursor
  signing/depth, transition table, lifecycle engine with in-memory fakes.
- `backend/test/exchange-lifecycle.e2e-spec.ts` (8, real PostGIS) — idempotency,
  geography write, per-transition audit, optimistic concurrency, ownership
  isolation, discoverable exclusions, keyset stability, retention.
- Migrations verified on a **clean** PostGIS DB and on an **upgraded** populated
  DB (existing rows preserved; both GIST indexes present).

## Non-goals (3B)

No matching/ranking (Phase 3C), no search index wiring, no UI (3D), no route,
no activation. Nothing is imported into the running application.

---

## Phase 3C — Matching, search & ranking (as built)

- **Matching engine** (`backend/src/exchange/exchange.matching.ts`): a CLOSED
  `EXCHANGE_MATCH_SIGNALS` registry (`intentFit`, `proximity`, `availability`,
  `trust`, `freshness`) with [PROPOSED] weights. `safetyEligible` is a HARD GATE
  applied before scoring; a `sponsored`/`popularity` signal (or an out-of-range
  weight) throws (`ExchangeClosedRegistryError`/`ExchangeWeightError`); unknown
  evidence contributes exactly 0; proximity is weighted so a closer viable
  counterpart beats a popular-but-distant one; every match carries a full
  `ExchangeMatchExplanation` whose total equals the sum of weighted components.
- **Search projection** (`exchange.search.ts`): `toSearchProjection` is an
  allow-list builder — the indexed doc has exactly `{id, kind, category, title,
  normalizedText, intentLabels, coarseCell}` and NO coordinate field; coordinate-
  shaped tokens are stripped from the title, labels, AND the searchable text, so
  no owner id / budget / price / precise field / coordinate can reach the index
  (T-EX-19). `orderExchangeHits` pins exact public-identifier matches ahead of
  fuzzy hits. The default `ExchangeSearchPort` adapter is UNCONFIGURED — typed
  `provider-unavailable`, no network — and bound in the (dark) module.
- **Tests** (`backend/test/exchange-matching.spec.ts`, 12): closer-beats-distant,
  safety-exclusion-always-wins, unavailable-cannot-be-promoted, unknown-evidence-
  no-benefit, sponsored-rejected, exact-outranks-fuzzy, no-coordinate-in-index,
  no-prohibited-field-in-projection.
