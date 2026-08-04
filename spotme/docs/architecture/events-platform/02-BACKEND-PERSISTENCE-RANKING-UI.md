# Live Nearby Events — Backend, Persistence, Ranking & UI (Phase 4B–4C)

> **Status: Implemented (Draft PR — DARK).** The dark `EventsModule` + PostGIS
> storage (4B), the transparent ranking engine + inert web-next surface (4C).
> Nothing is imported by `AppModule`, mounted by `App`, wired to a provider, or
> activated.

## 1. Persistence (4B)

Three additive tables (migration `20260804140000_events_backend`, hand-written;
`geog` GIST + a partial keyset index raw-SQL-managed; verified clean + upgraded,
discovery/exchange geog indexes preserved):

- **`Event`** — the stored public event: coarse venue (`coarseLat/Lon/Cell` +
  `geography(Point,4326)`), UTC instants + preserved source timezone, source
  identity (provider / providerEventId / providerSourceId / organizerRef /
  revisionAt / confidence) and cancel/postpone provenance (C3), `popularity`
  (0..1 or null), `canonicalId` (dedup), `expiresAt` (retention). **No
  user-origin column. No age/gender/payment column. Raw payloads never stored.**
- **`EventDedupDecision`** — the explainable evidence for every merge (C4).
- **`EventSearchProjection`** — sanitized labels + coarse cell only, never
  coordinates (T-EV-5/6).

## 2. The ingest pipeline (4B, ports #61 `search.js` server-side)

`fetch(providers) → normalize → dedup → derive-state → prune → safety → persist`.

- **Normalize boundary** (`events.normalize.ts`) — the one place a provider
  candidate becomes trusted: coarsens the venue to the public grid (the only
  cast site), mints bounded 0..1 popularity **only** from a source number
  (absent ⇒ null, C2), whitelist-copies (drops raw payload/credentials, T-EV-4),
  enforces mandatory source attribution + provenance (C3), refuses inverted
  windows and copies provider-only `occurrenceId` (C5).
- **Time-state engine** (`events.time.ts`, C5) — source `cancelled`/`postponed`
  wins over the clock; all-day windows; retention/TTL pruning; UTC/DST-safe;
  `Intl` display never guesses an offset.
- **Dedup** (`events.dedup.ts`, C4) — exact provider identity folds; a
  cross-provider merge needs **all four** signals (normalized-title +
  venue-identity + time-overlap + coarse-area); title-alone never merges;
  ambiguous stays separate; decisions persisted + explainable.
- **Provider port** (`events.provider.ts`) — fixture + unavailable adapters
  ONLY; empty default fleet ⇒ honest `unavailable`; `assertNoSecrets` fails a
  credential-carrying adapter loud. **No production provider, no keys.**
- **Safety** (`events.safety.ts`) — block by provider/source/organiser;
  `assertNoOriginLeak` mutation guard (the user origin can never reach a record).
- **Browse** — `ST_DWithin` + keyset on `(startAt DESC, id DESC)` with a signed
  depth-bounded cursor and a coarse distance **band** (never metres).

## 3. Transparent ranking (4C, ports #61 `ranking.js`, adapted for C2)

`events.ranking.ts` — a **closed** signal registry (`time`, `distance`,
`relevance`, `popularity`); an `engagement`/`sponsored` signal or weight
**throws**. Popularity is weighted LAST and acts **only as a tie-break**: the
primary order is the substantive score (time+distance+relevance), so popularity
can never resurrect a materially more distant result (C2); ineligible/expired/
blocked/cancelled rows are filtered *before* ranking. Unknown popularity is
**omitted** from the breakdown, never an invented zero. Every result carries a
full explainable breakdown; the order is deterministic (ties → id). Weights are
`[PROPOSED]` config defaults (pending A5).

## 4. web-next Events surface (4C, inert)

`web-next/src/events/` — a framework-free controller behind ports (fixture API,
fixed geolocation). The precise device fix exists only inside `browse`'s scope
and is converted through the discovery `coarsenForPublic` boundary (single
brand-cast site) **before anything outbound**; the mutation battery proves raw
coordinates never escape. `EventCard`/`EventDetail` credit the source (+
confidence), show cancelled/postponed provenance, show sourced popularity **or
"not provided by the source"** (C2), an approximate-area note, an explainable
ranking breakdown (including omitted signals), keyboard-operable **Save**, and
**Open in maps** on the coarse venue. **No age/gender control (A3).** Honest
`locating`/`permission-required`/`offline`/`unavailable`/`empty`/`failed`
states. `App.tsx` is unchanged — the surface is a self-contained sibling module.

## 5. Non-goals (4B–4C)

No route in the running app, no `App` mount, no production provider/keys, no
payments/ads, no age/gender, no activation.
