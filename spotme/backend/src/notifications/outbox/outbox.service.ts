import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RoutedNotification } from '../routing/notification-router';
import {
  DEFAULT_BACKOFF,
  BackoffConfig,
  isExhausted,
  nextBackoffMs,
} from './backoff';
import { assertTransition, NotificationState } from '../state/notification-state';

/**
 * The Postgres-backed outbox (design §3, §8). This is the offline queue AND the
 * fan-out ledger — no new infrastructure, reusing the `storage-cleanup` cron
 * shape. Rows are claimed with `FOR UPDATE SKIP LOCKED` so N backend replicas
 * share one outbox without double-sending.
 *
 * EVERY method that mutates a row's status routes through the typed state
 * machine (`assertTransition`) so an illegal move is caught, not written.
 *
 * NOTE: the SKIP-LOCKED claim and coalescing require a real Postgres; those
 * paths are exercised by the CI-gated integration suite. The pure shaping and
 * backoff logic are unit-tested with a mocked Prisma.
 */

export type OutboxRow = Prisma.NotificationOutboxGetPayload<Record<string, never>>;

export type EnqueueOutcome = 'created' | 'deduped';

@Injectable()
export class OutboxService {
  private readonly log = new Logger(OutboxService.name);
  /** Retry policy — a field (not a DI param) so the class needs only Prisma. */
  private readonly backoff: BackoffConfig = DEFAULT_BACKOFF;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Insert one outbox row, idempotent on `dedupeKey`. A double-enqueue (the
   * socket producer and the HTTP publish producer for the same event) is a
   * no-op, not a duplicate notification.
   */
  async enqueue(routed: RoutedNotification): Promise<EnqueueOutcome> {
    try {
      await this.prisma.notificationOutbox.create({
        data: {
          recipientId: routed.recipientId,
          roomId: routed.roomId ?? null,
          eventSeq: routed.eventSeq ?? null,
          eventClass: routed.class,
          actorId: routed.actorId ?? null,
          dedupeKey: routed.dedupeKey,
          collapseKey: routed.collapseKey,
          priority: routed.priority,
          ttlSeconds: routed.ttlSeconds,
          status: 'queued',
        },
      });
      return 'created';
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // Unique dedupeKey collision — the event is already queued.
        return 'deduped';
      }
      throw err;
    }
  }

  /**
   * Claim up to `limit` due rows atomically. The CTE takes a row-level lock with
   * SKIP LOCKED so concurrent workers never grab the same row, then flips them to
   * `sending` and returns them. This is the canonical Postgres work-queue claim.
   */
  async claimDue(limit: number): Promise<OutboxRow[]> {
    const rows = await this.prisma.$queryRaw<OutboxRow[]>(Prisma.sql`
      WITH due AS (
        SELECT id FROM "NotificationOutbox"
        WHERE status = 'queued' AND "nextAttemptAt" <= now()
        ORDER BY "nextAttemptAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "NotificationOutbox" o
      SET status = 'sending', "updatedAt" = now()
      FROM due
      WHERE o.id = due.id
      RETURNING o.*;
    `);
    return rows;
  }

  /** sending → sent (provider accepted). */
  async markSent(id: string): Promise<void> {
    assertTransition('sending', 'sent');
    await this.prisma.notificationOutbox.updateMany({
      where: { id, status: 'sending' },
      data: { status: 'sent', updatedAt: new Date() },
    });
  }

  /**
   * sending → queued (transient error). Schedules the next attempt with
   * exponential backoff + full jitter, or dead-letters once attempts exhaust.
   * Returns the resulting state so the worker can emit the right metric.
   */
  async markTransientRetry(
    row: Pick<OutboxRow, 'id' | 'attempts'>,
    code?: string,
  ): Promise<'queued' | 'abandoned'> {
    const attempts = row.attempts + 1;
    if (isExhausted(attempts, this.backoff)) {
      assertTransition('queued', 'abandoned');
      await this.prisma.notificationOutbox.updateMany({
        where: { id: row.id },
        data: {
          status: 'abandoned',
          attempts,
          lastError: code ?? null,
          updatedAt: new Date(),
        },
      });
      return 'abandoned';
    }
    assertTransition('sending', 'queued');
    const delay = nextBackoffMs(attempts, this.backoff);
    await this.prisma.notificationOutbox.updateMany({
      where: { id: row.id },
      data: {
        status: 'queued',
        attempts,
        nextAttemptAt: new Date(Date.now() + delay),
        lastError: code ?? null,
        updatedAt: new Date(),
      },
    });
    return 'queued';
  }

  /** sending → failed (permanent error; the dead token is pruned separately). */
  async markPermanentFailure(id: string, code?: string): Promise<void> {
    assertTransition('sending', 'failed');
    await this.prisma.notificationOutbox.updateMany({
      where: { id, status: 'sending' },
      data: { status: 'failed', lastError: code ?? null, updatedAt: new Date() },
    });
  }

  /** queued → suppressed (prefs/DND/flag-off at claim). */
  async markSuppressed(id: string, reason: string): Promise<void> {
    assertTransition('queued', 'suppressed');
    await this.prisma.notificationOutbox.updateMany({
      where: { id, status: { in: ['queued', 'sending'] } },
      data: { status: 'suppressed', lastError: reason, updatedAt: new Date() },
    });
  }

  /**
   * Coalesce a burst: keep the newest queued row for a (recipient, collapseKey)
   * group, sum the counts onto it, and mark the older rows `collapsed`. Turns
   * "10 messages typed fast" into "3 new messages" server-side (design §8.5).
   * A no-op for classes whose collapse strategy is `never` (the caller checks).
   */
  async coalesceQueued(recipientId: string, collapseKey: string): Promise<number> {
    const queued = await this.prisma.notificationOutbox.findMany({
      where: { recipientId, collapseKey, status: 'queued' },
      orderBy: [{ eventSeq: 'desc' }, { createdAt: 'desc' }],
    });
    if (queued.length <= 1) return 0;

    const [keep, ...older] = queued;
    const total = queued.reduce((n, r) => n + r.count, 0);
    assertTransition('queued', 'collapsed');
    await this.prisma.$transaction([
      this.prisma.notificationOutbox.update({
        where: { id: keep.id },
        data: { count: total, updatedAt: new Date() },
      }),
      this.prisma.notificationOutbox.updateMany({
        where: { id: { in: older.map((r) => r.id) } },
        data: { status: 'collapsed', updatedAt: new Date() },
      }),
    ]);
    return older.length;
  }

  /** Current depth by status — for the health endpoint / gauges (§13). */
  async depthByStatus(): Promise<Record<string, number>> {
    const grouped = await this.prisma.notificationOutbox.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const g of grouped) out[g.status] = g._count._all;
    return out;
  }

  /** Assert a status change is legal (exposed for the worker/receipts path). */
  validateTransition(from: NotificationState, to: NotificationState): void {
    assertTransition(from, to);
  }
}
