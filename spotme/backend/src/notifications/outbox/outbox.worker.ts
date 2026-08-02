import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationFlags } from '../notifications.config';
import { NotificationCatalog } from '../catalog/notification-catalog';
import { NotificationMetrics } from '../metrics/metrics.service';
import { ContentlessEnvelopeBuilder } from '../envelope/contentless-envelope.builder';
import { DeviceTargetService } from '../devices/device-target.service';
import { TransportRegistry } from '../transport/transport-registry';
import { TransportMessage } from '../transport/notification-transport';
import { classifyFailure } from './backoff';
import { OutboxRow, OutboxService } from './outbox.service';
import { NotificationClass } from '../catalog/notification-class';

/** Bounded per run — a drain that does unbounded work is a drain someone kills. */
const MAX_CLAIM_PER_RUN = 500;

/**
 * The outbox drain (design §3.3, §8). Reuses the `storage-cleanup` cron shape
 * verbatim: an overlap guard (`this.running`), bounded work per run, and a loud
 * log on failure — never let a sweep break the primary path.
 *
 * DOUBLE-GATED AND INERT IN THIS BRANCH:
 *   1. `NotificationModule` is NOT imported by `AppModule`, so this `@Cron` is
 *      never even scheduled in the running app; and
 *   2. every run early-returns unless `NOTIFICATIONS_V2_ENABLED` AND
 *      `NOTIF_OUTBOX_ENABLED` are set — the flag is read at claim time, so the
 *      pipeline can later run in "shadow" before it bites.
 */
@Injectable()
export class OutboxWorker {
  private readonly log = new Logger(OutboxWorker.name);
  private running = false;

  constructor(
    private readonly flags: NotificationFlags,
    private readonly outbox: OutboxService,
    private readonly registry: TransportRegistry,
    private readonly envelope: ContentlessEnvelopeBuilder,
    private readonly devices: DeviceTargetService,
    private readonly catalog: NotificationCatalog,
    private readonly metrics: NotificationMetrics,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(): Promise<{ claimed: number; sent: number } | null> {
    if (!this.flags.outboxEnabled) return null; // inert unless explicitly enabled
    if (this.running) {
      this.log.warn('outbox drain already running — skipping this tick');
      return null;
    }
    this.running = true;
    try {
      return await this.drainOnce(MAX_CLAIM_PER_RUN);
    } catch (err) {
      this.log.error(`outbox drain failed: ${(err as Error).message}`);
      return null;
    } finally {
      this.running = false;
    }
  }

  /**
   * One drain pass: claim due rows (SKIP LOCKED), build content-less envelopes
   * per recipient device, dispatch via the registry, then reconcile each row
   * (sent / transient-retry / permanent-prune) and emit metrics. Exposed for the
   * integration test and for an operator running it on demand.
   */
  async drainOnce(limit: number): Promise<{ claimed: number; sent: number }> {
    const rows = await this.outbox.claimDue(limit);
    if (!rows.length) return { claimed: 0, sent: 0 };

    // Build one TransportMessage per (row × recipient-device).
    const messages: TransportMessage[] = [];
    const rowById = new Map<string, OutboxRow>();
    for (const row of rows) {
      rowById.set(row.id, row);
      const cls = row.eventClass as NotificationClass;
      if (!this.catalog.isKnown(cls)) {
        await this.outbox.markPermanentFailure(row.id, 'catalog/unknown-class');
        continue;
      }
      const targets = await this.devices.targetsFor(row.recipientId);
      for (const target of targets) {
        messages.push(
          this.envelope.build({
            routed: {
              class: cls,
              recipientId: row.recipientId,
              roomId: row.roomId ?? undefined,
              eventSeq: row.eventSeq ?? undefined,
              actorId: row.actorId ?? undefined,
              priority: row.priority as TransportMessage['priority'],
              ttlSeconds: row.ttlSeconds,
              dedupeKey: row.dedupeKey,
              collapseKey: row.collapseKey,
              wireCollapseId: row.collapseKey, // opaque server-side key on the floor
              route: '',
              title: this.catalog.policy(cls).titleTemplate.replace('{actor}', 'Spot Me'),
              body: this.catalog.policy(cls).fallbackBody,
            },
            target,
            notifId: row.id,
            count: row.count,
          }),
        );
      }
      if (!targets.length) {
        // Nobody to reach right now — suppress rather than spin (message is safe
        // in RoomEvent and replays on reconnect).
        await this.outbox.markSuppressed(row.id, 'no-target');
        this.metrics.onSuppressed(cls, 'present');
      }
    }

    if (!messages.length) return { claimed: rows.length, sent: 0 };

    const results = await this.registry.dispatch(messages);
    let sent = 0;
    for (const r of results) {
      const row = rowById.get(r.notifId);
      if (!row) continue;
      const cls = row.eventClass as NotificationClass;
      if (r.ok) {
        await this.outbox.markSent(row.id);
        this.metrics.onSent(cls, r.transport);
        sent += 1;
        continue;
      }
      const kind = classifyFailure(r.failure ?? {});
      const code = r.failure?.code ?? String(r.failure?.statusCode ?? 'unknown');
      if (kind === 'permanent') {
        await this.outbox.markPermanentFailure(row.id, code);
        await this.devices.prune(r.deviceId, r.transport);
        this.metrics.onFailed(cls, r.transport, code);
        this.metrics.onTokenPruned(r.transport, 'permanent');
      } else {
        const outcome = await this.outbox.markTransientRetry(row, code);
        if (outcome === 'abandoned') this.metrics.onAbandoned(cls, r.transport);
        else this.metrics.onRetried(cls, r.transport);
      }
    }
    return { claimed: rows.length, sent };
  }
}
