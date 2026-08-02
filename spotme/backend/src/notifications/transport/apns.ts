/**
 * The direct-APNs seam (design §17.5).
 *
 * Spot Me's DEFAULT iOS pipeline is the FCM→APNs RELAY: one token table, one
 * SDK, no Apple cert to rotate (see `fcm.transport.ts`). This direct adapter is
 * the DOCUMENTED, config-gated alternative for the one thing the relay cannot do
 * — VoIP/PushKit pushes that ring CallKit on a terminated app. It is OFF unless
 * an Apple signing key is configured, and it only carries tokens explicitly
 * marked `apnsDirect`, so it NEVER competes with the relay for an ordinary token.
 *
 * `ApnsTransport` depends on this narrow interface, not on `@parse/node-apn`
 * directly, so a test injects a fake and the send path is exercised with no
 * Apple round-trip. `realApnsProvider()` wires the real `@parse/node-apn`
 * `Provider` when — and only when — the four credentials are present.
 *
 * REQUIRED CONFIG (all four, else the adapter stays unavailable):
 *   APNS_KEY        the .p8 signing key contents (or a path to it)
 *   APNS_KEY_ID     the 10-char key id
 *   APNS_TEAM_ID    the 10-char team id
 *   APNS_BUNDLE_ID  the app bundle id (the APNs `topic`)
 * plus NOTIF_APNS_ENABLED=true to opt in.
 */

export const APNS_PROVIDER = 'NOTIF_APNS_PROVIDER';

export interface ApnsNotificationSpec {
  readonly deviceToken: string;
  /** The APNs `topic` — the app bundle id (`.voip` suffix added for VoIP). */
  readonly topic: string;
  readonly priority: 10 | 5;
  readonly pushType: 'alert' | 'background' | 'voip';
  readonly collapseId?: string;
  /** Epoch seconds; 0 ⇒ "deliver once, do not store". */
  readonly expiration?: number;
  /** The `aps` dictionary plus any metadata keys (NEVER message content). */
  readonly payload: Record<string, unknown>;
}

export interface ApnsSendOutcome {
  readonly sent: readonly string[]; // device tokens accepted
  readonly failed: ReadonlyArray<{
    readonly device: string;
    readonly status?: number;
    readonly reason?: string;
  }>;
}

/** The single method `ApnsTransport` needs from a provider. */
export interface ApnsProvider {
  send(spec: ApnsNotificationSpec): Promise<ApnsSendOutcome>;
}

/**
 * Build the real `@parse/node-apn`-backed provider, or null when the four
 * credentials are absent (delivery degrades to the FCM relay; it never crashes
 * boot). Loaded lazily and guarded so a malformed key can never stop the server.
 */
export function realApnsProvider(): ApnsProvider | null {
  const key = process.env.APNS_KEY || '';
  const keyId = process.env.APNS_KEY_ID || '';
  const teamId = process.env.APNS_TEAM_ID || '';
  const bundleId = process.env.APNS_BUNDLE_ID || '';
  if (!key || !keyId || !teamId || !bundleId) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const apn = require('@parse/node-apn');
    const provider = new apn.Provider({
      token: { key, keyId, teamId },
      production: process.env.NODE_ENV === 'production',
    });
    return {
      async send(spec: ApnsNotificationSpec): Promise<ApnsSendOutcome> {
        const note = new apn.Notification();
        note.topic = spec.topic;
        note.priority = spec.priority;
        note.pushType = spec.pushType;
        if (spec.collapseId) note.collapseId = spec.collapseId;
        if (spec.expiration !== undefined) note.expiry = spec.expiration;
        // The payload carries the aps dict + metadata only. No content.
        const { aps, ...rest } = spec.payload as { aps?: Record<string, unknown> };
        if (aps?.alert) note.alert = aps.alert as string;
        if (aps?.sound) note.sound = aps.sound as string;
        if (aps?.['content-available']) note.contentAvailable = true;
        if (aps?.['thread-id']) note.threadId = aps['thread-id'] as string;
        note.payload = rest;
        const res = await provider.send(note, [spec.deviceToken]);
        return {
          sent: res.sent.map((s: { device: string }) => s.device),
          failed: res.failed.map(
            (f: { device: string; status?: string; response?: { reason?: string } }) => ({
              device: f.device,
              status: f.status ? Number(f.status) : undefined,
              reason: f.response?.reason,
            }),
          ),
        };
      },
    };
  } catch {
    return null;
  }
}
