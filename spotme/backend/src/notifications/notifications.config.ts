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
   * Native encrypted-envelope path. Hard-OFF and unimplemented: it is gated on a
   * separate owner security-review decision (ADR-008 §12) and no notification
   * key is generated or persisted in any shipped path. Kept here only so the
   * seam is visible and testable.
   */
  get encryptedNativeEnabled(): boolean {
    // Intentionally always false in this branch regardless of env — the
    // encrypted builder is a documented seam, not a shipped code path.
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
