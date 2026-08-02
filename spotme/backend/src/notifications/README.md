# Notifications V2 platform (Priority 2) — additive, isolated, flag-gated

This module is the push-notification platform described in
`spotme/docs/priority-2/01-push-notifications.md` and
`spotme/docs/adr/009-push-notification-platform.md` (parent design + ADR on the
planning branch). The concrete engineering decisions for what is built here are
recorded in `spotme/docs/adr/009a-push-platform-addendum.md`.

## It stays inert until deliberately activated — two gates

1. **DynamicModule wiring.** `AppModule` imports **`NotificationsModule.register()`**,
   which returns an **EMPTY module** while `NOTIFICATIONS_V2_ENABLED` is off (the
   default): no provider constructs, the `OutboxWorker` `@Cron` never schedules,
   no route mounts, and `NotificationProducer` is not provided — so the
   `rooms.gateway` hook (which holds it as an `@Optional()` dependency) is skipped
   and existing behaviour is **byte-identical**. `register()` ON returns the full
   `@Global()` module.
2. **`NOTIFICATIONS_V2_ENABLED` defaults `false`**, read again at enqueue/claim
   time (the ADR-007 "verdict always computed" shadow discipline) — the fine
   inner gate behind the coarse module gate.

Activation is therefore staged and reviewable (import already done → flip flag →
enable classes), documented in `spotme/docs/priority-2/rollback-push-platform.md`.

## What it contains

| Area | Files | Notes |
|---|---|---|
| Catalog | `catalog/` | typed class → policy; adds `reply`/`reaction` (default OFF) |
| State machine | `state/notification-state.ts` | typed transitions; illegal moves throw |
| Routing | `routing/` | dedupe key, collapse key, OPAQUE on-wire collapse id |
| Transports | `transport/` | real **FCM** + **Web Push**; **direct APNs** (VoIP, config-gated) + **Desktop** (native seam); OneSignal/Novu stubs |
| Outbox | `outbox/` | `FOR UPDATE SKIP LOCKED` drain, backoff + full jitter, coalescing, batching |
| Preferences | `preferences/` | quiet-hours / mute / DND / **focus mode** / priority (tz-correct) |
| Producers | `producers/` | typed per-event producers + `PresencePort`; flag-gated, inert off |
| Envelope | `envelope/` | **content-less** floor (shipped default); **encrypted** rich builder (gated) |
| Encrypted seal | `envelope/notif-crypto.ts` | X25519 ECDH-ES → HKDF → AES-256-GCM; the ONLY file with key/seal primitives |
| Actions | `actions/` | typed per-class actions (reply/mute/accept/decline/…) → receipts + state |
| Metrics | `metrics/` | `prom-client` `/metrics`; dashboard in `config/grafana/` |
| Health | `health/` | `/notif-health/{live,ready}` incl. transport reachability |
| Receipts | `receipts/` | delivered/opened/dismissed + actions, idempotent, content-free |

## Crypto posture (critical)

- The **content-less floor** is the shipped default and never worse than today's
  production behaviour: no type carries message content; bodies are generic;
  the cleartext `tag:roomId` is replaced by an opaque SHA-256 collapse id.
- The **encrypted rich envelope** (`EncryptedEnvelopeBuilder` + `notif-crypto`)
  is a REAL implementation but **GATED**: it throws unless BOTH
  `NOTIFICATIONS_V2_ENABLED` and `NOTIF_ENCRYPTED_PAYLOAD_ENABLED` are set, and
  with them off **no key is generated and no sealing runs**. It seals a rich
  payload to a per-device X25519 key whose **PUBLIC half only** is registered
  server-side; the server holds no device private key (the ephemeral ECDH key is
  discarded per seal). **Turning the sub-flag on requires the owner's ADR-008 §12
  security-review sign-off** — see
  `spotme/docs/priority-2/security-review-encrypted-payload.md`.
- The module imports **nothing** from the Priority-1 message-identity crypto, and
  all key/seal primitives are **confined to `envelope/notif-crypto.ts`** —
  `test/notifications/isolation.spec.ts` enforces both as build-breaking fences.

## Tests

`test/notifications/` — catalog, state machine, backoff, routing, preference
matrix (+ tz midnight-crossing, call override, focus mode), transports vs mocked
providers (incl. APNs/Desktop), seal/unseal + gated builder, producer gating,
actions, health, module DI wiring, the isolation/content-less/no-seal-while-off
fences, and an end-to-end `enqueue → outbox → transport → receipt` flow with an
in-memory Prisma double. The `FOR UPDATE SKIP LOCKED` claim + coalescing SQL and
the full app-boot need Postgres and are CI-gated.
