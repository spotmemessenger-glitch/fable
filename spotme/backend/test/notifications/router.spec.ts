import { NotificationCatalog } from '../../src/notifications/catalog/notification-catalog';
import { NotificationRouter } from '../../src/notifications/routing/notification-router';
import { NotificationEvent } from '../../src/notifications/routing/notification-event';

/**
 * Routing (design §8.4/§8.5): dedupe keys make double-enqueue safe; collapse
 * keys fold a burst; the on-wire collapse id is OPAQUE (the cleartext tag:roomId
 * leak is closed); transport selection sends natives via FCM and web via
 * web-push.
 */
describe('NotificationRouter', () => {
  const router = new NotificationRouter(new NotificationCatalog());

  const msg = (over: Partial<NotificationEvent> = {}): NotificationEvent => ({
    class: 'message',
    recipientId: 'uB',
    roomId: 'r1',
    eventSeq: 42,
    actorId: 'uA',
    actorName: 'Alice',
    ...over,
  });

  describe('dedupe keys', () => {
    it('are identical for the same event (safe double-enqueue)', () => {
      expect(router.deriveDedupeKey(msg())).toBe(router.deriveDedupeKey(msg()));
    });

    it('differ by recipient, room, seq and class', () => {
      const base = router.deriveDedupeKey(msg());
      expect(router.deriveDedupeKey(msg({ recipientId: 'uC' }))).not.toBe(base);
      expect(router.deriveDedupeKey(msg({ roomId: 'r2' }))).not.toBe(base);
      expect(router.deriveDedupeKey(msg({ eventSeq: 43 }))).not.toBe(base);
      expect(router.deriveDedupeKey(msg({ class: 'mention' }))).not.toBe(base);
    });

    it('keys calls on callId and stories on author (no eventSeq)', () => {
      const call = router.deriveDedupeKey({
        class: 'call',
        recipientId: 'uB',
        meta: { callId: 'c1' },
      });
      expect(call).toContain('call#c1');
      const story = router.deriveDedupeKey({
        class: 'story',
        recipientId: 'uB',
        meta: { storyAuthor: 'alice' },
      });
      expect(story).toContain('story#alice');
    });
  });

  describe('collapse behaviour', () => {
    it('folds messages per-room but keeps two rooms separate', () => {
      expect(router.deriveCollapseKey(msg({ eventSeq: 1 }))).toBe(
        router.deriveCollapseKey(msg({ eventSeq: 2 })),
      );
      expect(router.deriveCollapseKey(msg({ roomId: 'r2' }))).not.toBe(
        router.deriveCollapseKey(msg()),
      );
    });

    it('never folds a ringing call — distinct calls get distinct groups', () => {
      const a = router.deriveCollapseKey({
        class: 'call',
        recipientId: 'uB',
        meta: { callId: 'c1' },
      });
      const b = router.deriveCollapseKey({
        class: 'call',
        recipientId: 'uB',
        meta: { callId: 'c2' },
      });
      expect(a).not.toBe(b);
    });
  });

  describe('opaque on-wire collapse id', () => {
    it('is short, stable per group, and NOT the room id (leak closed)', () => {
      const id = router.deriveWireCollapseId(msg());
      expect(id).toHaveLength(16);
      expect(id).not.toContain('r1'); // never the cleartext room id
      expect(router.deriveWireCollapseId(msg({ eventSeq: 99 }))).toBe(id); // stable per room
    });

    it('differs across recipients (no cross-user correlation) and rooms', () => {
      expect(router.deriveWireCollapseId(msg({ recipientId: 'uZ' }))).not.toBe(
        router.deriveWireCollapseId(msg()),
      );
      expect(router.deriveWireCollapseId(msg({ roomId: 'r9' }))).not.toBe(
        router.deriveWireCollapseId(msg()),
      );
    });
  });

  describe('rendered text', () => {
    it('uses the actor display name, never message content', () => {
      const { title, body } = router.renderText(msg());
      expect(title).toBe('Alice');
      expect(body).toBe('New message'); // generic fallback, not content
    });

    it('falls back to Spot Me when no actor name is known', () => {
      expect(router.renderText(msg({ actorName: undefined })).title).toBe('Spot Me');
    });
  });

  describe('route() resolves the full decision', () => {
    it('carries priority, ttl and route from the catalog', () => {
      const r = router.route(msg());
      expect(r.priority).toBe('high');
      expect(r.ttlSeconds).toBeGreaterThanOrEqual(3600);
      expect(r.route).toBe('thread/r1');
      expect(r.dedupeKey).toBe(router.deriveDedupeKey(msg()));
    });
  });

  describe('transport selection', () => {
    it('routes a web subscription to web-push', () => {
      expect(
        router.selectTransports({
          deviceId: 'd1',
          subscription: { endpoint: 'https://x', keys: { p256dh: 'p', auth: 'a' } },
          platform: 'web',
        }),
      ).toEqual(['webpush']);
    });

    it('routes a native token (Android OR iOS) through FCM (iOS via APNs relay)', () => {
      expect(
        router.selectTransports({ deviceId: 'd2', token: 't', platform: 'android' }),
      ).toEqual(['fcm']);
      expect(
        router.selectTransports({ deviceId: 'd3', token: 't', platform: 'ios' }),
      ).toEqual(['fcm']);
    });
  });
});
