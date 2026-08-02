import { NotificationService } from '../../src/notifications/notification.service';
import { NotificationCatalog } from '../../src/notifications/catalog/notification-catalog';
import { NotificationRouter } from '../../src/notifications/routing/notification-router';
import { NotificationMetrics } from '../../src/notifications/metrics/metrics.service';
import { NotificationEvent } from '../../src/notifications/routing/notification-event';

/**
 * The orchestrator, proving the platform is INERT by default and that the flag
 * and preference gates decide send-vs-suppress while the routing is always
 * computed (ADR-007 "verdict always computed").
 */

const catalog = new NotificationCatalog();
const router = new NotificationRouter(catalog);
const metrics = new NotificationMetrics();

function make(
  flags: Partial<{ enabled: boolean; classEnabled: (c: string) => boolean }>,
  prefsDeliver = true,
  reason?: string,
  enqueueResult: 'created' | 'deduped' = 'created',
) {
  const prefs = {
    decide: jest.fn().mockResolvedValue(
      prefsDeliver ? { deliver: true } : { deliver: false, reason },
    ),
  };
  const outbox = {
    enqueue: jest.fn().mockResolvedValue(enqueueResult),
    coalesceQueued: jest.fn().mockResolvedValue(0),
  };
  const flagObj = {
    enabled: flags.enabled ?? false,
    classEnabled: flags.classEnabled ?? (() => true),
  };
  const svc = new NotificationService(
    flagObj as never,
    catalog,
    router,
    prefs as never,
    outbox as never,
    metrics,
  );
  return { svc, prefs, outbox };
}

const event: NotificationEvent = {
  class: 'message',
  recipientId: 'uB',
  roomId: 'r1',
  eventSeq: 1,
  actorName: 'Alice',
};

describe('NotificationService.enqueue', () => {
  it('is INERT when the master flag is off (the default) — nothing is touched', async () => {
    const { svc, prefs, outbox } = make({ enabled: false });
    const res = await svc.enqueue(event);
    expect(res.outcome).toBe('disabled');
    expect(prefs.decide).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('suppresses (reason=flag) when the class flag is off, but still computes routing', async () => {
    const { svc, outbox } = make({ enabled: true, classEnabled: () => false });
    const res = await svc.enqueue(event);
    expect(res.outcome).toBe('suppressed');
    expect(res.reason).toBe('flag');
    expect(res.routed?.dedupeKey).toBe(router.deriveDedupeKey(event)); // computed anyway
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('suppresses when preferences say no (e.g. muted)', async () => {
    const { svc, outbox } = make({ enabled: true }, false, 'mute');
    const res = await svc.enqueue(event);
    expect(res.outcome).toBe('suppressed');
    expect(res.reason).toBe('mute');
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues and coalesces when flag + preferences allow', async () => {
    const { svc, outbox } = make({ enabled: true }, true);
    const res = await svc.enqueue(event);
    expect(res.outcome).toBe('created');
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    // message collapses per-room → coalescing runs.
    expect(outbox.coalesceQueued).toHaveBeenCalledWith('uB', router.deriveCollapseKey(event));
  });
});
