import { Injectable } from '@nestjs/common';
import { NotificationClass } from './catalog/notification-class';

/**
 * The master and per-class feature flags for the Notifications V2 platform.
 *
 * EVERYTHING here defaults to OFF. The whole module is additive and inert: it is
 * NOT imported by `AppModule`, so none of its providers construct, no `@Cron`
 * schedules, and no route is exposed in the running app. These flags are the
 * SECOND gate (defence in depth) — even if a future PR wires the module in, no
 * side effect fires until `NOTIFICATIONS_V2_ENABLED=true`.
 *
 * Read at enqueue/claim time (never gate-by-skipping-construction) so the
 * pipeline can run in "shadow" — compute the outbox row, then decide send vs
 * `suppressed` — exactly the ADR-007 "verdict always computed" discipline.
 */

const TRUE = new Set(['1', 'true', 'yes', 'on']);

function envBool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return TRUE.has(v.trim().toLowerCase());
}

/** Per-class env flag name, e.g. NOTIF_CLASS_MESSAGE. */
export function classFlagEnv(cls: NotificationClass): string {
  return `NOTIF_CLASS_${cls.toUpperCase()}`;
}

@Injectable()
export class NotificationFlags {
  /**
   * Master switch. OFF ⇒ the shipped inline `PushService.notify()` path stays
   * exactly as-is and this platform produces no side effects at all.
   */
  get enabled(): boolean {
    return envBool('NOTIFICATIONS_V2_ENABLED', false);
  }

  /** Route the send through the Postgres outbox + worker (vs inline notify). */
  get outboxEnabled(): boolean {
    return this.enabled && envBool('NOTIF_OUTBOX_ENABLED', false);
  }

  /**
   * Encrypted rich-payload path (the sealed-envelope upgrade over the
   * content-less floor). Reachable ONLY when the master flag AND this sub-flag
   * are both set. DEFAULT OFF.
   *
   * ⚠️  ACTIVATING THIS REQUIRES THE OWNER'S ADR-008 §12 SECURITY-REVIEW
   * SIGN-OFF. The seal path (`EncryptedEnvelopeBuilder` → `notif-crypto`) uses a
   * per-device notification key whose PUBLIC half is registered server-side; the
   * review must rule that such a public wrapping-key registration is NOT "key
   * publication" in the §12 sense. Until that sign-off, leave this OFF. With it
   * off, NO key is generated and NO sealing runs — the builder throws before any
   * crypto (asserted by the isolation fence).
   */
  get encryptedPayloadEnabled(): boolean {
    return this.enabled && envBool('NOTIF_ENCRYPTED_PAYLOAD_ENABLED', false);
  }

  /**
   * Legacy alias for the native encrypted path. Retained (hard-OFF) so older
   * references/tests keep compiling; `encryptedPayloadEnabled` is the live gate.
   */
  get encryptedNativeEnabled(): boolean {
    return false;
  }

  /**
   * Is this event class allowed to actually SEND?
   *
   * message/knock default ON-as-today ONLY when the master+outbox flags are on;
   * every other class defaults OFF (needs its producer + owner sign-off). With
   * the master flag off, nothing is live.
   */
  classEnabled(cls: NotificationClass): boolean {
    if (!this.enabled) return false;
    const defaultOn = cls === 'message' || cls === 'knock';
    return envBool(classFlagEnv(cls), defaultOn);
  }
}
