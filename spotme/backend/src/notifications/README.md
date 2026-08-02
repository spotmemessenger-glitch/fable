# Notifications V2 platform (Priority 2 · PR A) — additive, isolated, inert

This module is the **tested foundation** of the push-notification platform
described in `spotme/docs/priority-2/01-push-notifications.md` and
`spotme/docs/adr/009-push-notification-platform.md` (the parent design + ADR live
on the planning branch; the implementation decisions for what is built here are
recorded in `spotme/docs/adr/009a-push-platform-addendum.md`).

## It is not wired into the running app — on purpose

Two independent gates keep this inert (Priority-2 rule: additive + isolated,
never activated):

1. **`NotificationsModule` is NOT imported by `AppModule`.** No provider
   constructs, the `OutboxWorker` `@Cron` never schedules, and neither
   `/metrics` nor `/api/notifications` is mounted in the running server.
2. **`NOTIFICATIONS_V2_ENABLED` defaults `false`** (read at enqueue/claim time).
   Even if the module were imported, nothing sends until the flag is set.

Activation is therefore a deliberate, reviewable two-step change — import the
module, then flip the flag — documented in
`spotme/docs/priority-2/rollback-push-platform.md`.

## What it contains

| Area | Files | Notes |
|---|---|---|
| Catalog | `catalog/` | typed class → policy (priority, collapse, TTL, channel, route, default flag) |
| State machine | `state/notification-state.ts` | typed transitions; illegal moves throw |
| Routing | `routing/` | dedupe key, collapse key, OPAQUE on-wire collapse id, transport selection |
| Transports | `transport/` | `INotificationTransport`; real **FCM** + **Web Push**; **OneSignal**/**Novu** conformant stubs (never default) |
| Outbox | `outbox/` | `FOR UPDATE SKIP LOCKED` drain, exponential backoff + full jitter, coalescing, batching |
| Preferences | `preferences/` | server-side quiet-hours / mute / DND / priority evaluation (tz-correct) |
| Envelope | `envelope/` | **content-less** builder (shipped floor); **encrypted** builder is a documented seam that throws |
| Metrics | `metrics/` | `prom-client` — the first `/metrics` consumer |
| Receipts | `receipts/` | delivered/opened/dismissed, idempotent, content-free |

## Crypto posture (critical)

- Notification payloads are **content-less by construction** — no type in this
  module has a message-content field; the catalog bodies are generic.
- The cleartext `tag:roomId` leak is closed with an **opaque** collapse id
  (a one-way SHA-256 grouping token — *not* encryption, *not* a key).
- **No notification-encryption key is generated or persisted anywhere.** The
  rich encrypted-envelope model is an interface seam only, gated on a separate
  owner security review (ADR-008 §12). `envelope/encrypted-envelope.seam.ts`
  throws by design.
- The module imports **nothing** from the Priority-1 message-identity crypto;
  `test/notifications/isolation.spec.ts` enforces this as a build-breaking fence.

## Tests

`test/notifications/` — catalog, state machine, backoff/classification, routing,
preference matrix (incl. tz midnight-crossing + call override), the transport
abstraction against mocked providers, outbox reconciliation (mocked Prisma), the
orchestrator's default-off inertness, and the isolation/content-less fences. The
`FOR UPDATE SKIP LOCKED` claim and coalescing SQL need a real Postgres and are
CI-gated integration.
