import { NotificationProducer } from '../../src/notifications/producers/notification-producer';
import { PresencePort } from '../../src/notifications/producers/presence.port';
import { NotificationFlags } from '../../src/notifications/notifications.config';
import { NotificationService } from '../../src/notifications/notification.service';

/**
 * Producers are FLAG-GATED and INERT by default. With the master flag off,
 * nothing enqueues (the byte-identical guarantee at the event source). With it
 * on, one event per recipient is enqueued, at the right class.
 */

function make(enabled: boolean, presence?: PresencePort) {
  const flags = { enabled } as NotificationFlags;
  const enqueue = jest.fn().mockResolvedValue({ outcome: 'created' });
  const notifications = { enqueue } as unknown as NotificationService;
  const producer = new NotificationProducer(flags, notifications, presence);
  return { producer, enqueue };
}

describe('NotificationProducer gating', () => {
  it('enqueues NOTHING when the master flag is off', async () => {
    const { producer, enqueue } = make(false);
    const n = await producer.onMessage('r1', 'uA', 'Alice', 1, ['uB', 'uC']);
    expect(n).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(producer.enabled).toBe(false);
  });

  it('enqueues one event per recipient when enabled, with the right class', async () => {
    const { producer, enqueue } = make(true);
    const n = await producer.onMessage('r1', 'uA', 'Alice', 1, ['uB', 'uC']);
    expect(n).toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls.every((c) => c[0].class === 'message')).toBe(true);
    expect(enqueue.mock.calls.map((c) => c[0].recipientId).sort()).toEqual(['uB', 'uC']);
  });

  it('routes each typed producer to its class', async () => {
    const { producer, enqueue } = make(true);
    await producer.onKnock('r1', 'uA', 'Alice', ['uB']);
    await producer.onMention('r1', 'uA', 'Alice', 2, ['uB']);
    await producer.onReply('r1', 'uA', 'Alice', 3, ['uB']);
    await producer.onReaction('r1', 'uA', 'Alice', 4, ['uB']);
    await producer.onCall('r1', 'call-9', 'uA', 'Alice', ['uB']);
    await producer.onSecurity('uB');
    await producer.onLogin('uB');
    await producer.onVerification('uB');
    const classes = enqueue.mock.calls.map((c) => c[0].class);
    expect(classes).toEqual([
      'knock',
      'mention',
      'reply',
      'reaction',
      'call',
      'security',
      'login',
      'verification',
    ]);
    // The call carries its callId in meta (never content).
    const call = enqueue.mock.calls.find((c) => c[0].class === 'call');
    expect(call?.[0].meta.callId).toBe('call-9');
  });

  it('resolveAbsent uses the PresencePort to drop connected users', async () => {
    const presence: PresencePort = { connectedUsers: () => new Set(['uConnected']) };
    const { producer } = make(true, presence);
    const absent = await producer.resolveAbsent(['uConnected', 'uAway']);
    expect(absent).toEqual(['uAway']);
  });

  it('resolveAbsent returns all when no PresencePort is wired', async () => {
    const { producer } = make(true);
    expect(await producer.resolveAbsent(['uA', 'uB'])).toEqual(['uA', 'uB']);
  });
});
