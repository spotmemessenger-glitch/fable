# 07 — Notification Service

> Part of the [Discovery Platform Architecture Specification](README.md).
> Engineering spec — draft for owner review (stacked PR; documentation only,
> nothing here activates code). Numeric values are [PROPOSED] config defaults.

## 7.1 Service responsibilities — and what exists today (honest)

One shared notification service serves every Discovery surface. No surface
builds its own pipeline: each **registers notification classes** and emits
**surface events**; the platform owns relevance gating, batching, rate caps,
durable delivery, channel adapters, preferences, and privacy — enforced once,
audited once.

Honesty about today: this service is **green-field — no Discovery
notification code exists**. Prior art is the **dark push-platform
foundation** on draft PRs **#48** (native push SDK packages only, no wiring)
and **#52** (push platform foundation, additive and inert) — real, reviewed,
**unmerged** code cited `[REUSE]` as the native-channel substrate, per
[03-IMPLEMENTATION-STATUS](../../handbook/03-IMPLEMENTATION-STATUS.md). The
canonical target is the platform notification stack of the migrated build
memory §2.8 (FCM / APNs / Web Push behind a provider-neutral transport,
transactional outbox — activated in Wave 5, §2.3). Nothing runs on `master`.

## 7.2 Architecture — one shared pipeline

```
 surface events            match found · response received · item expiring ·
   │                       event starting soon · status change
   │                       ([03-INTENT-GRAPH-AND-SEARCH] + surface engines)
   ▼
 relevance gate            class enabled for this user? score ≥
   │                       notify.match.threshold? below threshold →
   │                       in-app only, or rolled into the next digest
   ▼
 batching & rate caps      coalesce within notify.digest.windowMin;
   │                       per-user caps (§7.4); quiet hours / DND (§7.5)
   ▼
 durable notification outbox   PostgreSQL row written in the SAME transaction
   │                           as the state change that caused it; idempotency
   │                           key per (user, class, subject, window)
   ▼
 delivery workers          at-least-once drain; per-class TTL, priority,
   │                       collapse policy; delivery/open/dismiss receipts
   ├─► native push adapter     FCM / APNs / Web Push behind the push provider
   │                           port ([05-PROVIDER-ABSTRACTION §5.2]) —
   │                           [REUSE] dark push-platform foundation, draft
   │                           PRs #48/#52 (unmerged, inert)
   └─► in-app adapter          notification centre + badges — same classes,
   │                           same gates, no push dependency
   ▼
 device                    content-free payload by default (§7.6); details
                           load in-app over the authenticated session
```

The outbox and its workers live in `apps/api` / `apps/workers` of the target
monorepo; storage is PostgreSQL — the v1 datastore rule adds nothing else
([08-DATA-AND-CACHING](08-DATA-AND-CACHING.md)).

## 7.3 Notification class registry — per surface

Classes are registered per surface; the pipeline is shared. Adding a class is
a registry entry plus copy — never a new pipeline.

| Surface | Class | Trigger | Default | Status |
|---|---|---|---|---|
| Exchange | `new-match` | New high-confidence match for my Need/Offer | On | Specified in [exchange/05-NOTIFICATIONS](../../handbook/product/exchange/05-NOTIFICATIONS.md) (`[PROPOSED]`, pending A5) |
| Exchange | `match-digest` | Batched: N new matches since last open | On (batched) | Specified in PRD ch 05 (`[PROPOSED]`, pending A5) |
| Exchange | `response` | Someone messaged about my Need/Offer | On | Specified in PRD ch 05 (`[PROPOSED]`, pending A5) |
| Exchange | `expiring-soon` | My item expires within ~2 h `[PROPOSED]` | On | Specified in PRD ch 05 (`[PROPOSED]`, pending A5) |
| Exchange | `nearby-need` | New Need near me matches my Offer categories | **Off** (opt-in, category-scoped) | Specified in PRD ch 05 (`[PROPOSED]`, pending A5) |
| Exchange | `status` | Resolved / closed / removed by moderation | On | Specified in PRD ch 05 (`[PROPOSED]`, pending A5) |
| Exchange | `safety` | Report outcome / security-relevant event | On | Specified in PRD ch 05 (`[PROPOSED]`, pending A5) |
| Events | `event-starting-soon` | A **saved** event starts within `notify.event.startingSoonMin` | On for saved events only — never unsolicited | **[PROPOSED]** |
| Events | `event-changed` | A saved event is cancelled/postponed (source-asserted lifecycle, `[REUSE]` `spotme/web/src/lib/live-events/time.js`, draft PR #61) | On for saved events | **[PROPOSED]** |
| Moments | — | Future surface — registry seam only; no classes defined until the Moments mission is approved | — | Future |
| Map | — | Defines no notification classes in v1 | — | — |

## 7.4 Relevance gating, batching, rate caps — all configuration

Behaviour is fixed here; every number is runtime config
([11-FLAGS-CONFIG-OBSERVABILITY](11-FLAGS-CONFIG-OBSERVABILITY.md), class
`product` unless noted):

| Key | Default `[PROPOSED]` | Meaning |
|---|---|---|
| `notify.match.threshold` | `0.6` | Minimum match score ([04-RANKING-SERVICE](04-RANKING-SERVICE.md) / [exchange/04](../../handbook/product/exchange/04-MATCHING-AND-RANKING.md)) for an immediate `new-match` push; below it, matches wait in-app or roll into a digest — never pushed |
| `notify.digest.windowMin` | `30` | Coalescing window: events in the same window for the same user collapse into one digest |
| `notify.rate.maxPerHour` | `4` | Per-user cap across all Discovery classes; overflow degrades to digest/in-app, `safety` exempt |
| `notify.rate.maxPerDay` | `20` | Per-user daily cap, same overflow rule |
| `notify.event.startingSoonMin` | `60` | Lead time for `event-starting-soon` |

Validation invariants: threshold ∈ [0, 1]; windows, caps, and lead times
positive; `maxPerHour` ≤ `maxPerDay`. Config changes are validated and
audited; tuning never requires a code change (Configuration Principle,
[README](README.md)).

## 7.5 User control — quiet hours, DND, focus, mutes

- **Quiet hours / DND / focus are honoured** by the delivery workers
  (`[REUSE]` push-platform preference model, draft PRs #48/#52; memory §2.8
  — preferences, DND, quiet hours, focus allowlists). Deferred
  notifications land in-app; only the `safety` class may override, and only
  where the user's own setting permits it.
- Users can mute a **single subject** (one item, one event), a **class**, a
  **surface**, or **everything** — evaluated at the relevance gate, so muted
  events are never even queued for push.
- Foreground / background / terminated states are handled by the native
  channel `[REUSE]` (draft PRs #48/#52); actions (Open, Save, Mute, Report)
  where the platform supports them.

## 7.6 Privacy rules — content-free by default

Push transports are third parties; a payload must reveal nothing even if
logged in transit (E2EE safety — memory §2.8: content-free notifications by
default; encrypted rich payloads only after separate security review):

1. **Content-free payload by default:** class, an opaque subject reference,
   and routing data — **no message content, no counterpart identity, no
   item text**. Details load **in-app over the authenticated session**.
2. **Approximate-only location hints:** any distance in copy is coarse
   ("a new request ~2 km away"), derived from the approximate public
   position ([02-LOCATION-PRIVACY-ENGINE](02-LOCATION-PRIVACY-ENGINE.md),
   [ADR-019](../../adr/019-discovery-v2-privacy-model.md)); a precise
   coordinate never enters a payload.
3. **Never "person X is nearby":** no notification reveals that a specific
   person is at or near a place (rule specified in
   [exchange/07-PRIVACY](../../handbook/product/exchange/07-PRIVACY.md),
   `[PROPOSED]` pending A5); `nearby-need` pings are category-scoped and
   identity-free.
4. **No sensitive inference:** no class may be triggered by inferred
   sensitive traits (constitution); triggers are explicit state changes only.

## 7.7 Delivery integrity — the outbox, and who owns the truth

- **Transactional outbox:** the notification row commits **with** the state
  change that caused it (memory §2.3, Wave 5) — a match that exists is
  eventually notified; a rolled-back match never is. No loss.
- **Idempotent delivery:** workers drain at-least-once; the idempotency key
  plus per-class collapse keys make user-visible delivery effectively
  once. Retried sends never duplicate a notification. No duplication.
- **Receipts:** delivery / open / dismiss / action receipts (memory §2.8)
  feed observability ([11-FLAGS-CONFIG-OBSERVABILITY](11-FLAGS-CONFIG-OBSERVABILITY.md))
  — measured delivery rates, never assumed ones.
- **Notifications are an accelerant, not the source of truth:** REST/graph
  state ([10-API-CONTRACTS](10-API-CONTRACTS.md)) is authoritative. If push
  is unavailable — device offline, tokens stale, provider down — in-app
  state is still **correct on next open** (reconciliation:
  [09-OFFLINE-SYNC](09-OFFLINE-SYNC.md)). A failed push is a missed
  acceleration, never missed data; the badge and notification centre
  rebuild from server state.
- The push transport is a provider class with the full resilience set —
  timeout, cancellation, retry, circuit breaker, cost accounting,
  normalised errors ([05-PROVIDER-ABSTRACTION §5.6](05-PROVIDER-ABSTRACTION.md));
  no push vendor is a hard dependency.

## 7.8 Deterministic testing

**Injected:** clock (digest windows, quiet hours, `event-starting-soon` lead
times), config (threshold, windows, caps), fake channel adapters, an
in-memory outbox store, scripted surface events. **Mutation/invariant tests
pin:** a match below `notify.match.threshold` never reaches a channel
adapter; N events inside one digest window yield exactly one digest; rate
caps degrade overflow to digest/in-app (with `safety` exempt) rather than
drop; quiet hours defer and deliver in-app; replaying an outbox row with the
same idempotency key produces one user-visible notification; a payload scan
(the `assertNoSecrets` pattern `[REUSE]`
`spotme/web/src/lib/discovery-v2/contracts.js`) proves no payload carries a
precise coordinate, counterpart identity, or content field; a muted subject
is filtered at the gate, not at the device; and with the push adapter forced
down, surface state after "next open" reconciliation equals the state a
successful push would have produced — the source-of-truth invariant.
