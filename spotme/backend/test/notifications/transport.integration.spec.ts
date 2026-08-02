import { FcmTransport } from '../../src/notifications/transport/fcm.transport';
import {
  FcmMessaging,
  FcmMulticastMessage,
  FcmMulticastResponse,
} from '../../src/notifications/transport/firebase';
import {
  WebPushSender,
  WebPushSubscription,
  WebPushTransport,
} from '../../src/notifications/transport/web-push.transport';
import { OneSignalTransport } from '../../src/notifications/transport/onesignal.transport';
import { NovuTransport } from '../../src/notifications/transport/novu.transport';
import { ApnsTransport } from '../../src/notifications/transport/apns.transport';
import { DesktopTransport } from '../../src/notifications/transport/desktop.transport';
import { TransportRegistry } from '../../src/notifications/transport/transport-registry';
import {
  TransportMessage,
  TransportTarget,
} from '../../src/notifications/transport/notification-transport';
import { classifyFailure } from '../../src/notifications/outbox/backoff';

/**
 * The transport seam against MOCKED providers (design §17.3 integration). No
 * network, no firebase-admin, no web-push library — the transports depend on the
 * injected FcmMessaging / WebPushSender seams, so this exercises real routing,
 * batching, result mapping, and error classification deterministically.
 */

// ── fakes ────────────────────────────────────────────────────────────────────

function fakeFcm(
  plan: (msg: FcmMulticastMessage) => FcmMulticastResponse['responses'],
): { sent: FcmMulticastMessage[]; messaging: FcmMessaging } {
  const sent: FcmMulticastMessage[] = [];
  const messaging: FcmMessaging = {
    async sendEachForMulticast(msg) {
      sent.push(msg);
      const responses = plan(msg);
      return {
        responses,
        successCount: responses.filter((r) => r.success).length,
        failureCount: responses.filter((r) => !r.success).length,
      };
    },
  };
  return { sent, messaging };
}

function fakeWebPush(
  plan: (sub: WebPushSubscription) => { statusCode?: number } | 'ok',
): { sent: Array<{ sub: WebPushSubscription; payload: string }>; sender: WebPushSender } {
  const sent: Array<{ sub: WebPushSubscription; payload: string }> = [];
  const sender: WebPushSender = {
    async sendNotification(subscription, payload) {
      sent.push({ sub: subscription, payload });
      const outcome = plan(subscription);
      if (outcome !== 'ok') {
        const err = new Error('web-push failed') as Error & { statusCode?: number };
        err.statusCode = outcome.statusCode;
        throw err;
      }
      return {};
    },
  };
  return { sent, sender };
}

const nativeTarget = (id: string): TransportTarget => ({
  deviceId: id,
  token: `tok-${id}`,
  platform: 'android',
});
const webTarget = (id: string): TransportTarget => ({
  deviceId: id,
  subscription: { endpoint: `https://push/${id}`, keys: { p256dh: 'p', auth: 'a' } },
  platform: 'web',
});

const message = (target: TransportTarget, notifId: string): TransportMessage => ({
  target,
  class: 'message',
  priority: 'high',
  title: 'Alice',
  body: 'New message',
  collapseId: 'opaqueXYZ',
  ttlSeconds: 3600,
  notifId,
  data: { k: 'message', c: '1', n: notifId },
});

// ── FCM ──────────────────────────────────────────────────────────────────────

describe('FcmTransport (mocked firebase-admin)', () => {
  it('is available only when a messaging seam is present', () => {
    expect(new FcmTransport(fakeFcm(() => []).messaging).available()).toBe(true);
  });

  it('supports native tokens, not web subscriptions', () => {
    const t = new FcmTransport(fakeFcm(() => []).messaging);
    expect(t.supports(nativeTarget('a'))).toBe(true);
    expect(t.supports(webTarget('b'))).toBe(false);
  });

  it('maps per-token success to ok + providerId', async () => {
    const { messaging } = fakeFcm((m) => m.tokens.map((_, i) => ({ success: true, messageId: `m${i}` })));
    const t = new FcmTransport(messaging);
    const res = await t.send([message(nativeTarget('a'), 'n1'), message(nativeTarget('b'), 'n2')]);
    expect(res.map((r) => r.ok)).toEqual([true, true]);
    expect(res[0].providerId).toBe('m0');
    expect(res[1].deviceId).toBe('b');
  });

  it('maps a dead-token error to a permanent failure to prune', async () => {
    const { messaging } = fakeFcm(() => [
      { success: false, error: { code: 'messaging/registration-token-not-registered' } },
    ]);
    const t = new FcmTransport(messaging);
    const [r] = await t.send([message(nativeTarget('a'), 'n1')]);
    expect(r.ok).toBe(false);
    expect(classifyFailure(r.failure ?? {})).toBe('permanent');
  });

  it('turns a whole-batch throw into transient failures (retry, not prune)', async () => {
    const messaging: FcmMessaging = {
      async sendEachForMulticast() {
        throw Object.assign(new Error('unavailable'), { code: 'messaging/server-unavailable' });
      },
    };
    const t = new FcmTransport(messaging);
    const res = await t.send([message(nativeTarget('a'), 'n1'), message(nativeTarget('b'), 'n2')]);
    expect(res.every((r) => !r.ok)).toBe(true);
    expect(classifyFailure(res[0].failure ?? {})).toBe('transient');
  });

  it('sends a CONTENT-LESS payload: generic title/body + metadata only, opaque collapse', async () => {
    const { messaging, sent } = fakeFcm((m) => m.tokens.map(() => ({ success: true })));
    const t = new FcmTransport(messaging);
    await t.send([message(nativeTarget('a'), 'n1')]);
    const payload = sent[0];
    // The only visible strings are the generic catalog ones.
    expect(payload.notification).toEqual({ title: 'Alice', body: 'New message' });
    // Data block is metadata only — no room id, no route, no content.
    expect(Object.keys(payload.data ?? {}).sort()).toEqual(['c', 'k', 'n']);
    expect(JSON.stringify(payload.data)).not.toContain('r1');
    // Collapse is the opaque id, never a room id.
    expect((payload.android as { collapseKey: string }).collapseKey).toBe('opaqueXYZ');
  });
});

// ── Web Push ───────────────────────────────────────────────────────────────

describe('WebPushTransport (mocked web-push)', () => {
  it('supports web subscriptions, not native tokens', () => {
    const t = new WebPushTransport(fakeWebPush(() => 'ok').sender);
    expect(t.supports(webTarget('a'))).toBe(true);
    expect(t.supports(nativeTarget('b'))).toBe(false);
  });

  it('reports ok on a successful send and carries no message content', async () => {
    const { sender, sent } = fakeWebPush(() => 'ok');
    const t = new WebPushTransport(sender);
    const [r] = await t.send([message(webTarget('a'), 'n1')]);
    expect(r.ok).toBe(true);
    const body = JSON.parse(sent[0].payload);
    expect(body.title).toBe('Alice');
    expect(body.body).toBe('New message'); // generic, not content
    expect(body.tag).toBe('opaqueXYZ'); // opaque, not the room id
    expect(body).not.toHaveProperty('content');
  });

  it('classifies a 410 Gone as a permanent failure to prune', async () => {
    const { sender } = fakeWebPush(() => ({ statusCode: 410 }));
    const t = new WebPushTransport(sender);
    const [r] = await t.send([message(webTarget('a'), 'n1')]);
    expect(r.ok).toBe(false);
    expect(classifyFailure(r.failure ?? {})).toBe('permanent');
  });

  it('classifies a 503 as transient (retry)', async () => {
    const { sender } = fakeWebPush(() => ({ statusCode: 503 }));
    const t = new WebPushTransport(sender);
    const [r] = await t.send([message(webTarget('a'), 'n1')]);
    expect(classifyFailure(r.failure ?? {})).toBe('transient');
  });
});

// ── stubs + registry ────────────────────────────────────────────────────────

describe('aggregator stubs stay off the default path', () => {
  it('OneSignal and Novu are never available or owning a target by default', () => {
    const os = new OneSignalTransport();
    const novu = new NovuTransport();
    expect(os.available()).toBe(false);
    expect(novu.available()).toBe(false);
    expect(os.supports(nativeTarget('a'))).toBe(false);
    expect(novu.supports(webTarget('b'))).toBe(false);
  });
});

describe('TransportRegistry routing', () => {
  function registry(
    fcmOk = true,
    webOk = true,
  ): { reg: TransportRegistry; fcmSent: FcmMulticastMessage[] } {
    const fcm = fakeFcm((m) => m.tokens.map(() => ({ success: fcmOk })));
    const web = fakeWebPush(() => (webOk ? 'ok' : { statusCode: 500 }));
    const reg = new TransportRegistry(
      new FcmTransport(fcm.messaging),
      new ApnsTransport(undefined),
      new WebPushTransport(web.sender),
      new DesktopTransport(),
      new OneSignalTransport(),
      new NovuTransport(),
    );
    return { reg, fcmSent: fcm.sent };
  }

  it('routes native → fcm and web → webpush, one call per transport (batched)', async () => {
    const { reg, fcmSent } = registry();
    const res = await reg.dispatch([
      message(nativeTarget('a'), 'n1'),
      message(nativeTarget('b'), 'n2'),
      message(webTarget('c'), 'n3'),
    ]);
    expect(res).toHaveLength(3);
    expect(res.filter((r) => r.transport === 'fcm')).toHaveLength(2);
    expect(res.filter((r) => r.transport === 'webpush')).toHaveLength(1);
    // The two native tokens were sent in a SINGLE multicast (batching).
    expect(fcmSent).toHaveLength(1);
    expect(fcmSent[0].tokens).toEqual(['tok-a', 'tok-b']);
  });

  it('returns a normalised skip when no configured transport owns a target', () => {
    const reg = new TransportRegistry(
      new FcmTransport(undefined), // no messaging seam, no env → unavailable
      new ApnsTransport(undefined),
      new WebPushTransport(undefined),
      new DesktopTransport(),
      new OneSignalTransport(),
      new NovuTransport(),
    );
    return reg.dispatch([message(nativeTarget('a'), 'n1')]).then((res) => {
      expect(res).toHaveLength(1);
      expect(res[0].ok).toBe(false);
      expect(res[0].failure?.code).toBe('transport/none-available');
    });
  });
});
