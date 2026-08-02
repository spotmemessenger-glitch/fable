# Rollback & activation — Push Notification Platform foundation (Priority 2, PR A)

The platform is engineered so that **a merge changes production behaviour in no
way** until two deliberate steps are taken. Rollback is the reverse of each step;
neither requires touching Priority-1 code or any shipped behaviour.

## The two isolation gates (both must open to activate)

1. **Module wiring (DynamicModule).** `AppModule` imports
   `NotificationsModule.register()`, which returns an **EMPTY module** while
   `NOTIFICATIONS_V2_ENABLED` is off (the default): no provider constructs, the
   `OutboxWorker` `@Cron` never schedules, no route mounts, and
   `NotificationProducer` is not provided — so the `rooms.gateway` `@Optional()`
   hook is `undefined` and skipped. Flag-off behaviour is **byte-identical**
   (mechanised in `test/notifications/module-wiring.spec.ts`). This is the outer
   gate; flipping the master flag alone is not enough — the module reads the flag
   at boot, so activation is a deploy with the flag set.
2. **Feature flags (default OFF).** Read at enqueue/claim time:
   - `NOTIFICATIONS_V2_ENABLED` — master. OFF ⇒ `register()` is inert,
     `enqueue()` returns `disabled`, the worker early-returns; the shipped inline
     `PushService.notify()` path is untouched.
   - `NOTIF_OUTBOX_ENABLED` — route through the outbox+worker vs inline.
   - `NOTIF_CLASS_<CLASS>` — per class. `message`/`knock` default ON *only when
     the master flag is on*; every other class defaults OFF.
   - `NOTIF_ENCRYPTED_PAYLOAD_ENABLED` — the gated rich seal. OFF by default;
     with it off the encrypted builder throws before any crypto (no key, no
     seal). **Requires the owner's ADR-008 §12 sign-off to turn on** — see the
     security-review gate below and `security-review-encrypted-payload.md`.
   - `NOTIF_APNS_ENABLED` + `APNS_*` — the direct VoIP APNs adapter (off unless
     configured); ordinary iOS rides the FCM relay regardless.
   - `NOTIF_DESKTOP_ENABLED` / `NOTIF_ONESIGNAL_ENABLED` / `NOTIF_NOVU_ENABLED` —
     stub/aggregator transports, off by default.

   Full table: `docs/priority-2/flag-inventory.md`.

## Activation (when the owner schedules it)

1. Apply the additive migrations (`20260802120000_notifications_v2_platform` —
   four new tables; `20260802130000_notif_focus_mode` — two columns on the
   unused pref table). Both alter no shipped table (safe, no-op).
2. The module is already imported via `NotificationsModule.register()` (inert).
   Add the admin guard to `/metrics` + `/notif-health` and the `RoomMember` check
   to conversation-pref writes before flipping the flag.
3. The `rooms.gateway` `msg`/`knock` producer hook is already wired behind
   `producer?.enabled`; when the flag is on it enqueues automatically.
4. **Shadow**: master flag ON, `NOTIF_OUTBOX_ENABLED` OFF — `register()` now
   provides the module, rows + metrics compute, nothing sends. Prove the pipeline
   with zero user-visible change.
5. Enable `NOTIF_OUTBOX_ENABLED`, then classes one at a time behind their flags,
   each gated on the §13 alerts staying green.
6. (Separate track) The encrypted rich payload stays OFF until the §12 review
   signs off; then register a device public key + wire on-device unseal.

## Rollback

- **Per class:** set `NOTIF_CLASS_<CLASS>=false`. That class stops sending;
  in-flight rows drain to a terminal state. No effect on other classes.
- **Whole platform:** `NOTIFICATIONS_V2_ENABLED=false`. The worker idles, the
  outbox drains and stops, and `msg`/`knock` fall back to the inline
  `PushService.notify()` path exactly as production behaves today.
- **Full removal (code):** revert the module import (back to the inert state) or
  the branch; the additive tables can be left in place (unused) or dropped.

## Schema rollback (migration is forward-only in this repo)

The migration is additive; reversibility is achieved by additivity + a written
drop script. To remove the tables (safe at any time — no shipped feature
references them):

```sql
-- focus-mode columns (20260802130000) — additive, drop first if rolling that one back
ALTER TABLE "NotificationPreference" DROP COLUMN IF EXISTS "focusAllow";
ALTER TABLE "NotificationPreference" DROP COLUMN IF EXISTS "focusMode";
-- the four platform tables (20260802120000)
DROP TABLE IF EXISTS "ConversationNotifPref";
DROP TABLE IF EXISTS "NotificationPreference";
DROP TABLE IF EXISTS "NotificationReceipt";
DROP TABLE IF EXISTS "NotificationOutbox";
```

No existing table, column, type, or nullability was changed, so dropping these
loses no data belonging to any other feature.

## Security-review gate (separate from activation)

Rich, decrypted native content uses a per-device notification **wrapping key**.
The server-side seal is now BUILT (`envelope/notif-crypto.ts` +
`EncryptedEnvelopeBuilder`) but **gated OFF** behind
`NOTIF_ENCRYPTED_PAYLOAD_ENABLED`: with it off, the builder throws before any
crypto, so **no key is generated and nothing is sealed**. The server holds no
device private key (only a registered public half; the seal's ephemeral key is
discarded per call). Turning it on requires a **separate owner security review**
ruling that a public wrapping-key registration is not "key publication" in the
ADR-008 §12 sense (design §18.5) — the full review, threats, and preconditions
are in `docs/priority-2/security-review-encrypted-payload.md`. Until then the
content-less floor — today's shipped privacy posture — is the only live builder,
and it is never worse than production.

To roll the encrypted path back at any time: unset
`NOTIF_ENCRYPTED_PAYLOAD_ENABLED` (the builder reverts to throwing) — the outbox
worker uses the content-less builder regardless, so delivery is unaffected.
