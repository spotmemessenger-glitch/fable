import { NotificationHealthService } from '../../src/notifications/health/health.service';
import { NotificationFlags } from '../../src/notifications/notifications.config';

/**
 * Liveness is dependency-free ("the process is up"); readiness is "can we
 * deliver" — DB reachable AND at least one transport available. Every probe is
 * failure-tolerant (never throws) and content-free (counts + booleans only).
 */

function make(opts: {
  enabled: boolean;
  dbUp: boolean;
  transports: Array<{ name: string; available: boolean }>;
}) {
  const prisma = {
    $queryRawUnsafe: opts.dbUp
      ? jest.fn().mockResolvedValue([{ '?column?': 1 }])
      : jest.fn().mockRejectedValue(new Error('db down')),
  };
  const registry = { all: () => opts.transports.map((t) => ({ ...t, available: () => t.available })) };
  const outbox = { depthByStatus: jest.fn().mockResolvedValue({ queued: 2, sent: 5 }) };
  const flags = { enabled: opts.enabled } as NotificationFlags;
  return new NotificationHealthService(prisma as never, registry as never, outbox as never, flags);
}

describe('NotificationHealthService', () => {
  it('liveness is always ok with an uptime', () => {
    const svc = make({ enabled: true, dbUp: true, transports: [] });
    const live = svc.liveness();
    expect(live.status).toBe('ok');
    expect(live.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('readiness is ok when enabled, DB up, and a transport is available', async () => {
    const svc = make({
      enabled: true,
      dbUp: true,
      transports: [{ name: 'fcm', available: true }, { name: 'apns', available: false }],
    });
    const r = await svc.readiness();
    expect(r.status).toBe('ok');
    expect(r.db).toBe(true);
    expect(r.transportsReady).toBe(true);
    expect(r.outbox).toEqual({ queued: 2, sent: 5 });
  });

  it('readiness is degraded when the DB is unreachable', async () => {
    const svc = make({
      enabled: true,
      dbUp: false,
      transports: [{ name: 'fcm', available: true }],
    });
    const r = await svc.readiness();
    expect(r.status).toBe('degraded');
    expect(r.db).toBe(false);
    expect(r.outbox).toBeUndefined(); // not probed when DB is down
  });

  it('readiness is degraded when no transport can send', async () => {
    const svc = make({
      enabled: true,
      dbUp: true,
      transports: [{ name: 'fcm', available: false }, { name: 'webpush', available: false }],
    });
    const r = await svc.readiness();
    expect(r.status).toBe('degraded');
    expect(r.transportsReady).toBe(false);
  });

  it('readiness is trivially ok when the platform is disabled (nothing to do)', async () => {
    const svc = make({ enabled: false, dbUp: false, transports: [] });
    const r = await svc.readiness();
    expect(r.status).toBe('ok');
    expect(r.enabled).toBe(false);
  });
});
