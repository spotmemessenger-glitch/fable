import { Injectable } from '@nestjs/common';
import {
  INotificationTransport,
  TransportMessage,
  TransportName,
  TransportSendResult,
  TransportTarget,
} from './notification-transport';
import { FcmTransport } from './fcm.transport';
import { ApnsTransport } from './apns.transport';
import { WebPushTransport } from './web-push.transport';
import { DesktopTransport } from './desktop.transport';
import { OneSignalTransport } from './onesignal.transport';
import { NovuTransport } from './novu.transport';

/**
 * The transport registry: the one place that knows which providers exist and
 * which one owns a given device target. Selecting a transport is a POLICY here
 * (available + supports), which is what makes cross-transport failover a
 * configuration change rather than a rewrite (design §17.5, V2 Rule 10).
 *
 * FCM and Web Push are real; OneSignal and Novu are conformant stubs that never
 * report `available()`/`supports()` true on the default path.
 */
@Injectable()
export class TransportRegistry {
  private readonly transports: INotificationTransport[];

  constructor(
    fcm: FcmTransport,
    apns: ApnsTransport,
    webpush: WebPushTransport,
    desktop: DesktopTransport,
    onesignal: OneSignalTransport,
    novu: NovuTransport,
  ) {
    // ORDER IS POLICY. `fcm` precedes `apns` so an ordinary iOS token takes the
    // relay; the direct `apns` adapter only claims `apnsDirect` (VoIP) tokens.
    // `webpush` owns browser subscriptions (incl. desktop browsers); `desktop`
    // is the native-shell seam. Aggregator stubs sit last, never chosen by default.
    this.transports = [fcm, apns, webpush, desktop, onesignal, novu];
  }

  /** All registered transports (for metrics label sets / admin views). */
  all(): readonly INotificationTransport[] {
    return this.transports;
  }

  get(name: TransportName): INotificationTransport | undefined {
    return this.transports.find((t) => t.name === name);
  }

  /**
   * The transport that should carry a target: the first that is BOTH available
   * and supports it. Returns undefined when no configured transport owns the
   * target (e.g. a native token but FCM has no credential) — the caller records
   * that as a suppression/skip, never a crash.
   */
  transportFor(target: TransportTarget): INotificationTransport | undefined {
    return this.transports.find((t) => t.available() && t.supports(target));
  }

  /**
   * Route a batch to the right transports and flatten the results. Groups by
   * transport so each provider gets one `send()` call (FCM multicast, web-push
   * pool). Messages whose target no transport owns come back as skipped results.
   */
  async dispatch(
    messages: readonly TransportMessage[],
  ): Promise<TransportSendResult[]> {
    const groups = new Map<TransportName, TransportMessage[]>();
    const skipped: TransportSendResult[] = [];

    for (const m of messages) {
      const t = this.transportFor(m.target);
      if (!t) {
        skipped.push({
          notifId: m.notifId,
          deviceId: m.target.deviceId,
          transport: m.target.subscription ? 'webpush' : 'fcm',
          ok: false,
          failure: { code: 'transport/none-available' },
        });
        continue;
      }
      const arr = groups.get(t.name);
      if (arr) arr.push(m);
      else groups.set(t.name, [m]);
    }

    const sent = await Promise.all(
      [...groups.entries()].map(([name, batch]) => {
        const t = this.get(name);
        return t ? t.send(batch) : Promise.resolve([]);
      }),
    );
    return [...skipped, ...sent.flat()];
  }
}
