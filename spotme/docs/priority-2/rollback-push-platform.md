# Rollback & activation — Push Notification Platform foundation (Priority 2, PR A)

The platform is engineered so that **a merge changes production behaviour in no
way** until two deliberate steps are taken. Rollback is the reverse of each step;
neither requires touching Priority-1 code or any shipped behaviour.

## The two isolation gates (both must open to activate)

1. **Module wiring.** `NotificationsModule` is **not imported by `AppModule`**.
   Consequence: no provider constructs, the `OutboxWorker` `@Cron` never
   schedules, and neither `/metrics` nor `/api/notifications` is mounted. This is
   the outer gate and the strongest guarantee of inertness.
2. **Feature flags (default OFF).** Read at enqueue/claim time:
   - `NOTIFICATIONS_V2_ENABLED` — master. OFF ⇒ `enqueue()` returns `disabled`
     and the worker early-returns; the shipped inline `PushService.notify()`
     path is untouched.
   - `NOTIF_OUTBOX_ENABLED` — route through the outbox+worker vs inline.
   - `NOTIF_CLASS_<CLASS>` — per class. `message`/`knock` default ON *only when
     the master flag is on*; every other class defaults OFF.
   - `NOTIF_ENCRYPTED_NATIVE` — **hard-OFF regardless of env** (the encrypted
     builder is an unshipped seam; see the security-review gate below).

## Activation (when the owner schedules it)

1. Apply the additive migration (`20260802120000_notifications_v2_platform`) —
   creates four new tables, alters nothing (safe, no-op for shipped features).
2. Import `NotificationsModule` into `AppModule`; add the admin guard to
   `/metrics` and the `RoomMember` check to conversation-pref writes.
3. Wire a producer (start with `rooms.gateway` `msg`/`knock`) to call
   `NotificationService.enqueue`.
4. **Shadow**: master flag ON, `NOTIF_OUTBOX_ENABLED` OFF — compute rows +
   metrics, do not send. Prove the pipeline with zero user-visible change.
5. Enable `NOTIF_OUTBOX_ENABLED`, then classes one at a time behind their flags,
   each gated on the §13 alerts staying green.

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
DROP TABLE IF EXISTS "ConversationNotifPref";
DROP TABLE IF EXISTS "NotificationPreference";
DROP TABLE IF EXISTS "NotificationReceipt";
DROP TABLE IF EXISTS "NotificationOutbox";
```

No existing table, column, type, or nullability was changed, so dropping these
loses no data belonging to any other feature.

## Security-review gate (separate from activation)

Rich, decrypted native content needs a per-device notification **wrapping key**.
No such key is generated or persisted in this branch, and
`NOTIF_ENCRYPTED_NATIVE` is hard-OFF. Shipping it requires a **separate owner
security review** ruling that a public wrapping-key registration is not "key
publication" in the ADR-008 §12 sense (design §18.5). Until then the
content-less floor — today's shipped privacy posture — is the only live builder,
and it is never worse than production.
