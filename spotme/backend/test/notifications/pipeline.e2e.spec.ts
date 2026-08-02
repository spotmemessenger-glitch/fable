import { Prisma } from '@prisma/client';
import { NotificationService } from '../../src/notifications/notification.service';
import { NotificationCatalog } from '../../src/notifications/catalog/notification-catalog';
import { NotificationRouter } from '../../src/notifications/routing/notification-router';
import { NotificationMetrics } from '../../src/notifications/metrics/metrics.service';
import { OutboxService } from '../../src/notifications/outbox/outbox.service';
import { OutboxWorker } from '../../src/notifications/outbox/outbox.worker';
import { DeviceTargetService } from '../../src/notifications/devices/device-target.service';
import { ReceiptService } from '../../src/notifications/receipts/receipt.service';
import { PreferenceService } from '../../src/notifications/preferences/preference.service';
import { PreferenceEvaluator } from '../../src/notifications/preferences/preference-evaluator';
import { ContentlessEnvelopeBuilder } from '../../src/notifications/envelope/contentless-envelope.builder';
import { TransportRegistry } from '../../src/notifications/transport/transport-registry';
import { FcmTransport } from '../../src/notifications/transport/fcm.transport';
import { ApnsTransport } from '../../src/notifications/transport/apns.transport';
import { WebPushTransport } from '../../src/notifications/transport/web-push.transport';
import { DesktopTransport } from '../../src/notifications/transport/desktop.transport';
import { OneSignalTransport } from '../../src/notifications/transport/onesignal.transport';
import { NovuTransport } from '../../src/notifications/transport/novu.transport';
import { NotificationFlags } from '../../src/notifications/notifications.config';
import {
  FcmMessaging,
  FcmMulticastMessage,
  FcmMulticastResponse,
} from '../../src/notifications/transport/firebase';

/**
 * END-TO-END STYLE: enqueue → outbox → transport → receipt, with the REAL
 * services (router, outbox, worker, registry, envelope, receipts) and ONLY the
 * DB driver and the push providers faked. This is the flow the "production-grade"
 * claim rests on, exercised deterministically with no Postgres and no network.
 * The real SKIP-LOCKED SQL is CI-gated; this in-memory claim mirrors its
 * semantics (claim due `queued` rows, flip to `sending`).
 */

// ── a minimal in-memory Prisma double ────────────────────────────────────────

interface Row {
  id: string;
  recipientId: string;
  roomId: string | null;
  eventSeq: number | null;
  eventClass: string;
  actorId: string | null;
  dedupeKey: string;
  collapseKey: string;
  priority: string;
  ttlSeconds: number;
  status: string;
  count: number;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function matches(row: Record<string, unknown> | Row, where: Record<string, unknown>): boolean {
  const r = row as Record<string, unknown>;
  for (const [k, v] of Object.entries(where)) {
    if (v && typeof v === 'object' && 'in' in (v as object)) {
      if (!(v as { in: unknown[] }).in.includes(r[k])) return false;
    } else if (r[k] !== v) {
      return false;
    }
  }
  return true;
}

class InMemoryDb {
  outboxRows: Row[] = [];
  receipts: Array<{ outboxId: string; deviceId: string; event: string }> = [];
  tokens: Array<{ id: string; userId: string; token: string; platform: string }> = [];
  subs: Array<{ id: string; userId: string; endpoint: string; p256dh: string; auth: string }> = [];
  private seq = 0;
  private id(p: string): string {
    return `${p}${++this.seq}`;
  }

  notificationOutbox = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (this.outboxRows.some((r) => r.dedupeKey === data.dedupeKey)) {
        throw new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      const now = new Date();
      const row: Row = {
        id: this.id('ntf_'),
        recipientId: String(data.recipientId),
        roomId: (data.roomId as string) ?? null,
        eventSeq: (data.eventSeq as number) ?? null,
        eventClass: String(data.eventClass),
        actorId: (data.actorId as string) ?? null,
        dedupeKey: String(data.dedupeKey),
        collapseKey: String(data.collapseKey),
        priority: String(data.priority),
        ttlSeconds: Number(data.ttlSeconds),
        status: (data.status as string) ?? 'queued',
        count: 1,
        attempts: 0,
        nextAttemptAt: now,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
      this.outboxRows.push(row);
      return { ...row };
    },
    findUnique: async ({ where }: { where: { id: string } }) => {
      const r = this.outboxRows.find((x) => x.id === where.id);
      return r ? { ...r } : null;
    },
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      this.outboxRows.filter((r) => matches(r, where)).map((r) => ({ ...r })),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = this.outboxRows.find((x) => x.id === where.id);
      if (r) Object.assign(r, data);
      return r ? { ...r } : null;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      let count = 0;
      for (const r of this.outboxRows) {
        if (matches(r, where)) {
          Object.assign(r, data);
          count += 1;
        }
      }
      return { count };
    },
    groupBy: async () => {
      const by = new Map<string, number>();
      for (const r of this.outboxRows) by.set(r.status, (by.get(r.status) ?? 0) + 1);
      return [...by.entries()].map(([status, n]) => ({ status, _count: { _all: n } }));
    },
  };

  notificationReceipt = {
    create: async ({ data }: { data: { outboxId: string; deviceId: string; event: string } }) => {
      if (
        this.receipts.some(
          (r) => r.outboxId === data.outboxId && r.deviceId === data.deviceId && r.event === data.event,
        )
      ) {
        throw new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      this.receipts.push({ outboxId: data.outboxId, deviceId: data.deviceId, event: data.event });
      return { ...data };
    },
  };

  // No stored prefs ⇒ safe defaults (deliver-all, no DND/focus).
  notificationPreference = { findUnique: async () => null };
  conversationNotifPref = { findUnique: async () => null };

  deviceToken = {
    findMany: async ({ where }: { where: { userId: string } }) =>
      this.tokens.filter((t) => t.userId === where.userId).map((t) => ({ ...t })),
    deleteMany: async ({ where }: { where: { id: string } }) => {
      const n = this.tokens.length;
      this.tokens = this.tokens.filter((t) => t.id !== where.id);
      return { count: n - this.tokens.length };
    },
  };

  pushSubscription = {
    findMany: async ({ where }: { where: { userId: string } }) =>
      this.subs.filter((s) => s.userId === where.userId).map((s) => ({ ...s })),
    deleteMany: async ({ where }: { where: { id: string } }) => {
      const n = this.subs.length;
      this.subs = this.subs.filter((s) => s.id !== where.id);
      return { count: n - this.subs.length };
    },
  };

  async $transaction(ops: Promise<unknown>[]): Promise<unknown[]> {
    return Promise.all(ops);
  }

  // The ONLY raw query in the module is claimDue. Mirror its semantics.
  async $queryRaw(): Promise<Row[]> {
    const now = Date.now();
    const due = this.outboxRows.filter(
      (r) => r.status === 'queued' && r.nextAttemptAt.getTime() <= now,
    );
    for (const r of due) r.status = 'sending';
    return due.map((r) => ({ ...r }));
  }
}

function fakeFcm(
  plan: (msg: FcmMulticastMessage) => FcmMulticastResponse['responses'],
): FcmMessaging {
  return {
    async sendEachForMulticast(msg) {
      const responses = plan(msg);
      return {
        responses,
        successCount: responses.filter((r) => r.success).length,
        failureCount: responses.filter((r) => !r.success).length,
      };
    },
  };
}

function buildStack(db: InMemoryDb, messaging: FcmMessaging) {
  const flags = { enabled: true, outboxEnabled: true, classEnabled: () => true } as unknown as NotificationFlags;
  const catalog = new NotificationCatalog();
  const router = new NotificationRouter(catalog);
  const metrics = new NotificationMetrics();
  const outbox = new OutboxService(db as never);
  const prefs = new PreferenceService(db as never, flags, catalog, new PreferenceEvaluator());
  const devices = new DeviceTargetService(db as never);
  const registry = new TransportRegistry(
    new FcmTransport(messaging),
    new ApnsTransport(undefined),
    new WebPushTransport(undefined),
    new DesktopTransport(),
    new OneSignalTransport(),
    new NovuTransport(),
  );
  const service = new NotificationService(flags, catalog, router, prefs, outbox, metrics);
  const worker = new OutboxWorker(
    flags,
    outbox,
    registry,
    new ContentlessEnvelopeBuilder(),
    devices,
    catalog,
    metrics,
  );
  const receipts = new ReceiptService(db as never, flags, catalog, metrics);
  return { service, worker, receipts, metrics };
}

describe('enqueue → outbox → transport → receipt (mocked providers)', () => {
  it('delivers a message end-to-end and advances state on the receipt', async () => {
    const db = new InMemoryDb();
    db.tokens.push({ id: 'devA', userId: 'uB', token: 'tok-A', platform: 'android' });
    const { service, worker, receipts } = buildStack(
      db,
      fakeFcm((m) => m.tokens.map(() => ({ success: true, messageId: 'm1' }))),
    );

    // ENQUEUE
    const enq = await service.enqueue({
      class: 'message',
      recipientId: 'uB',
      roomId: 'r1',
      eventSeq: 1,
      actorName: 'Alice',
    });
    expect(enq.outcome).toBe('created');
    expect(db.outboxRows).toHaveLength(1);
    const notifId = db.outboxRows[0].id;

    // OUTBOX → TRANSPORT
    const drained = await worker.drainOnce(100);
    expect(drained).toEqual({ claimed: 1, sent: 1 });
    expect(db.outboxRows[0].status).toBe('sent');

    // RECEIPT: delivered → opened
    await receipts.record('devA', 'fcm', [{ notifId, event: 'delivered' }]);
    expect(db.outboxRows[0].status).toBe('delivered');
    const opened = await receipts.record('devA', 'fcm', [{ notifId, event: 'opened' }]);
    expect(opened.accepted).toBe(1);
    expect(db.outboxRows[0].status).toBe('opened');

    // A user ACTION is recorded and is idempotent.
    const act = await receipts.recordAction('devA', 'fcm', notifId, 'archive');
    expect(act.accepted).toBe(1);
    const dup = await receipts.recordAction('devA', 'fcm', notifId, 'archive');
    expect(dup.accepted).toBe(1); // idempotent
  });

  it('prunes a dead token on a permanent provider failure', async () => {
    const db = new InMemoryDb();
    db.tokens.push({ id: 'devDead', userId: 'uB', token: 'tok-dead', platform: 'android' });
    const { service, worker } = buildStack(
      db,
      fakeFcm(() => [
        { success: false, error: { code: 'messaging/registration-token-not-registered' } },
      ]),
    );

    await service.enqueue({ class: 'message', recipientId: 'uB', roomId: 'r1', eventSeq: 1 });
    await worker.drainOnce(100);

    expect(db.outboxRows[0].status).toBe('failed');
    expect(db.tokens).toHaveLength(0); // dead token pruned
  });

  it('coalesces a burst into one row with a summed count', async () => {
    const db = new InMemoryDb();
    db.tokens.push({ id: 'devA', userId: 'uB', token: 'tok-A', platform: 'android' });
    const { service } = buildStack(db, fakeFcm((m) => m.tokens.map(() => ({ success: true }))));

    for (let seq = 1; seq <= 3; seq++) {
      await service.enqueue({ class: 'message', recipientId: 'uB', roomId: 'r1', eventSeq: seq });
    }
    const queued = db.outboxRows.filter((r) => r.status === 'queued');
    expect(queued).toHaveLength(1); // two older rows collapsed into the newest
    expect(queued[0].count).toBe(3);
  });
});
