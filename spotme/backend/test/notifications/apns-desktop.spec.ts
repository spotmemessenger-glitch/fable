import { ApnsTransport } from '../../src/notifications/transport/apns.transport';
import { ApnsProvider, ApnsSendOutcome } from '../../src/notifications/transport/apns';
import { DesktopTransport } from '../../src/notifications/transport/desktop.transport';
import { FcmTransport } from '../../src/notifications/transport/fcm.transport';
import { WebPushTransport } from '../../src/notifications/transport/web-push.transport';
import { OneSignalTransport } from '../../src/notifications/transport/onesignal.transport';
import { NovuTransport } from '../../src/notifications/transport/novu.transport';
import { TransportRegistry } from '../../src/notifications/transport/transport-registry';
import {
  FcmMessaging,
  FcmMulticastMessage,
  FcmMulticastResponse,
} from '../../src/notifications/transport/firebase';
import {
  TransportMessage,
  TransportTarget,
} from '../../src/notifications/transport/notification-transport';
import { classifyFailure } from '../../src/notifications/outbox/backoff';

const message = (target: TransportTarget, notifId: string): TransportMessage => ({
  target,
  class: 'call',
  priority: 'max',
  title: 'Alice',
  body: 'Incoming call',
  collapseId: 'opaqueCall',
  ttlSeconds: 30,
  notifId,
  data: { k: 'call', c: '1', n: notifId },
});

function fakeApns(outcome: (token: string) => ApnsSendOutcome): { sent: string[]; provider: ApnsProvider } {
  const sent: string[] = [];
  return {
    sent,
    provider: {
      async send(spec) {
        sent.push(spec.deviceToken);
        return outcome(spec.deviceToken);
      },
    },
  };
}

function fakeFcm(plan: (m: FcmMulticastMessage) => FcmMulticastResponse['responses']): FcmMessaging {
  return {
    async sendEachForMulticast(m) {
      const responses = plan(m);
      return { responses, successCount: responses.length, failureCount: 0 };
    },
  };
}

const directTarget = (id: string): TransportTarget => ({
  deviceId: id,
  token: `voip-${id}`,
  platform: 'ios',
  apnsDirect: true,
});
const relayTarget = (id: string): TransportTarget => ({
  deviceId: id,
  token: `fcm-${id}`,
  platform: 'ios',
});

describe('ApnsTransport (direct, mocked @parse/node-apn)', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.NOTIF_APNS_ENABLED = 'true';
    process.env.APNS_BUNDLE_ID = 'com.spotme.app';
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('is available only when opted in AND a provider is configured', () => {
    const { provider } = fakeApns((t) => ({ sent: [t], failed: [] }));
    expect(new ApnsTransport(provider).available()).toBe(true);
    process.env.NOTIF_APNS_ENABLED = 'false';
    expect(new ApnsTransport(provider).available()).toBe(false);
  });

  it('claims ONLY apnsDirect tokens, never an ordinary relay token', () => {
    const { provider } = fakeApns((t) => ({ sent: [t], failed: [] }));
    const t = new ApnsTransport(provider);
    expect(t.supports(directTarget('a'))).toBe(true);
    expect(t.supports(relayTarget('b'))).toBe(false);
  });

  it('maps a send success to ok', async () => {
    const { provider, sent } = fakeApns((tok) => ({ sent: [tok], failed: [] }));
    const [r] = await new ApnsTransport(provider).send([message(directTarget('a'), 'n1')]);
    expect(r.ok).toBe(true);
    expect(sent).toEqual(['voip-a']);
  });

  it('maps a 410 Unregistered to a permanent failure to prune', async () => {
    const { provider } = fakeApns((tok) => ({
      sent: [],
      failed: [{ device: tok, status: 410, reason: 'Unregistered' }],
    }));
    const [r] = await new ApnsTransport(provider).send([message(directTarget('a'), 'n1')]);
    expect(r.ok).toBe(false);
    expect(classifyFailure(r.failure ?? {})).toBe('permanent');
  });

  it('degrades cleanly (not-configured) with no provider', async () => {
    const [r] = await new ApnsTransport(undefined).send([message(directTarget('a'), 'n1')]);
    expect(r.ok).toBe(false);
    expect(r.failure?.code).toBe('transport/not-configured');
  });
});

describe('DesktopTransport (stub)', () => {
  it('is off and owns nothing by default', () => {
    const d = new DesktopTransport();
    expect(d.available()).toBe(false);
    expect(d.supports({ deviceId: 'x', subscription: { endpoint: 'e', keys: { p256dh: 'p', auth: 'a' } } })).toBe(false);
    expect(d.supports({ deviceId: 'x', platform: 'desktop', token: 't' })).toBe(true); // seam shape
  });

  it('returns a normalised not-implemented for every message', async () => {
    const res = await new DesktopTransport().send([
      message({ deviceId: 'x', platform: 'desktop', token: 't' }, 'n1'),
    ]);
    expect(res[0].ok).toBe(false);
    expect(res[0].failure?.code).toBe('transport/stub-not-implemented');
  });
});

describe('registry routes VoIP direct-APNs to apns, ordinary iOS to the fcm relay', () => {
  it('sends the direct token via apns and the relay token via fcm', async () => {
    process.env.NOTIF_APNS_ENABLED = 'true';
    process.env.APNS_BUNDLE_ID = 'com.spotme.app';
    const { provider, sent: apnsSent } = fakeApns((t) => ({ sent: [t], failed: [] }));
    const reg = new TransportRegistry(
      new FcmTransport(fakeFcm((m) => m.tokens.map(() => ({ success: true })))),
      new ApnsTransport(provider),
      new WebPushTransport(undefined),
      new DesktopTransport(),
      new OneSignalTransport(),
      new NovuTransport(),
    );
    const res = await reg.dispatch([
      message(directTarget('a'), 'n1'),
      message(relayTarget('b'), 'n2'),
    ]);
    expect(res.find((r) => r.notifId === 'n1')?.transport).toBe('apns');
    expect(res.find((r) => r.notifId === 'n2')?.transport).toBe('fcm');
    expect(apnsSent).toEqual(['voip-a']);
    delete process.env.NOTIF_APNS_ENABLED;
    delete process.env.APNS_BUNDLE_ID;
  });
});
