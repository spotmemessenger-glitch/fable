/**
 * The firebase-admin seam.
 *
 * FcmTransport depends on this narrow interface, not on firebase-admin directly,
 * so an integration test injects a fake sender through Nest DI (no module
 * mocking) and production injects the real relay. This is the same
 * credential-parsing logic the shipped `push.service.ts` uses (JSON blob, base64,
 * or a path — Railway env vars cannot hold newlines comfortably), kept
 * bug-for-bug compatible so the two never disagree about what a valid key is.
 */

export const FCM_MESSAGING = 'NOTIF_FCM_MESSAGING';

export interface FcmMulticastMessage {
  readonly tokens: string[];
  readonly notification?: { title: string; body: string };
  readonly data?: Record<string, string>;
  readonly android?: unknown;
  readonly apns?: unknown;
}

export interface FcmMulticastResponse {
  readonly successCount: number;
  readonly failureCount: number;
  readonly responses: Array<{
    success: boolean;
    messageId?: string;
    error?: { code?: string };
  }>;
}

/** The single method FcmTransport needs from firebase-admin messaging. */
export interface FcmMessaging {
  sendEachForMulticast(msg: FcmMulticastMessage): Promise<FcmMulticastResponse>;
}

/**
 * Build the real firebase-admin messaging, or null when no credential is
 * configured (delivery degrades to other transports; it never crashes boot).
 * Loaded lazily and guarded so it coexists with the shipped PushService, which
 * may have already initialised the default app.
 */
export function realFcmMessaging(): FcmMessaging | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (!raw) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getApps, initializeApp, cert } = require('firebase-admin/app');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getMessaging } = require('firebase-admin/messaging');
    let json = raw.trim();
    if (!json.startsWith('{')) {
      const decoded = Buffer.from(json, 'base64').toString('utf8').trim();
      json = decoded.startsWith('{')
        ? decoded
        : // eslint-disable-next-line @typescript-eslint/no-var-requires
          require('fs').readFileSync(raw, 'utf8');
    }
    const creds = JSON.parse(json);
    if (!getApps().length) initializeApp({ credential: cert(creds) });
    return getMessaging() as FcmMessaging;
  } catch {
    // A malformed key must never stop delivery over the other transports.
    return null;
  }
}
