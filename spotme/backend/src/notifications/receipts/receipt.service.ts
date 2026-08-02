import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationFlags } from '../notifications.config';
import { NotificationMetrics } from '../metrics/metrics.service';
import { NotificationCatalog } from '../catalog/notification-catalog';
import { canTransition, NotificationState } from '../state/notification-state';
import { NotificationClass } from '../catalog/notification-class';
import { TransportName } from '../transport/notification-transport';
import {
  actionEffect,
  isNotificationAction,
  NotificationAction,
} from '../actions/notification-actions';

/** One device receipt (design §5.4). Contains NO content — `notifId` is opaque. */
export interface ReceiptItem {
  readonly notifId: string;
  readonly event: 'delivered' | 'opened' | 'dismissed';
  readonly ts?: number;
}

const RECEIPT_EVENTS = new Set(['delivered', 'opened', 'dismissed']);

/**
 * Delivery/open receipts. Idempotent on (outboxId, deviceId, event). Advances
 * the outbox row through the state machine (sent→delivered→opened/dismissed) and
 * feeds the deliver/open metrics — the evidence "production-grade" claims need.
 *
 * Content-free: a receipt is an opaque handle plus an event name. Rejected items
 * (unknown/expired notifId) are counted, never detailed (§5.4). Flag-gated and,
 * like the rest of the module, not mounted in the running app in this branch.
 */
@Injectable()
export class ReceiptService {
  private readonly log = new Logger(ReceiptService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: NotificationFlags,
    private readonly catalog: NotificationCatalog,
    private readonly metrics: NotificationMetrics,
  ) {}

  async record(
    deviceId: string,
    transport: TransportName,
    items: readonly ReceiptItem[],
  ): Promise<{ accepted: number; rejected: number }> {
    if (!this.flags.enabled) return { accepted: 0, rejected: items.length };

    let accepted = 0;
    let rejected = 0;
    for (const item of items) {
      if (!RECEIPT_EVENTS.has(item.event) || !item.notifId) {
        rejected += 1;
        continue;
      }
      const ok = await this.applyOne(deviceId, transport, item);
      if (ok) accepted += 1;
      else rejected += 1;
    }
    return { accepted, rejected };
  }

  private async applyOne(
    deviceId: string,
    transport: TransportName,
    item: ReceiptItem,
  ): Promise<boolean> {
    const row = await this.prisma.notificationOutbox.findUnique({
      where: { id: item.notifId },
    });
    if (!row) return false; // unknown/expired handle — counted, not detailed

    // Idempotent receipt row.
    try {
      await this.prisma.notificationReceipt.create({
        data: {
          outboxId: row.id,
          deviceId,
          transport,
          event: item.event,
          ts: item.ts ? new Date(item.ts) : new Date(),
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return true; // already recorded — idempotent success
      }
      throw err;
    }

    // Advance the outbox row if the transition is legal; a stale/replayed
    // receipt (e.g. opened before delivered) is recorded but does not corrupt
    // the ledger.
    const to = item.event as NotificationState;
    const from = row.status as NotificationState;
    if (canTransition(from, to)) {
      await this.prisma.notificationOutbox.updateMany({
        where: { id: row.id, status: from },
        data: { status: to, updatedAt: new Date() },
      });
    }

    const cls = row.eventClass as NotificationClass;
    if (this.catalog.isKnown(cls)) {
      if (item.event === 'delivered') this.metrics.onDelivered(cls, transport);
      else if (item.event === 'opened') this.metrics.onOpened(cls, transport);
    }
    return true;
  }

  /**
   * Record a user ACTION on a delivered notification (reply/read/mute/archive/
   * accept/decline/…). The action's opaque RESULT is stored as a receipt (never
   * its content) and, where the action represents engagement or refusal, the
   * outbox row advances through the same state machine (a call `accept` ⇒
   * opened, `decline` ⇒ dismissed). Idempotent on (outboxId, deviceId, event);
   * an action unknown to the class is rejected, counted, never detailed.
   */
  async recordAction(
    deviceId: string,
    transport: TransportName,
    notifId: string,
    action: string,
  ): Promise<{ accepted: number; rejected: number }> {
    if (!this.flags.enabled) return { accepted: 0, rejected: 1 };
    if (!deviceId || !notifId || !isNotificationAction(action)) {
      return { accepted: 0, rejected: 1 };
    }
    const ok = await this.applyAction(deviceId, transport, notifId, action);
    return ok ? { accepted: 1, rejected: 0 } : { accepted: 0, rejected: 1 };
  }

  private async applyAction(
    deviceId: string,
    transport: TransportName,
    notifId: string,
    action: NotificationAction,
  ): Promise<boolean> {
    const row = await this.prisma.notificationOutbox.findUnique({ where: { id: notifId } });
    if (!row) return false; // unknown/expired handle — counted, not detailed

    const effect = actionEffect(action);
    try {
      await this.prisma.notificationReceipt.create({
        data: { outboxId: row.id, deviceId, transport, event: effect.event, ts: new Date() },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return true; // already recorded — idempotent success
      }
      throw err;
    }

    // Advance the delivery state only if the action maps to a legal transition.
    if (effect.state) {
      const from = row.status as NotificationState;
      if (canTransition(from, effect.state)) {
        await this.prisma.notificationOutbox.updateMany({
          where: { id: row.id, status: from },
          data: { status: effect.state, updatedAt: new Date() },
        });
      }
    }

    const cls = row.eventClass as NotificationClass;
    if (this.catalog.isKnown(cls)) this.metrics.onActioned(cls, transport, action);
    return true;
  }
}
