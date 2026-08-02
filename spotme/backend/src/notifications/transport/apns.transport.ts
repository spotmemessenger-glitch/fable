import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  INotificationTransport,
  TransportMessage,
  TransportSendResult,
  TransportTarget,
} from './notification-transport';
import { priorityParams } from './priority-map';
import { APNS_PROVIDER, ApnsProvider, realApnsProvider } from './apns';

/**
 * Direct APNs transport (design §17.5) — the config-gated path for VoIP/PushKit
 * (CallKit live-ring on a terminated iOS app), which the FCM→APNs relay cannot
 * do. Conforms to `INotificationTransport`; content-less by construction (generic
 * alert + metadata-only payload + opaque collapse id); per-class priority via the
 * shared priority map.
 *
 * NEVER on the default path:
 *   - `available()` is false unless `NOTIF_APNS_ENABLED=true` AND a provider is
 *     configured (the four APNS_* credentials, see `apns.ts`);
 *   - `supports()` claims ONLY targets explicitly marked `apnsDirect` — an
 *     ordinary iOS token rides the relay via `fcm`, so the two never collide.
 *
 * Like every transport it NEVER throws for a per-message failure — results come
 * back `ok:false` with a normalised failure so the outbox classifies + retries.
 */
@Injectable()
export class ApnsTransport implements INotificationTransport {
  readonly name = 'apns' as const;
  private provider: ApnsProvider | null;
  private readonly bundleId = process.env.APNS_BUNDLE_ID || '';

  constructor(@Optional() @Inject(APNS_PROVIDER) provider?: ApnsProvider) {
    this.provider = provider ?? realApnsProvider();
  }

  available(): boolean {
    return this.provider != null && process.env.NOTIF_APNS_ENABLED === 'true';
  }

  supports(target: TransportTarget): boolean {
    // Only a token explicitly minted for direct APNs (PushKit). The relay owns
    // every ordinary iOS token.
    return Boolean(target.token) && target.apnsDirect === true;
  }

  async send(messages: readonly TransportMessage[]): Promise<TransportSendResult[]> {
    const provider = this.provider;
    if (!provider) return messages.map((m) => notConfigured(m));

    // APNs is one request per device token; parallelise (the caller bounds fan-out).
    return Promise.all(
      messages.map(async (m): Promise<TransportSendResult> => {
        const token = m.target.token;
        if (!token) return notConfigured(m);
        const pp = priorityParams(m.priority);
        const isVoip = m.class === 'call';
        try {
          const outcome = await provider.send({
            deviceToken: token,
            topic: isVoip ? `${this.bundleId}.voip` : this.bundleId,
            priority: pp.apns.apnsPriority === '10' ? 10 : 5,
            pushType: isVoip ? 'voip' : pp.dataOnly ? 'background' : 'alert',
            collapseId: m.collapseId,
            expiration: Math.floor(Date.now() / 1000) + m.ttlSeconds,
            payload: {
              aps: {
                alert: pp.dataOnly ? undefined : { title: m.title, body: m.body },
                sound: pp.dataOnly ? undefined : 'default',
                'content-available': 1,
                'interruption-level': pp.apns.interruptionLevel,
                'thread-id': m.collapseId,
              },
              // Metadata only — NEVER content.
              k: m.class,
              c: m.data.c ?? '1',
              n: m.notifId,
              ...(m.data.e ? { e: m.data.e } : {}),
            },
          });
          if (outcome.sent.includes(token)) {
            return { notifId: m.notifId, deviceId: m.target.deviceId, transport: this.name, ok: true };
          }
          const fail = outcome.failed.find((f) => f.device === token);
          return {
            notifId: m.notifId,
            deviceId: m.target.deviceId,
            transport: this.name,
            ok: false,
            failure: { statusCode: fail?.status, code: fail?.reason },
          };
        } catch (err) {
          return {
            notifId: m.notifId,
            deviceId: m.target.deviceId,
            transport: this.name,
            ok: false,
            failure: { code: (err as { code?: string })?.code ?? 'apns/unknown' },
          };
        }
      }),
    );
  }
}

function notConfigured(m: TransportMessage): TransportSendResult {
  return {
    notifId: m.notifId,
    deviceId: m.target.deviceId,
    transport: 'apns',
    ok: false,
    failure: { code: 'transport/not-configured' },
  };
}
