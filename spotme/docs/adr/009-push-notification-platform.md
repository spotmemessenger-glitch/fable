# ADR-009 — Push Notification Platform (launch-critical)

**Status:** Proposed — **PLANNING ONLY** (owner directive 2026-08-01: no
implementation until the owner schedules it). **Depends on:** the shipped
`PushService` (backend), ADR-001 (no plaintext leaves the E2E boundary).

## Context — what is verifiably true today

`backend/src/push/push.service.ts` already ships: web-push/VAPID and FCM in
parallel per notify, dead-token/dead-subscription pruning on both transports,
connected-socket suppression (no push for what you're looking at), and a
**no-content payload rule** — a push says *something arrived, from whom*,
never what; payloads transit Apple's and Google's services, so content there
would hand them what the encryption withholds. The FCM send already carries a
tuned `apns` block (`apns-priority: 10`, `content-available`, `thread-id`),
and `registerDevice` accepts `platform: 'ios'` — the server is iOS-shaped
already. What is narrow is the trigger: `rooms.gateway.ts` fires push for
exactly `msg` and `knock`, nothing else; transient send failures are logged
and dropped; there are no delivery metrics; `@parse/node-apn` is an unused
dependency; there is no iOS app (P10 scope) and no APNs credential.

## Decision (design to be implemented when scheduled)

### 1. A notification catalog, not scattered call sites

One typed catalog: event class → `{title template, body (never content),
collapse tag, priority class, TTL, deep-link route}`. Event classes and their
deliberate differences:

| Class | Priority | TTL | Notes |
|---|---|---|---|
| message | high | long | today's behaviour, kept |
| chat request (`knock`) | high | long | kept |
| **call** | max-within-DND-rules | **short (~30 s)** | a call push delivered five minutes late is noise, not a call; iOS live-ring requires PushKit/CallKit — an iOS-app-phase item, recorded not assumed |
| group event (join/leave/role) | low, collapsed per room | medium | server-visible (membership is server data) |
| story | low, collapsed per author | medium | server-visible |
| **mention** | high | long | **owner decision required** — see §5 |

Deep links: the `data` block carries the catalog's route (`room/:id`,
`call/:id`, `story/:author`) so a tap lands on the thing, in every app state.

### 2. Delivery states: background, terminated, foreground, silent

- **Foreground**: no push (socket suppression, already shipped) — in-app cue only.
- **Background/swiped-away**: FCM notification+data block (already proven on
  device — data-only was measured to display nothing).
- **Terminated**: same, with the documented Android exception (force-stopped
  apps receive nothing — an OS rule to be stated in support copy, not fought).
- **Silent sync**: a data-only, no-UI class for prefetch (badge counts, key
  fetches), rate-budgeted because both platforms throttle silent pushes.

### 3. Reliability: outbox, retry, pruning

Today a transient FCM/web-push failure is a log line. Design: a
Postgres-backed **outbox** (no new infrastructure; the cleanup-cron pattern
already exists) — enqueue on notify, attempt inline, on transient failure
(5xx/429/timeouts) retry with exponential backoff and a max-attempt cap;
permanent failures (404/410/`registration-token-not-registered`) keep the
existing prune path. Collapse keys prevent retry storms from stacking
notifications.

### 4. Delivery analytics

Per-send counters (sent / pruned / retried / abandoned, per transport, per
event class) surfaced through an internal endpoint — the first real feed for
the observability gap (V2 P9), and the evidence "production-grade" claims
require. No per-user content, no message correlation: counts and classes only.

### 5. Mentions — the one privacy decision, owner's to make

Mention text lives inside E2E content the server cannot read. A
mention-specific push therefore requires the SENDER's client to mark
"mentions @X" in cleartext routing metadata — a deliberate, minimal leak
(that a mention occurred; never the text) — or mentions push as ordinary
messages (no leak, no differentiation). This is the accuracy/latency/privacy
trade-off principle applied for real, and it is **not decided by this ADR**.

### 6. iOS

Route: **FCM's APNs relay** (server code already correct) rather than direct
APNs — one pipeline, one token table. `@parse/node-apn` is removed (V2 P2's
"implement or remove"). Blockers, owner-side: Apple Developer Program
membership, an APNs auth key registered in the Firebase console, and the iOS
app itself (P10). The design makes day one of an iOS build deliver without
server changes.

## Non-goals

No message content in any payload, ever. No third-party push aggregators. No
per-message read receipts through push. No change to the E2E boundary.

## Rollback / activation

Each event class ships behind its own default-OFF flag; the catalog makes
"which classes are live" one reviewable table. Rollback per class = flag off;
the outbox drains and stops. Nothing here alters existing message/knock
behaviour until switched.
