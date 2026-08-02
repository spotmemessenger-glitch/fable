# Flag inventory — Push Notification Platform (Priority 2)

Every flag that gates the notification platform, its default, where it is read,
and what turning it on does. **All default OFF.** With every flag at its default,
the platform is inert and the app behaves exactly as before this branch.

## Master + routing

| Env flag | Default | Read in | Effect when ON |
|---|---|---|---|
| `NOTIFICATIONS_V2_ENABLED` | `false` | `NotificationsModule.register()` (boot) + `NotificationFlags.enabled` (per call) | Wires the `@Global` module (providers, `@Cron`, routes, `NotificationProducer`); `enqueue()`/producers/worker become live. The single master switch. |
| `NOTIF_OUTBOX_ENABLED` | `false` | `NotificationFlags.outboxEnabled` | Drains rows through the Postgres outbox + worker (vs. inline). Master must also be on. Shadow mode = master ON, this OFF. |
| `NOTIF_CLASS_<CLASS>` | `message`/`knock` ON, all others OFF (only when master ON) | `NotificationFlags.classEnabled(cls)` | Allows that class to actually send. `<CLASS>` ∈ message, knock, call, mention, reply, reaction, group, story, security, login, verification, silent. |

## Encrypted rich payload (owner §12 sign-off required)

| Env flag | Default | Read in | Effect when ON |
|---|---|---|---|
| `NOTIF_ENCRYPTED_PAYLOAD_ENABLED` | `false` | `NotificationFlags.encryptedPayloadEnabled` (needs master ON) | `EncryptedEnvelopeBuilder.build()` seals a rich payload to the device's registered public key. With it OFF the builder **throws before any crypto** (no key, no seal). **Do not enable without the ADR-008 §12 security-review sign-off** (`security-review-encrypted-payload.md`). |
| `NOTIF_ENCRYPTED_NATIVE` | ignored | `NotificationFlags.encryptedNativeEnabled` (legacy alias, hard-OFF) | Retained only so older references compile; has no effect. Use the flag above. |

## Transports

| Env flag | Default | Effect when ON |
|---|---|---|
| `NOTIF_APNS_ENABLED` + `APNS_KEY` / `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` | off / unset | Enables the **direct APNs** adapter for VoIP/PushKit tokens (`apnsDirect`). Ordinary iOS rides the FCM→APNs relay regardless. |
| `NOTIF_DESKTOP_ENABLED` | `false` | Marks the native-desktop stub available (no channel is implemented; desktop browsers already use Web Push). |
| `NOTIF_ONESIGNAL_ENABLED` + `ONESIGNAL_APP_ID`/`ONESIGNAL_API_KEY` | off | Marks the OneSignal aggregator stub available (still `supports()`=false — never selected by default). |
| `NOTIF_NOVU_ENABLED` + `NOVU_API_KEY` | off | Marks the Novu orchestrator stub available (same; never selected by default). |

## Pre-existing credentials (not platform flags, but gate real delivery)

| Env | Used by | Notes |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | FCM transport + shipped `PushService` | JSON / base64 / path. Absent ⇒ FCM unavailable (degrades, never crashes). |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push transport + shipped `PushService` | Absent ⇒ Web Push unavailable. |

## Reading order (defence in depth)

1. **Module gate** — `register()` reads `NOTIFICATIONS_V2_ENABLED` at boot; OFF ⇒
   nothing constructs (the strongest, coarse gate).
2. **Per-call gate** — services re-read the master + sub-flags at enqueue/claim/
   build time, so the pipeline can run in shadow and each class/feature flips
   independently without a redeploy.
3. **Transport availability** — a transport with no credential reports
   `available()=false` and is skipped; a missing provider degrades delivery, it
   never crashes the send path.
