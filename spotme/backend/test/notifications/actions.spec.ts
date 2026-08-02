import {
  actionEffect,
  actionsFor,
  ALL_ACTIONS,
  isNotificationAction,
} from '../../src/notifications/actions/notification-actions';
import { ReceiptService } from '../../src/notifications/receipts/receipt.service';
import { NotificationCatalog } from '../../src/notifications/catalog/notification-catalog';
import { NotificationMetrics } from '../../src/notifications/metrics/metrics.service';
import { NotificationFlags } from '../../src/notifications/notifications.config';

/**
 * Typed notification actions: the per-class action set (a call gets
 * accept/decline, never reply), the media-kind extensions, and the mapping from
 * an action to its opaque receipt event + canonical state transition.
 */

describe('notification actions catalog', () => {
  it('gives a call accept/decline and a message reply/read/mute/archive', () => {
    expect(actionsFor('call')).toEqual(['accept', 'decline']);
    expect(actionsFor('message')).toEqual(['markRead', 'inlineReply', 'mute', 'archive']);
  });

  it('extends the set for media kinds', () => {
    expect(actionsFor('message', 'photo')).toContain('openMedia');
    expect(actionsFor('message', 'voice')).toContain('playVoice');
    expect(actionsFor('message', 'photo')).toContain('markRead'); // base kept
  });

  it('maps engagement to opened and refusal to dismissed; pref ops move no state', () => {
    expect(actionEffect('markRead').state).toBe('opened');
    expect(actionEffect('accept').state).toBe('opened');
    expect(actionEffect('decline').state).toBe('dismissed');
    expect(actionEffect('mute').state).toBeUndefined();
    expect(actionEffect('archive').state).toBeUndefined();
  });

  it('recognises exactly the declared actions', () => {
    for (const a of ALL_ACTIONS) expect(isNotificationAction(a)).toBe(true);
    expect(isNotificationAction('nope')).toBe(false);
  });
});

describe('ReceiptService.recordAction (mocked Prisma)', () => {
  const catalog = new NotificationCatalog();
  const metrics = new NotificationMetrics();

  function make(row: Record<string, unknown> | null) {
    const outbox = {
      findUnique: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const prisma = {
      notificationOutbox: outbox,
      notificationReceipt: { create: jest.fn().mockResolvedValue({}) },
    };
    const svc = new ReceiptService(
      prisma as never,
      { enabled: true } as NotificationFlags,
      catalog,
      metrics,
    );
    return { svc, prisma, outbox };
  }

  it('advances a delivered call to dismissed on decline', async () => {
    const { svc, outbox } = make({ id: 'n1', status: 'delivered', eventClass: 'call' });
    const res = await svc.recordAction('devA', 'apns', 'n1', 'decline');
    expect(res.accepted).toBe(1);
    expect(outbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'dismissed' }) }),
    );
  });

  it('rejects an unknown action, counts it, records nothing', async () => {
    const { svc, prisma } = make({ id: 'n1', status: 'delivered', eventClass: 'message' });
    const res = await svc.recordAction('devA', 'fcm', 'n1', 'sudo-rm');
    expect(res).toEqual({ accepted: 0, rejected: 1 });
    expect(prisma.notificationReceipt.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown notifId (counted, not detailed)', async () => {
    const { svc } = make(null);
    const res = await svc.recordAction('devA', 'fcm', 'ghost', 'markRead');
    expect(res).toEqual({ accepted: 0, rejected: 1 });
  });

  it('records a mute action without moving the delivery state', async () => {
    const { svc, outbox } = make({ id: 'n1', status: 'sent', eventClass: 'message' });
    const res = await svc.recordAction('devA', 'fcm', 'n1', 'mute');
    expect(res.accepted).toBe(1);
    expect(outbox.updateMany).not.toHaveBeenCalled(); // no state transition
  });
});
