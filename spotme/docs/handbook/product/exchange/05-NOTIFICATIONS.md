# 05 — Notifications

> Reconstruction pending A5 ratification. Classes/rules `[PROPOSED]`. Reuses the
> push platform foundation (PRs #48/#52) `[REUSE]` — content-free by default for
> privacy.

## 5.1 Classes

| Class | Trigger | Default |
|---|---|---|
| **new-match** | A new high-confidence match for my Need/Offer | On |
| **match-digest** | Batched: N new matches since last open | On (batched) |
| **response** | Someone messaged about my Need/Offer (handoff) | On |
| **expiring-soon** | My Need/Offer expires within `[PROPOSED]` 2h | On |
| **nearby-need** (Provider opt-in) | A new Need near me matches my Offer categories | Off by default |
| **status** | My item was resolved/closed/removed by moderation | On |
| **safety** | Report outcome / security-relevant event | On |

## 5.2 Rules

- **Relevance-gated:** `new-match` fires only above a match-score threshold
  `[PROPOSED ≥ 0.6]` to avoid noise; below that, results wait in-app / roll into
  a digest.
- **Rate limiting & batching:** per-user caps and a coalescing window
  (`[PROPOSED]` ≤ N/hour, digest every ≤ 30 min) so Exchange never spams.
- **Quiet hours / DND / focus:** honoured `[REUSE]` push platform; safety-class
  may override per user setting only.
- **Content-free by default:** the push payload carries no exact location, no
  counterpart identity, no message content — only enough to route the user into
  the app, where the details load over the authenticated session (E2EE-safe).
- **Approximate only:** any location hint in a notification is coarse ("a new
  request ~2 km away"), never precise.
- **Foreground/background/terminated** states handled `[REUSE]`; actions
  (Open, Save, Mute this item, Report) where supported.

## 5.3 Privacy & consent

- `nearby-need` (proactive provider pings) is **opt-in** and category-scoped;
  it never reveals a seeker's exact location or identity.
- Users can mute a single item, a category, or all Exchange notifications.
- No notification is derived from sensitive inference; none reveals that a
  specific person is nearby.

## 5.4 Delivery integrity

- Notifications ride the **notification outbox** (durable, idempotent) of the
  target architecture (`MIGRATED_BUILD_MEMORY` §2.3/Wave 5) — no lost or
  duplicated pings.
- If push is unavailable, in-app match state is still correct on next open
  (notifications are an accelerant, not the source of truth).
