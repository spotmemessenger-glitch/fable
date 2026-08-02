import { Injectable } from '@nestjs/common';
import {
  INotificationTransport,
  TransportMessage,
  TransportSendResult,
  TransportTarget,
} from './notification-transport';

/**
 * Desktop transport — a DOCUMENTED STUB, never on the default path.
 *
 * Desktop browsers are ALREADY covered: a desktop Chrome/Firefox/Edge PWA
 * registers a Web Push subscription and is delivered by `WebPushTransport` like
 * any other browser (design §6). This adapter is the seam for a NATIVE desktop
 * shell (an Electron/Tauri build) that would register its own OS-level push
 * channel instead of a browser subscription — none exists today, so:
 *
 *   - `available()` is false unless a native desktop channel is configured
 *     (`NOTIF_DESKTOP_ENABLED=true`), which it is not on any shipped path;
 *   - `supports()` claims ONLY a `platform:'desktop'` target with a native token,
 *     which nothing mints today — so it never competes with Web Push.
 *
 * Registering the seam proves `INotificationTransport` admits a native desktop
 * channel later without a rewrite (V2 Rule 10), without inserting an unbuilt
 * dependency into the send path now.
 */
@Injectable()
export class DesktopTransport implements INotificationTransport {
  readonly name = 'desktop' as const;

  available(): boolean {
    return process.env.NOTIF_DESKTOP_ENABLED === 'true';
  }

  supports(target: TransportTarget): boolean {
    // A native desktop shell would set platform:'desktop' + a token. Browsers on
    // desktop use Web Push (a subscription), which this never claims.
    return target.platform === 'desktop' && Boolean(target.token);
  }

  async send(messages: readonly TransportMessage[]): Promise<TransportSendResult[]> {
    // Deliberately unimplemented: the seam exists, the native channel does not.
    // Degrade cleanly (no throw) so a caller that somehow reaches it retries/prunes.
    return messages.map((m) => ({
      notifId: m.notifId,
      deviceId: m.target.deviceId,
      transport: this.name,
      ok: false,
      failure: { code: 'transport/stub-not-implemented' },
    }));
  }
}
