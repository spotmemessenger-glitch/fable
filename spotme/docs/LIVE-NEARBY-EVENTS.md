# Live Nearby Events — Foundation (dark)

**Status:** built dark, flag-gated, **not shipped**. Master flag `false` → engine
inert, zero provider/network activity, tree-shaken out of `dist`. Turning it on
is a single deliberate edit to `src/lib/live-events/flags.js` `MASTER`, in a
change whose whole subject is that authorisation.

Live Nearby Events is a **separate flagship product surface** — not a map
filter, not a place category, not Nearby Moments, not a standalone realtime
programme. It answers one question: *what public, authorised events are on near
me, now and soon.*

This foundation reuses the **approved Discovery V2 contracts (PR #60)** wherever
places, radius, ranking-shape, directions and map-state already solved the
problem; it adds only what events need (time, timezone, lifecycle, attribution).

---

## 1. Architecture

```
                    createEventsEngine(opts)          ← the only entry point
                     │  reads flags.js (all false ⇒ INERT: no runner, no net)
                     ▼
   ┌─────────────── search.js (createEventSearch) ───────────────┐
   │  normalizeQuery ─▶ expandingSearch (Discovery V2 radius)     │
   │      │                 10→15→25→50→100 km, min-stop,         │
   │      │                 cancel + epoch stale-guard            │
   │      ▼                                                       │
   │  per provider.searchEvents(query, {radiusKm,origin,now})     │
   │      ▼                                                       │
   │  normalizeEvent ─▶ distanceM (device-local) ─▶ dedup by id   │
   │      ▼                                                       │
   │  withState(now) ─▶ pruneStaleEvents ─▶ filterForSafety ─▶    │
   │  rankEvents(time,distance,relevance,popularity)              │
   └─────────────────────────────────────────────────────────────┘
                     │  one result state:
                     ▼  ok | partial | empty | unavailable | failed | superseded (+ loading)
        mapState (Discovery V2 single-source-of-truth)  ── linking.js ──▶ markers / directions / detail
```

**Modules** (`src/lib/live-events/`):

| Module | Responsibility |
|---|---|
| `flags.js` | Layered compile-time flags, all default false; hard master gate; `assertShippedDark` |
| `contracts.js` | `EVENT_STATE`, `normalizeEvent`, `isValidEventProvider`, source attribution; reuses Discovery V2 `RESULT_STATE`, `normalizeQuery`, `assertNoSecrets`, `normalizePlace` |
| `time.js` | UTC-instant state derivation (upcoming / happening-now / ended; cancelled & postponed win), timezone display, freshness/expiry/stale removal |
| `ranking.js` | Transparent weighted score (time .40 / distance .30 / relevance .20 / popularity .10) + full `scoreBreakdown` |
| `safety.js` | Blocking, safety/age-restriction filtering, `assertNoOriginLeak` |
| `search.js` | Orchestration; reuses Discovery V2 `expandingSearch` + `distanceM`; result states; no fake providers |
| `detail.js` | Event detail state machine (closed/loading/ready/unavailable) |
| `linking.js` | Event → place / map marker / directions; reuses Discovery V2 `getDirections` + `createMapState` |
| `index.js` | Engine assembly + inert gate |

**Determinism.** Every time-dependent function takes `now` as an argument;
nothing reads the wall clock internally. Searches carry a monotonic epoch so a
newer query supersedes an older one; an `AbortSignal` cancels outright.

**Data honesty.** We do not invent events, attendance, popularity, prices,
availability or venue details. A field a provider did not supply stays `null`.
`popularity` is trusted only as an explicit, bounded (0..1) source figure.

---

## 2. Provider integration

Providers are **adapters** implementing a duck-typed contract; no vendor name,
endpoint or credential appears in the core.

```js
const provider = {
  name: 'example-listings',                    // audit label, not a display credit
  async searchEvents(query, ctx) {             // ctx: { radiusKm, origin, signal, now }
    // 1. call the AUTHORIZED source API (credentials live in this closure,
    //    injected config, or an env var — NEVER an own-property on this object)
    // 2. map each raw item to the candidate shape normalizeEvent expects:
    return items.map(i => ({
      providerId: i.id, title: i.name, description: i.summary,
      category: i.category, startTime: i.starts_at, endTime: i.ends_at,
      timezone: i.tz, lifecycle: i.status,       // 'scheduled'|'cancelled'|'postponed'
      lat: i.venue.lat, lon: i.venue.lon,
      place: i.venue,                            // normalised via Discovery V2
      source: i.source_name, url: i.public_url,  // attribution (public)
      popularity: i.popularity ?? undefined      // ONLY if the source supplies it
    }))
  }
}
```

Rules enforced by the framework:

- `isValidEventProvider` skips a malformed adapter instead of crashing the search.
- `assertNoSecrets` **throws** if an adapter exposes a secret-shaped own-property
  (`apiKey`, `token`, `secret`, …). Credentials belong in the closure/config.
- `normalizeEvent` copies only whitelisted fields — a provider's raw payload
  (tracking ids, attribution tokens, billing metadata) never propagates.
- **Authorized sources only. No scraping.** Adapters must call sanctioned,
  terms-compliant APIs.

Optional adapters: `detailProvider` (`detail(event)` for richer detail) and
`routingProvider` (`route(from,to)` for real directions — else honest
straight-line).

---

## 3. Rollout

Staged, reversible, each step its own change:

1. **Foundation (this PR).** Dark, tested, not wired in. No app module imports
   `live-events`; the fence test proves it.
2. **Provider adapter(s).** Add one authorized-source adapter behind the still-
   dark flags; exercise via tests only.
3. **Internal enable.** Flip `MASTER` + `discovery`/`ranking` in a build for
   internal/staging only; verify result states, dedup, expiry, ranking against
   real data. This is the first change whose subject is activation.
4. **Map/detail/directions.** Enable `mapSync`, `detail`, `directions` once the
   list surface is validated.
5. **Limited production.** Enable for a small cohort; watch provider error rates
   (→ `partial`/`failed` states), latency, and freshness.
6. **General availability.** Only after the above hold.

Gate ownership: activation flags flip **only** with owner authorisation. AI
scope stays interface-only — no LLM, no assistant, no personalisation, no heat
maps, no ticketing/reservations, no business promotions.

---

## 4. Rollback

Because the subsystem is compile-time gated and isolated, rollback is cheap and
total at every stage:

- **Instant disable.** Set `MASTER = false` and ship. The engine returns inert
  immediately — no providers held, no network, no state store. No data
  migration, no cleanup: events are read-through from providers, so there is no
  persisted event store to unwind.
- **Per-feature backout.** Any single sub-flag (`directions`, `detail`,
  `mapSync`, `ranking`, `discovery`) can be turned off independently while the
  rest stays up — the master gate ANDs them, so lowering one never affects
  another.
- **Provider backout.** Remove an adapter from the injected `providers` array;
  with none left the surface degrades honestly to `unavailable`, never to
  invented events.
- **Full removal.** Deleting `src/lib/live-events/` and its tests removes the
  subsystem with no residue — nothing else imports it (fence-proven).

No user-generated content, tickets, reservations or payments are involved, so
there is no external state to reconcile on rollback.

---

## 5. Explicit non-goals (not built here)

Nearby Moments · user-generated event publishing · stories/reels · likes/
comments/follows · AI summaries or conversational assistant · personalization ·
heat maps · business promotions · ticketing/reservations · PostGIS/H3 · Redis/
DragonflyDB · realtime gateway redesign · Camera integration · production
activation. These remain clean seams, deliberately unimplemented.
