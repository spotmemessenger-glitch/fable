import { Prisma } from '@prisma/client';
import { OutboxService } from '../../src/notifications/outbox/outbox.service';
import { OutboxWorker } from '../../src/notifications/outbox/outbox.worker';
import { NotificationCatalog } from '../../src/notifications/catalog/notification-catalog';
import { NotificationMetrics } from '../../src/notifications/metrics/metrics.service';
import { ContentlessEnvelopeBuilder } from '../../src/notifications/envelope/contentless-envelope.builder';
import { RoutedNotification } from '../../src/notifications/routing/notification-router';

/**
 * Outbox logic against a MOCKED Prisma. The SKIP-LOCKED claim SQL itself needs a
 * real Postgres (CI-gated integration); here we pin the pure reconciliation:
 * dedupe, backoff-or-abandon, coalescing, and the worker's send→state mapping.
 */

const routed = (over: Partial<RoutedNotification> = {}): RoutedNotification => ({
  class: 'message',
  recipientId: 'uB',
  roomId: 'r1',
  eventSeq: 1,
  actorId: 'uA',
  priority: 'high',
  ttlSeconds: 3600,
  dedupeKey: 'uB:message:r1#1',
  collapseKey: 'uB:room:r1',
  wireCollapseId: 'opaque',
  route: 'thread/r1',
  title: 'Alice',
  body: 'New message',
  ...over,
});

describe('OutboxService (mocked Prisma)', () => {
  describe('enqueue idempotency', () => {
    it('returns "created" on a fresh insert', async () => {
      const prisma = { notificationOutbox: { create: jest.fn().mockResolvedValue({}) } };
      const svc = new OutboxService(prisma as never);
      expect(await svc.enqueue(routed())).toBe('created');
      expect(prisma.notificationOutbox.create).toHaveBeenCalledTimes(1);
    });

    it('returns "deduped" on a unique-key (P2002) collision', async () => {
      const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      });
      const prisma = { notificationOutbox: { create: jest.fn().mockRejectedValue(p2002) } };
      const svc = new OutboxService(prisma as never);
      expect(await svc.enqueue(routed())).toBe('deduped');
    });

    it('rethrows a non-unique error', async () => {
      const prisma = {
        notificationOutbox: { create: jest.fn().mockRejectedValue(new Error('db down')) },
      };
      const svc = new OutboxService(prisma as never);
      await expect(svc.enqueue(routed())).rejects.toThrow('db down');
    });
  });

  describe('transient retry vs abandon', () => {
    it('reschedules with backoff while attempts remain', async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const svc = new OutboxService({ notificationOutbox: { updateMany } } as never);
      const outcome = await svc.markTransientRetry({ id: 'x', attempts: 1 }, '503');
      expect(outcome).toBe('queued');
      const data = updateMany.mock.calls[0][0].data;
      expect(data.status).toBe('queued');
      expect(data.attempts).toBe(2);
      expect(data.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(Date.now() - 10);
    });

    it('dead-letters (abandoned) once attempts are exhausted', async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const svc = new OutboxService({ notificationOutbox: { updateMany } } as never);
      const outcome = await svc.markTransientRetry({ id: 'x', attempts: 5 }, '503');
      expect(outcome).toBe('abandoned');
      expect(updateMany.mock.calls[0][0].data.status).toBe('abandoned');
    });
  });

  describe('coalesceQueued', () => {
    it('keeps the newest queued row, sums counts, collapses the rest', async () => {
      const rows = [
        { id: 'c', eventSeq: 3, count: 1 },
        { id: 'b', eventSeq: 2, count: 1 },
        { id: 'a', eventSeq: 1, count: 1 },
      ];
      const update = jest.fn().mockResolvedValue({});
      const updateMany = jest.fn().mockResolvedValue({ count: 2 });
      const prisma = {
        notificationOutbox: {
          findMany: jest.fn().mockResolvedValue(rows),
          update,
          updateMany,
        },
        $transaction: jest.fn().mockImplementation((ops: unknown[]) => Promise.all(ops)),
      };
      const svc = new OutboxService(prisma as never);
      const collapsed = await svc.coalesceQueued('uB', 'uB:room:r1');
      expect(collapsed).toBe(2);
      expect(update).toHaveBeenCalledWith({
        where: { id: 'c' },
        data: expect.objectContaining({ count: 3 }),
      });
    });

    it('is a no-op with a single queued row', async () => {
      const prisma = {
        notificationOutbox: { findMany: jest.fn().mockResolvedValue([{ id: 'a', count: 1 }]) },
      };
      const svc = new OutboxService(prisma as never);
      expect(await svc.coalesceQueued('uB', 'k')).toBe(0);
    });
  });
});

describe('OutboxWorker.drainOnce (mocked deps)', () => {
  function makeWorker(dispatchResult: unknown[], targets = [{ deviceId: 'd', token: 't', platform: 'android' as const }]) {
    const outbox = {
      claimDue: jest.fn().mockResolvedValue([
        {
          id: 'ntf1',
          recipientId: 'uB',
          roomId: 'r1',
          eventSeq: 1,
          eventClass: 'message',
          actorId: 'uA',
          dedupeKey: 'd',
          collapseKey: 'ck',
          priority: 'high',
          ttlSeconds: 3600,
          status: 'sending',
          count: 1,
          attempts: 0,
        },
      ]),
      markSent: jest.fn().mockResolvedValue(undefined),
      markTransientRetry: jest.fn().mockResolvedValue('queued'),
      markPermanentFailure: jest.fn().mockResolvedValue(undefined),
      markSuppressed: jest.fn().mockResolvedValue(undefined),
    };
    const registry = { dispatch: jest.fn().mockResolvedValue(dispatchResult) };
    const devices = {
      targetsFor: jest.fn().mockResolvedValue(targets),
      prune: jest.fn().mockResolvedValue(undefined),
    };
    const worker = new OutboxWorker(
      { outboxEnabled: true } as never,
      outbox as never,
      registry as never,
      new ContentlessEnvelopeBuilder(),
      devices as never,
      new NotificationCatalog(),
      new NotificationMetrics(),
    );
    return { worker, outbox, devices, registry };
  }

  it('marks a row sent when the provider accepts', async () => {
    const { worker, outbox } = makeWorker([
      { notifId: 'ntf1', deviceId: 'd', transport: 'fcm', ok: true, providerId: 'm1' },
    ]);
    const res = await worker.drainOnce(100);
    expect(res).toEqual({ claimed: 1, sent: 1 });
    expect(outbox.markSent).toHaveBeenCalledWith('ntf1');
  });

  it('retries a transient failure without pruning the token', async () => {
    const { worker, outbox, devices } = makeWorker([
      { notifId: 'ntf1', deviceId: 'd', transport: 'fcm', ok: false, failure: { statusCode: 503 } },
    ]);
    await worker.drainOnce(100);
    expect(outbox.markTransientRetry).toHaveBeenCalled();
    expect(devices.prune).not.toHaveBeenCalled();
  });

  it('prunes the token on a permanent failure', async () => {
    const { worker, outbox, devices } = makeWorker([
      {
        notifId: 'ntf1',
        deviceId: 'd',
        transport: 'fcm',
        ok: false,
        failure: { code: 'messaging/registration-token-not-registered' },
      },
    ]);
    await worker.drainOnce(100);
    expect(outbox.markPermanentFailure).toHaveBeenCalledWith('ntf1', expect.any(String));
    expect(devices.prune).toHaveBeenCalledWith('d', 'fcm');
  });

  it('suppresses a row when the recipient has no reachable device', async () => {
    const { worker, outbox } = makeWorker([], []);
    const res = await worker.drainOnce(100);
    expect(outbox.markSuppressed).toHaveBeenCalledWith('ntf1', 'no-target');
    expect(res.sent).toBe(0);
  });
});
