# ADR-009a — Push Notification Platform: implementation addendum (Priority 2, PR A)

**Status:** Proposed — implemented as an **additive, flag-gated platform** (behind
`NOTIFICATIONS_V2_ENABLED`, default OFF). PR A built the inert foundation
(`NotificationsModule` not imported); **PR B (this branch)** hardens it toward
production — real (gated) encrypted payload, APNs/Desktop transports, a
DynamicModule + producers wired inertly into `AppModule`, actions, focus mode,
and health — see the **PR B** section below. This addendum records the concrete
engineering decisions. It **does not rewrite ADR-009** (the parent ADR,
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

## PR B — production hardening (this branch, additive over PR A)

Everything below is additive, flag-gated (default OFF), and leaves the
content-less floor as the shipped default. No Priority-1 file or test was
modified; the ADR-008 §12 hard stop is respected (see D10).

### D10 — Encrypted rich envelope: REAL implementation, still gated
`EncryptedEnvelopeBuilder` no longer throws-as-a-seam; it is a real builder that
seals a rich `{class, room, route, actor, preview, count, seq, actions}` payload
via `envelope/notif-crypto.ts`: **X25519 ECDH-ES → HKDF-SHA256 → AES-256-GCM**
(Node `crypto` only; the e2e_v2 construction family, independently implemented).
Custody: the **device** generates its keypair (non-extractable private via
WebCrypto in prod); only the **public** half is registered server-side; the seal
generates an **ephemeral** key discarded per call, so the server persists **no**
device private key. It is reachable ONLY behind `NOTIFICATIONS_V2_ENABLED` AND
`NOTIF_ENCRYPTED_PAYLOAD_ENABLED` — with either off it throws before any crypto
(no key generated, no seal). **The sub-flag stays OFF until the owner's ADR-008
§12 security review** rules a public wrapping-key registration is not "key
publication" (`docs/priority-2/security-review-encrypted-payload.md`). Key/seal
primitives are **confined to `notif-crypto.ts`** (isolation-fence allowlist).

### D11 — Transports completed: APNs (direct) + Desktop
FCM + Web Push stay the real default (iOS via the FCM→APNs relay). Added a
**direct APNs** adapter (`@parse/node-apn` behind the `APNS_PROVIDER` seam) for
VoIP/PushKit CallKit ring — `available()` only with `NOTIF_APNS_ENABLED` + the
four `APNS_*` creds, `supports()` only `apnsDirect` tokens, so it never competes
with the relay. Added a **Desktop** adapter as a documented stub (desktop
browsers already ride Web Push; a native Electron/Tauri channel is the seam).
Both conform to `INotificationTransport`; per-class priority via the shared map.

### D12 — DynamicModule + producers + gateway hook
`NotificationsModule.register()` returns an EMPTY module while the master flag is
off, so importing it in `AppModule` is inert (no providers/cron/routes). ON, it
is `@Global()` and exports `NotificationProducer`. `rooms.gateway` holds the
producer as an `@Optional()` dependency and calls it only when
`producer?.enabled` — so **flag-off behaviour is byte-identical** (mechanised in
`module-wiring.spec`). `producers/` adds typed per-event producers
(message/knock/mention/reply/reaction/call/security/login/verification) and a
`PresencePort` to unify the socket + HTTP publish absent-user calculation.

### D13 — Rich actions
`actions/notification-actions.ts` declares the typed action set per class (call →
accept/decline; message → reply/read/mute/archive; media kinds add
openMedia/playVoice). `ReceiptService.recordAction` records the opaque RESULT and
advances the delivery state (accept ⇒ opened, decline ⇒ dismissed); pref/UI ops
(mute/archive) record without moving state. Actions travel only inside the gated
encrypted payload — the content-less floor carries no action buttons.

### D14 — Preferences: focus mode
`NotificationPreference` gains `focusMode` + `focusAllow` (additive migration
`20260802130000_notif_focus_mode`). Focus is an allowlist that overrides
level/mute: only an allowed class (or a permitted call, or an always-critical
class) delivers; the rest suppress with reason `focus`. Per-chat/per-group are
already covered by `ConversationNotifPref` (a group is a room).

### D15 — Observability: /health + dashboard
`NotificationHealthService` + `/notif-health/{live,ready}` — liveness is
dependency-free, readiness probes DB reachability + transport availability +
outbox depth (never throws, content-free). A Grafana dashboard is committed at
`backend/config/grafana/notifications-dashboard.json`. `/metrics` gains a
`notif_actioned_total` counter.

## What is deferred (not built here)
Rich decrypted native content **rendering** on-device (needs the Android
`FirebaseMessagingService`/iOS NSE — P10-coupled, design §4.8/§18.3; the server
SEAL side is built but gated); the calls producer's signaling integration (P5);
the mention cleartext-routing owner decision (design §18.1); the `/metrics` +
`/notif-health` admin guard at mount time; on-device battery/latency benchmarks
(P10-gated); real FCM/APNs/VAPID credentials and a Grafana instance (infra).
