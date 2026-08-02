import { Injectable, Logger } from '@nestjs/common';
import { NotificationFlags } from './notifications.config';
import { NotificationCatalog } from './catalog/notification-catalog';
import { NotificationRouter, RoutedNotification } from './routing/notification-router';
import { NotificationEvent } from './routing/notification-event';
import { PreferenceService } from './preferences/preference.service';
import { OutboxService } from './outbox/outbox.service';
import { NotificationMetrics } from './metrics/metrics.service';
import { PreferenceDecision } from './preferences/preference.types';

export type EnqueueOutcome =
  | 'disabled' // master flag off — nothing computed beyond the guard
  | 'created' // a new outbox row was written
  | 'deduped' // an identical row already existed
  | 'suppressed'; // flag/pref/DND said no

export interface EnqueueResult {
  readonly outcome: EnqueueOutcome;
  readonly reason?: 'flag' | 'level' | 'mute' | 'dnd' | 'focus';
  /** The computed routing, always present when the master flag is on. */
  readonly routed?: RoutedNotification;
  readonly decision?: PreferenceDecision;
}

/**
 * The producer→core entrypoint (design §3.3, §5.3). Producers (`rooms.gateway`,
 * `realtime.controller`, calls, stories) call `enqueue(event)`; everything else
 * — policy, preferences, dedupe, collapse — happens here, OFF the socket path.
 *
 * INERT BY DEFAULT: with `NOTIFICATIONS_V2_ENABLED` unset (the default) this
 * returns `disabled` immediately and touches nothing. The module is also not
 * imported by `AppModule`, so no producer is wired to call it in this branch.
 *
 * The routing is ALWAYS computed once the master flag is on (even when a class
 * flag or a preference will suppress the send) — the ADR-007 "verdict always
 * computed" discipline, which lets the pipeline run in shadow before it bites.
 */
@Injectable()
export class NotificationService {
  private readonly log = new Logger(NotificationService.name);

  constructor(
    private readonly flags: NotificationFlags,
    private readonly catalog: NotificationCatalog,
    private readonly router: NotificationRouter,
    private readonly prefs: PreferenceService,
    private readonly outbox: OutboxService,
    private readonly metrics: NotificationMetrics,
  ) {}

  async enqueue(event: NotificationEvent): Promise<EnqueueResult> {
    if (!this.flags.enabled) return { outcome: 'disabled' };
    if (!this.catalog.isKnown(event.class)) {
      return { outcome: 'suppressed', reason: 'flag' };
    }

    const routed = this.router.route(event); // always computed

    // Class flag gate.
    if (!this.flags.classEnabled(event.class)) {
      this.metrics.onSuppressed(event.class, 'flag');
      return { outcome: 'suppressed', reason: 'flag', routed };
    }

    // Server-side preference gate (untrusted client).
    const decision = await this.prefs.decide(
      event.recipientId,
      event.class,
      event.roomId,
    );
    if (!decision.deliver) {
      this.metrics.onSuppressed(event.class, decision.reason ?? 'level');
      return { outcome: 'suppressed', reason: decision.reason, routed, decision };
    }

    // Idempotent enqueue + best-effort coalescing.
    const res = await this.outbox.enqueue(routed);
    if (res === 'created') {
      this.metrics.onEnqueued(event.class);
      if (this.catalog.policy(event.class).collapse !== 'never') {
        await this.outbox
          .coalesceQueued(routed.recipientId, routed.collapseKey)
          .catch((err) =>
            this.log.warn(`coalesce failed: ${(err as Error).message}`),
          );
      }
    }
    return { outcome: res, routed, decision };
  }
}
