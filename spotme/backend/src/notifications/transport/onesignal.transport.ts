import { Injectable } from '@nestjs/common';
import {
  INotificationTransport,
  TransportMessage,
  TransportSendResult,
  TransportTarget,
} from './notification-transport';

/**
 * OneSignal adapter — a CONFORMANT STUB, never on the default path.
 *
 * The `@onesignal/node-onesignal` SDK is present on this base, but a third-party
 * push aggregator in the send path would see recipients, timing, tokens, and —
 * without our envelope — content, which is exactly the adversary the design
 * excludes (§17.1 Aggregator row; a new hard dependency violates V2 Rule 10).
 *
 * It exists so the `INotificationTransport` seam is proven to admit an
 * aggregator later WITHOUT a rewrite (Rule 8/10 cross-transport failover as a
 * policy, not a rewrite). `available()` is false unless explicitly configured,
 * so the registry never selects it by default.
 */
@Injectable()
export class OneSignalTransport implements INotificationTransport {
  readonly name = 'onesignal' as const;

  available(): boolean {
    // Off unless BOTH creds are present AND opt-in is set. Defaults to off.
    return (
      process.env.NOTIF_ONESIGNAL_ENABLED === 'true' &&
      Boolean(process.env.ONESIGNAL_APP_ID) &&
      Boolean(process.env.ONESIGNAL_API_KEY)
    );
  }

  supports(_target: TransportTarget): boolean {
    // Never claims ownership of a target on the default path.
    return false;
  }

  async send(messages: readonly TransportMessage[]): Promise<TransportSendResult[]> {
    // Deliberately unimplemented: register the seam, do not route through an
    // aggregator. Returns a normalised "not-configured" for every message so a
    // caller that somehow reaches it degrades cleanly instead of throwing.
    return messages.map((m) => ({
      notifId: m.notifId,
      deviceId: m.target.deviceId,
      transport: this.name,
      ok: false,
      failure: { code: 'transport/stub-not-implemented' },
    }));
  }
}
