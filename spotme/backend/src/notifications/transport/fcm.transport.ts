import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  INotificationTransport,
  TransportMessage,
  TransportSendResult,
  TransportTarget,
} from './notification-transport';
import { priorityParams } from './priority-map';
import {
  FCM_MESSAGING,
  FcmMessaging,
  FcmMulticastMessage,
  realFcmMessaging,
} from './firebase';

/**
 * FCM transport (design §3.1, §4.8, §8.6) — also the iOS pipeline via FCM's
 * APNs relay (one pipeline, one token table; §17.1). Mirrors the shipped
 * `push.service.ts` native send, generalised behind `INotificationTransport`:
 *
 *   - content-less by construction: `title`/`body` are the generic catalog
 *     strings, `data` is metadata only; there is no content field to leak;
 *   - the cleartext `tag:roomId` is replaced by the OPAQUE `collapseId`;
 *   - per-class priority via the priority map (not everything at high/10);
 *   - batched with `sendEachForMulticast` (≤500 tokens) — the caller groups.
 *
 * NEVER throws for a per-message failure: results come back as `ok:false` with
 * a normalised failure so the outbox classifies transient vs permanent.
 */
@Injectable()
export class FcmTransport implements INotificationTransport {
  readonly name = 'fcm' as const;
  private messaging: FcmMessaging | null;

  constructor(@Optional() @Inject(FCM_MESSAGING) messaging?: FcmMessaging) {
    // Injected fake in tests; the real relay in production; null when no key.
    this.messaging = messaging ?? realFcmMessaging();
  }

  available(): boolean {
    return this.messaging != null;
  }

  supports(target: TransportTarget): boolean {
    // Native tokens (Android directly, iOS via the APNs relay), EXCEPT a token
    // explicitly minted for direct APNs (PushKit/VoIP) — that one is the direct
    // `apns` adapter's, so the relay never grabs it.
    return Boolean(target.token) && !target.subscription && target.apnsDirect !== true;
  }

  async send(messages: readonly TransportMessage[]): Promise<TransportSendResult[]> {
    if (!this.messaging || messages.length === 0) {
      return messages.map((m) => notConfigured(m));
    }

    const tokens = messages.map((m) => m.target.token as string);
    // FCM multicast requires a single payload shape; the caller batches by
    // (transport, priority, class) so this is safe. Use the first message's
    // policy for the shared blocks; per-message data rides in the loop below is
    // not possible with multicast, so we send one multicast per uniform batch.
    const first = messages[0];
    const payload = this.buildMulticast(messages, first);

    let res;
    try {
      res = await this.messaging.sendEachForMulticast(payload);
    } catch (err) {
      // A whole-batch throw (auth, network) → every message is a transient fail.
      const code = (err as { code?: string })?.code;
      return messages.map((m) => ({
        notifId: m.notifId,
        deviceId: m.target.deviceId,
        transport: this.name,
        ok: false,
        failure: { code: code ?? 'messaging/unknown' },
      }));
    }

    return messages.map((m, i) => {
      const r = res.responses[i];
      if (r?.success) {
        return {
          notifId: m.notifId,
          deviceId: m.target.deviceId,
          transport: this.name,
          ok: true,
          providerId: r.messageId,
        };
      }
      return {
        notifId: m.notifId,
        deviceId: m.target.deviceId,
        transport: this.name,
        ok: false,
        failure: { code: r?.error?.code ?? 'messaging/unknown' },
      };
    });
  }

  /**
   * Build the multicast payload. Content-less: only generic title/body + a
   * metadata-only data block + the opaque collapse id. iOS `content-available`
   * wakes the app to fetch the real message over the encrypted socket.
   */
  private buildMulticast(
    messages: readonly TransportMessage[],
    first: TransportMessage,
  ): FcmMulticastMessage {
    const pp = priorityParams(first.priority);
    const collapseId = first.collapseId;
    // Data-only (silent) carries no visible notification block; otherwise the
    // generic (never content) title/body shows in the tray.
    const notification = pp.dataOnly
      ? undefined
      : { title: first.title, body: first.body };
    const base: FcmMulticastMessage = {
      tokens: messages.map((m) => m.target.token as string),
      notification,
      data: {
        // Metadata only — NEVER content. `k` is the class; `c` the coalesced
        // count; `n` the opaque notif handle for the receipt round-trip.
        k: first.class,
        c: String(messages[0]?.data?.count ?? '1'),
        n: first.notifId,
      },
      android: {
        priority: pp.fcm.androidPriority,
        collapseKey: collapseId,
        ttl: first.ttlSeconds * 1000,
        notification: {
          tag: collapseId,
          defaultSound: first.priority !== 'silent',
          priority: pp.fcm.androidNotificationPriority,
        },
      },
      apns: {
        headers: {
          'apns-priority': pp.apns.apnsPriority,
          'apns-push-type': pp.dataOnly ? 'background' : 'alert',
          'apns-collapse-id': collapseId,
          'apns-expiration': String(Math.floor(Date.now() / 1000) + first.ttlSeconds),
        },
        payload: {
          aps: {
            'content-available': 1,
            'interruption-level': pp.apns.interruptionLevel,
            sound: pp.dataOnly ? undefined : 'default',
            'thread-id': collapseId,
          },
        },
      },
    };
    return base;
  }
}

function notConfigured(m: TransportMessage): TransportSendResult {
  return {
    notifId: m.notifId,
    deviceId: m.target.deviceId,
    transport: 'fcm',
    ok: false,
    failure: { code: 'transport/not-configured' },
  };
}
