# ADR-009a — Push Notification Platform: implementation addendum (Priority 2, PR A)

**Status:** Proposed — implemented as an **additive, inert foundation** (behind
`NOTIFICATIONS_V2_ENABLED`, default OFF; `NotificationsModule` not imported by
`AppModule`). This addendum records the concrete engineering decisions taken
while building the foundation. It **does not rewrite ADR-009** (the parent ADR,
`009-push-notification-platform.md`, which — with the detailed brief
`docs/priority-2/01-push-notifications.md` — lives on the planning branch). Where
this addendum and ADR-009 differ, ADR-009 remains the controlling design; the
notes below are proposals back into it (ADR-009 §16 lists the same edits).

**Scope guard honoured:** additive only; no Priority-1 file or test modified; no
feature flag flipped; no signing/prekey/X3DH/ratchet key created, published, or
read (ADR-008 §12 hard stop respected); the E2E boundary is untouched.

## Context

`backend/src/push/` already ships a correct, privacy-respecting push *primitive*
(web-push + FCM in parallel, dead-token pruning, connected-socket suppression,
content-less payloads). What was missing is a *platform*: a typed catalog, a
durable retrying outbox, a transport abstraction, server-side preferences,
delivery observability, and receipts. This PR builds that foundation under
`backend/src/notifications/`, extending — not rewriting — the shipped
`PushService`.

## Decisions

### D1 — One typed catalog (ADR-009 §1)
Event class → immutable policy (`priority`, `collapse`, `channel`, `ttlSeconds`,
generic `title/body`, `route`, `minLevel`, `canPierceDnd`, `defaultEnabled`).
`message`/`knock` keep today's behaviour (`defaultEnabled: true`); `call`,
`mention`, `group`, `story`, and the `security`/`login`/`verification` family
default OFF. `call` is max-priority, never-collapse, short-TTL; `story` is
low-priority (battery). Adding a class is one catalog row + one producer line.

### D2 — Typed delivery state machine (ADR-009 §2, design §7.1)
`queued → sending → sent → delivered → opened|dismissed`, with `suppressed`,
`collapsed`, `failed`, `abandoned`, `expired` branches. Transitions are a typed
table; every status mutation goes through `assertTransition`, so a stale/replayed
receipt cannot corrupt the ledger.

### D3 — `INotificationTransport` seam (ADR-009 §"transport is an interface")
FCM (`firebase-admin`) and Web Push (`web-push`) are real adapters; **iOS rides
the FCM→APNs relay** — one pipeline, one token table (ADR-009 §6, design §17.1),
so `@parse/node-apn` stays unused and is a remove-candidate. **OneSignal
(`@onesignal/node-onesignal`) and Novu (`@novu/node`) are registered as
conformant STUBS** that never report `available()`/`supports()` true on the
default path — the seam admits an aggregator later without a rewrite (V2 Rule
10), but no third party is inserted into the send path now (design §17.1).
Provider access is via injectable seams (`FCM_MESSAGING`, `WEBPUSH_SENDER`) so
the abstraction is testable against mocked providers with no network.

### D4 — Postgres outbox, not a new queue (ADR-009 §3, design §17.1)
A `NotificationOutbox` table drained by a `@Cron` worker reusing the
`storage-cleanup` overlap-guard + bounded-batch shape. Rows are claimed with
`FOR UPDATE SKIP LOCKED` (N replicas share one outbox, no double-send).
Transient failures (5xx/429/timeout) retry with **exponential backoff + full
jitter** (`base 2s`, `cap 5m`, `maxAttempts 6`); permanent failures
(404/410/`registration-token-not-registered`) prune the token. Bursts coalesce
server-side; FCM sends batch by multicast. `bullmq`+`ioredis` stay unused
(remove-candidates); Priority 3 owns any durable-queue selection.

### D5 — Content-less floor + provider-blind collapse (ADR-009 §4, design §4.5–4.6)
The shipped builder is **content-less by construction** — no type carries
message content; bodies are generic catalog strings. The cleartext `tag:roomId`
leak is closed with an **opaque** on-wire collapse id: a one-way
`SHA-256(class‖collapseTarget‖recipient)` truncation — *not* encryption, *not* a
key — that gives the provider a stable collapse handle without the room id.

### D6 — Encrypted rich envelope is a SEAM ONLY (design §4.2; ADR-008 §12)
The per-device notification **wrapping key** that would enable rich, decrypted
notifications is **not implemented**: no key is generated or persisted in any
code path. `EncryptedEnvelopeBuilder` throws by design; the encrypted-native
flag is hard-OFF. Shipping it is gated on a **separate owner security review**
confirming a public wrapping-key registration is not "key publication" in the
§12 sense (design §18.5). Until then the content-less floor — today's shipped
privacy posture — is the only live builder.

### D7 — Server-side preferences (ADR-009 §"new", design §9)
`NotificationPreference` (per-account DND window + default level) and
`ConversationNotifPref` (per-conversation level + temporary mute), evaluated
**server-side** (untrusted client) with a tz-correct DND window (built-in `Intl`,
no dependency; midnight-crossing supported; missing tz ⇒ DND disabled). Calls may
pierce DND when `allowCallsInDnd`; `security`/`verification` always deliver
(quietly during DND). This introduces the *first* server-side notification prefs
(design §18.4, owner-confirmable) — routing policy, not key material.

### D8 — Metrics + receipts (ADR-009 §4, design §5.4/§13)
`prom-client` is wired to a `NotificationMetrics` service (its own registry) — the
first `/metrics` consumer — with content-free counters/histograms/gauges
(enqueue/suppress/sent/deliver/open/fail/retry/abandon/prune, fan-out latency,
outbox depth/age). `NotificationReceipt` records delivered/opened/dismissed,
idempotent on `(outboxId, deviceId, event)`, advancing the outbox state.

### D9 — Id convention deviation (documented)
The four new tables use `String @default(cuid())` ids to match every other model
in `schema.prisma`, rather than the design's `BigInt autoincrement` proposal — a
deliberate consistency choice, noted here and in the schema.

## Rollback / activation
Per-class default-OFF flags; the master `NOTIFICATIONS_V2_ENABLED` +
`NOTIF_OUTBOX_ENABLED` gate the whole platform. Module-not-imported is the outer
gate. The additive migration ships a written drop script. Full detail:
`docs/priority-2/rollback-push-platform.md`. Nothing here alters message/knock
behaviour until switched on.

## What is deferred (not built here)
Rich decrypted native content (needs the encrypted key + Android
`FirebaseMessagingService`/iOS NSE — P10-coupled, design §4.8/§18.3); the calls
producer (P5); the `PresencePort`/Centrifugo publish-gap unification (design
§3.4, §11.3); the mention cleartext-routing owner decision (design §18.1); the
`/metrics` admin guard + wiring; on-device battery/latency benchmarks (P10-gated).
