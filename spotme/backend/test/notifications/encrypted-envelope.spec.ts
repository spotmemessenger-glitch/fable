import { EncryptedEnvelopeBuilder } from '../../src/notifications/envelope/encrypted-envelope.builder';
import { NotificationFlags } from '../../src/notifications/notifications.config';
import {
  generateNotifKeypair,
  unsealRichPayload,
} from '../../src/notifications/envelope/notif-crypto';
import { SealedEnvelope } from '../../src/notifications/envelope/rich-payload.types';
import { RoutedNotification } from '../../src/notifications/routing/notification-router';

/**
 * The GATED encrypted builder. Proves: (1) both flags off ⇒ throws, no seal;
 * (2) enabled + registered key ⇒ sealed `data.e` the device unseals to the rich
 * payload, with a content-less visible fallback; (3) enabled + NO key ⇒ the
 * content-less floor (graceful degrade). The visible title/body are ALWAYS the
 * generic catalog strings.
 */

const routed: RoutedNotification = {
  class: 'message',
  recipientId: 'uB',
  roomId: 'room-42',
  eventSeq: 7,
  actorId: 'uA',
  priority: 'high',
  ttlSeconds: 3600,
  dedupeKey: 'd',
  collapseKey: 'ck',
  wireCollapseId: 'opaque16charsXX',
  route: 'thread/room-42',
  title: 'Alice',
  body: 'New message',
};

describe('EncryptedEnvelopeBuilder (gated)', () => {
  const ON = { NOTIFICATIONS_V2_ENABLED: 'true', NOTIF_ENCRYPTED_PAYLOAD_ENABLED: 'true' };

  function withEnv<T>(env: Record<string, string>, fn: () => T): T {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
      saved[k] = process.env[k];
      process.env[k] = env[k];
    }
    try {
      return fn();
    } finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }

  it('throws when the sub-flag is off (default), even with a key present', () => {
    withEnv({ NOTIFICATIONS_V2_ENABLED: 'true' }, () => {
      const builder = new EncryptedEnvelopeBuilder(new NotificationFlags());
      expect(() =>
        builder.build({
          routed,
          target: { deviceId: 'd', token: 't', notifPublicKey: 'x' },
          notifId: 'n',
          count: 1,
        }),
      ).toThrow(/gated/i);
    });
  });

  it('seals a rich payload the device unseals, with a content-less visible fallback', () => {
    withEnv(ON, () => {
      const device = generateNotifKeypair();
      const builder = new EncryptedEnvelopeBuilder(new NotificationFlags());
      const msg = builder.build({
        routed,
        target: { deviceId: 'd', token: 't', notifPublicKey: device.publicKeySpki },
        notifId: 'ntf_1',
        count: 3,
        actions: ['reply', 'mute'],
      });

      // Visible fallback is generic.
      expect(msg.title).toBe('Alice');
      expect(msg.body).toBe('New message');
      // The sealed blob rides in data.e, opaque.
      expect(msg.data.e).toBeDefined();
      expect(msg.data.e).not.toContain('room-42');
      const sealed = JSON.parse(msg.data.e as string) as SealedEnvelope;

      const opened = unsealRichPayload(device.privateKey, sealed, 'ntf_1');
      expect(opened.class).toBe('message');
      expect(opened.room).toBe('room-42');
      expect(opened.route).toBe('thread/room-42');
      expect(opened.actor).toBe('Alice');
      expect(opened.count).toBe(3);
      expect(opened.seq).toBe(7);
      expect(opened.actions).toEqual(['reply', 'mute']);
    });
  });

  it('degrades to the content-less floor when the device registered no key', () => {
    withEnv(ON, () => {
      const builder = new EncryptedEnvelopeBuilder(new NotificationFlags());
      const msg = builder.build({
        routed,
        target: { deviceId: 'd', token: 't' }, // no notifPublicKey
        notifId: 'ntf_1',
        count: 1,
      });
      expect(msg.data.e).toBeUndefined();
      expect(Object.keys(msg.data).sort()).toEqual(['c', 'k', 'n']);
    });
  });
});
