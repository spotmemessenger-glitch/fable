# 09 — Offline Synchronization

> Part of the [Discovery Platform Architecture Specification](README.md).
> Engineering spec — draft for owner review (stacked PR; documentation only,
> nothing here activates code). Numeric values are [PROPOSED] config defaults.

## 9.1 The platform law

Discovery inherits the platform's connectivity guarantee and applies it to
every surface:

1. **Offline queueing + reliable replay.** Anything a user does offline is
   queued durably on the device and replayed on reconnect.
2. **Switching connectivity must never duplicate, reorder, or lose actions.**
   Wi-Fi → cellular → offline → back is invisible to correctness; replay is
   idempotent and order-preserving per queue.
3. **Degraded mode is visible and understandable.** Offline reads are
   labelled with their age; pending actions are shown as pending; the UI
   never simulates liveness (constitution — honesty;
   [exchange/11 §11.4](../../handbook/product/exchange/11-EDGE-CASES-AND-OFFLINE.md)).

Honesty about today: **no Discovery offline-sync code exists.** The dark
surfaces on draft PRs #60/#61 are online-only search paths; the messaging
platform's offline-queue guarantee is prior art from the wider product, not
Discovery code. Everything below is `[PROPOSED]`, except the staleness and
supersede primitives cited `[REUSE]`.

## 9.2 Architecture

```
device (apps/web)                              apps/api
┌───────────────────────────────┐
│ UI ── writes ──► action queues │   replay    ┌───────────────────────┐
│        (IndexedDB, durable)    │ ──────────► │ idempotency-key dedup  │
│                                │  on connect │ → domain services      │
│ UI ◄─ reads ─── read model     │ ◄────────── │ → PostgreSQL (truth)   │
│        ("as of <time>" cache)  │  reconcile  └───────────────────────┘
└───────────────────────────────┘
```

- **Queues live in IndexedDB** (memory §2.2 — IndexedDB repositories for
  durable client data), one FIFO queue per concern (§9.3, §9.4), surviving
  app restarts.
- **Every queued write carries an idempotency key**, minted on the device at
  enqueue time (memory §2.3 — idempotency keys for retried writes;
  [exchange/08](../../handbook/product/exchange/08-API-CONTRACTS.md)). The
  server deduplicates on the key, so at-least-once replay yields
  exactly-once effect.
- **Replay is sequential per queue** (preserving user order) with bounded,
  jittered backoff — `offline.replay.backoffMs` = 2000 `[PROPOSED]`
  (class `ops`); queue depth is bounded — `offline.queue.maxActions` = 200
  `[PROPOSED]` (class `ops`), with the oldest-first refusal surfaced
  honestly, never silent dropping.
- **The server is the source of truth** (memory §2.4); the client's stores
  are caches and queues, never an authority.

## 9.3 The compose-offline queue

A Need/Offer (and, when the Moments mission is approved, a moment draft) can
be **drafted offline and queued**:

- The draft is stored locally, owner-scoped, with its idempotency key and the
  device-local capture time.
- On reconnect it **publishes with that key** — retries and reconnect races
  cannot double-publish
  ([exchange/11 §11.4](../../handbook/product/exchange/11-EDGE-CASES-AND-OFFLINE.md)).
- Location on a queued draft is already the **approximate cell**, coarsened
  on device at draft time
  ([ADR-018](../../adr/018-deterministic-location-grid.md)/[019](../../adr/019-discovery-v2-privacy-model.md);
  [02-LOCATION-PRIVACY-ENGINE](02-LOCATION-PRIVACY-ENGINE.md)) — a precise
  fix is never parked in a queue where it could later leak.
- Until acknowledged, the draft is shown as **queued/pending**, not as
  published; a server rejection (validation, moderation) surfaces as a
  failure the user can act on, never a silent discard.

## 9.4 The action queue

Lightweight verbs — **accept / decline / report / save** — queue the same
way and **replay idempotently**:

- Each action references its target (item id, match id) and carries its own
  idempotency key; replaying after a duplicate-suspect reconnect is harmless.
- **Pending state is shown honestly**: an offline "accept" renders as
  "accepting — will send when back online", never as accepted.
- Actions on targets that changed while offline are resolved by
  reconciliation (§9.6), not by pretending the action landed.

## 9.5 The read model

Reads come from the **last-synced IndexedDB cache**
([08 §8.6](08-DATA-AND-CACHING.md)):

- Every cached view is **labelled "as of \<time\>"** and is **never presented
  as live** — no live badge, no "happening now" claim from cache, no
  fabricated freshness (constitution — honesty).
- Cached data still obeys the retention/staleness rules: event records past
  `events.ttl.staleMin` are stale and past `events.retention.endedHours` are
  pruned from view `[REUSE]` `isFresh` / `pruneStaleEvents`
  (`spotme/web/src/lib/live-events/time.js`, draft PR #61) — offline does not
  exempt a surface from honesty about age.
- The cache stores only what the wire carried: approximate positions and
  whitelist-normalised models ([08 §8.3](08-DATA-AND-CACHING.md)) — offline
  storage is inside the same privacy boundary, not a side channel.

## 9.6 Reconciliation rules

On reconnect, replay then reconcile — in that order, so the user's queued
intent is applied before their view is refreshed:

1. **The server is truth.** Whatever the server returns after replay is the
   state; local rows are overwritten, not merged field-by-field.
2. **Stale local state is superseded, silently.** A browse cache or match
   list that simply aged is replaced without ceremony — the epoch discipline
   `[REUSE]` (`spotme/web/src/lib/discovery-v2/search.js`, draft PR #60;
   [03 §3.7](03-INTENT-GRAPH-AND-SEARCH.md)): older data never renders over
   fresher data.
3. **Conflicts resolve to the server, and the user is told when their action
   was invalidated.** An offline "accept" of a match that expired, was
   withdrawn, or was superseded while disconnected resolves to the server's
   state **plus a notification** — "this match is no longer available" — not
   a silent drop and not a fake success
   ([exchange/11 §11.1](../../handbook/product/exchange/11-EDGE-CASES-AND-OFFLINE.md)).
   The `superseded` result state ([03 §3.8](03-INTENT-GRAPH-AND-SEARCH.md))
   is the wire-level expression of the same rule.
4. **Replay outcomes are per-action.** One invalidated action does not abort
   the queue; each action lands, dedups, or fails visibly on its own.

## 9.7 Per-surface notes

| Surface | Offline behaviour |
|---|---|
| Discovery Map | Browse cache readable "as of \<time\>"; no presence is announced while offline (nothing to transmit — consistent with hidden mode, [02](02-LOCATION-PRIVACY-ENGINE.md)); a queued search is not a thing — search re-runs live on reconnect. |
| Live Nearby Events | The cached list ages against `events.ttl.staleMin` and is labelled accordingly; "happening now" is **never** derived from a stale cache — state derivation needs a trusted `now` against fresh data `[REUSE]` `deriveEventState` (`live-events/time.js`). Ended-and-past-retention events disappear from cache exactly as they would live. |
| Exchange | Items/matches readable from last sync; compose and action queues as §9.3–§9.4; match lists reconcile to server on reconnect with invalidation notices. |
| Nearby Moments | Future — will inherit this chapter unchanged when specified. |
| AI Assistant | Future; interface-first ([06-AI-INTERFACES](06-AI-INTERFACES.md)) — no offline inference is proposed. |

## 9.8 Deterministic testing

**Injected:** clock (cache age labels, TTL/retention while offline, backoff
timing), seeded queue fixtures, config (queue depth, backoff, TTLs), a
scripted connectivity fake (offline/online transitions on demand), fake
server with recorded idempotency keys. **Mutation/invariant tests pin:**
**forced-disconnect replay-order tests** — kill connectivity mid-replay at
every boundary and assert the queue resumes exactly once, in order, with no
duplicate and no gap; **idempotency-key dedup tests** — the same queued
action delivered twice (reconnect race) must produce one server effect;
labelling — a cached view without a fresh sync must carry its "as of" time,
and an events cache must never yield `HAPPENING_NOW` from stale records; a
precise coordinate planted in a queued draft must fail the privacy suite
([02 §2.7](02-LOCATION-PRIVACY-ENGINE.md)); and an invalidated offline action
must surface a user-visible notice, never a fabricated success. Contract
shapes for replay and dedup are specified in
[10-API-CONTRACTS](10-API-CONTRACTS.md); sequencing of when any of this gets
built is [13-IMPLEMENTATION-MAP](13-IMPLEMENTATION-MAP.md).
