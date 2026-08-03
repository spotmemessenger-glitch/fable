# 11 — Edge Cases & Offline

> Reconstruction pending A5 ratification. `[PROPOSED]`.

## 11.1 Matching edge cases

| Case | Behaviour |
|---|---|
| No matches in radius | Honest empty state; offer transparent radius expansion; optionally notify when one appears. Never fabricate. |
| Zero providers/intent port down | `intentFit = structuredFit`; degrade honestly; still return structured matches; state may be `partial`. |
| Both sides match each other's Need & Offer | Deduplicate to a single Match; do not double-notify. |
| Counterpart expires/withdraws mid-view | Match invalidated immediately; UI shows "no longer available"; never opens a dead handoff. |
| Newer search finishes after older | Older result superseded and dropped (epoch guard) — never renders behind fresh results. |
| Rapid re-posting to game freshness | Freshness bounded/penalised (§04.8); rate limits (§06). |
| Ambiguous free text ("help") | Structured chips carry the match; low `intentFit` → fewer, clearly-explained matches, not junk. |

## 11.2 Location & privacy edge cases

| Case | Behaviour |
|---|---|
| Location permission denied | Exchange works with a user-entered coarse area; never blocks on precise GPS. |
| User at a sensitive place (home/clinic) | Only the approximate cell is ever used; the exact point never leaves the device (§07). |
| Attempt to reveal exact location without consent | Blocked by the consent gate; mutation tests fail the build if a precise coord leaks. |
| Traveling / origin changes | Re-coarsen on device; matches recompute; no precise track stored. |

## 11.3 Conversation/handoff edge cases

| Case | Behaviour |
|---|---|
| Blocked user matched | Filtered out before proposal; never surfaced. |
| Handoff to a user who went offline | Knock is durable (relay) `[REUSE]`; delivered on reconnect. |
| Consent declined at handoff | Return to Match Detail; nothing extra revealed. |
| Duplicate handoff attempts | Idempotent (idempotency key); one knock/conversation. |

## 11.4 Offline behaviour

- **Compose offline:** a Need/Offer can be drafted offline and **queued**; it
  publishes on reconnect with an idempotency key (no duplicates) — mirrors the
  messaging offline-queue guarantee.
- **Read offline:** last-synced items/matches are readable from the local
  IndexedDB cache `[REUSE]`; clearly marked "as of <time>", not live.
- **Actions offline:** accept/decline/report are queued and replayed idempotently;
  the UI shows pending state honestly and reconciles on reconnect.
- **No silent loss/reorder:** reconnect never duplicates, drops or reorders an
  action (the platform's realtime integrity guarantee).
- **Degraded mode is visible** and understandable (constitution / scope §1).

## 11.5 Failure & recovery

- Provider/classifier failure → `partial`/`unavailable` state, retried with
  backoff/circuit-breaker; the user is told, not shown fake success.
- Server error on write → idempotent retry; the item is never half-created.
- Notification failure → in-app match state is still correct on next open (§05).
