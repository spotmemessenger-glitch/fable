import { Injectable } from '@nestjs/common';
import {
  INotificationTransport,
  TransportMessage,
  TransportSendResult,
  TransportTarget,
} from './notification-transport';

/**
 * Novu adapter — a CONFORMANT STUB, never on the default path.
 *
 * `@novu/node` is present on this base. Novu is a notification-orchestration
 * layer; like OneSignal it would insert a third party into the send path and
 * become a hard dependency (V2 Rule 10). It is registered only to prove the
 * `INotificationTransport` seam admits an orchestrator later without a rewrite.
 *
 * `available()` is false unless explicitly configured; the registry never
 * selects it by default.
 */
@Injectable()
export class NovuTransport implements INotificationTransport {
  readonly name = 'novu' as const;

  available(): boolean {
    return (
      process.env.NOTIF_NOVU_ENABLED === 'true' && Boolean(process.env.NOVU_API_KEY)
    );
  }

  supports(_target: TransportTarget): boolean {
    return false;
  }

  async send(messages: readonly TransportMessage[]): Promise<TransportSendResult[]> {
    return messages.map((m) => ({
      notifId: m.notifId,
      deviceId: m.target.deviceId,
      transport: this.name,
      ok: false,
      failure: { code: 'transport/stub-not-implemented' },
    }));
  }
}
