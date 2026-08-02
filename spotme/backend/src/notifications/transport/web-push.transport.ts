import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  INotificationTransport,
  TransportMessage,
  TransportSendResult,
  TransportTarget,
} from './notification-transport';
import { priorityParams } from './priority-map';

/**
 * Web Push transport (RFC 8291). Web Push is ALREADY provider-blind for the body
 * — the server encrypts to the subscription's p256dh/auth and the push service
 * relays ciphertext (§4.7) — so no separate notification key is needed on web;
 * we reuse the existing subscription keys. The payload is still content-less
 * (generic title/body + metadata data block).
 *
 * The actual `web-push` library is behind the `WEBPUSH_SENDER` seam so an
 * integration test injects a fake and asserts routing/error handling without a
 * network round-trip.
 */

export const WEBPUSH_SENDER = 'NOTIF_WEBPUSH_SENDER';

export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface WebPushSendResult {
  statusCode?: number;
}

/** The single call WebPushTransport needs from `web-push`. */
export interface WebPushSender {
  sendNotification(
    subscription: WebPushSubscription,
    payload: string,
    options?: { TTL?: number; urgency?: string },
  ): Promise<WebPushSendResult>;
}

/** Build the real `web-push`-backed sender, honouring the shipped VAPID config. */
export function realWebPushSender(): WebPushSender | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY || '';
  const privateKey = process.env.VAPID_PRIVATE_KEY || '';
  if (!publicKey || !privateKey) return null;
  const subject = process.env.VAPID_SUBJECT || 'mailto:spotmemessenger@gmail.com';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const webpush = require('web-push');
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return {
    sendNotification: (sub, payload, options) =>
      webpush.sendNotification(sub, payload, options),
  };
}

@Injectable()
export class WebPushTransport implements INotificationTransport {
  readonly name = 'webpush' as const;
  private sender: WebPushSender | null;

  constructor(@Optional() @Inject(WEBPUSH_SENDER) sender?: WebPushSender) {
    this.sender = sender ?? realWebPushSender();
  }

  available(): boolean {
    return this.sender != null;
  }

  supports(target: TransportTarget): boolean {
    return Boolean(target.subscription) && !target.token;
  }

  async send(messages: readonly TransportMessage[]): Promise<TransportSendResult[]> {
    if (!this.sender) return messages.map((m) => notConfigured(m));
    const sender = this.sender;

    // No multicast on Web Push — parallelise with the caller's batching already
    // bounding fan-out (§8.3). Each send is independent.
    return Promise.all(
      messages.map(async (m): Promise<TransportSendResult> => {
        const sub = m.target.subscription;
        if (!sub) return notConfigured(m);
        // Content-less body: generic title/body + metadata only.
        const body = JSON.stringify({
          title: m.title,
          body: m.body,
          k: m.class,
          n: m.notifId,
          tag: m.collapseId,
        });
        try {
          await sender.sendNotification(sub, body, {
            TTL: m.ttlSeconds,
            urgency: priorityParams(m.priority).webpush.urgency,
          });
          return {
            notifId: m.notifId,
            deviceId: m.target.deviceId,
            transport: this.name,
            ok: true,
          };
        } catch (err) {
          const statusCode = (err as { statusCode?: number })?.statusCode;
          return {
            notifId: m.notifId,
            deviceId: m.target.deviceId,
            transport: this.name,
            ok: false,
            failure: { statusCode },
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
    transport: 'webpush',
    ok: false,
    failure: { code: 'transport/not-configured' },
  };
}
