import { NotificationClass, NotificationPriority } from '../catalog/notification-class';
import { ProviderFailure } from '../outbox/backoff';

/**
 * The transport seam (design §3.1 principle 4). One interface, many providers —
 * FCM and Web Push are concrete and real; the FCM→APNs relay reuses FCM; and
 * OneSignal / Novu are interface-conformant stubs so no provider is ever a hard
 * dependency (V2 Rule 8/10: route and fall back on availability).
 *
 * A TRANSPORT NEVER RECEIVES MESSAGE CONTENT. Its payload is the content-less
 * `TransportMessage` below, whose `data` map is metadata only. The type has no
 * content field; the fence test asserts none is ever added.
 */

export type TransportName = 'fcm' | 'apns' | 'webpush' | 'onesignal' | 'novu';

/** A single addressable device registration. */
export interface TransportTarget {
  /** Opaque device id (DeviceToken.id or PushSubscription.id) — for receipts. */
  readonly deviceId: string;
  /** FCM/APNs registration token (native) … */
  readonly token?: string;
  /** … or a Web Push subscription (web). Exactly one of token/subscription. */
  readonly subscription?: {
    readonly endpoint: string;
    readonly keys: { readonly p256dh: string; readonly auth: string };
  };
  readonly platform?: 'android' | 'ios' | 'web';
}

/**
 * The content-less payload handed to a transport.
 *
 * `title`/`body` are the GENERIC, catalog-derived strings (never message text).
 * `collapseId` is an OPAQUE grouping token (not a room id — the cleartext
 * `tag:roomId` leak is closed, §4.5). `data` is metadata only: class, count,
 * an opaque notif handle. No route, no room id, no content on the wire in the
 * content-less floor — richer routing is the gated encrypted-envelope's job.
 */
export interface TransportMessage {
  readonly target: TransportTarget;
  readonly class: NotificationClass;
  readonly priority: NotificationPriority;
  readonly title: string;
  readonly body: string;
  readonly collapseId: string;
  readonly ttlSeconds: number;
  /** Opaque handle correlating this send to its outbox row (for receipts). */
  readonly notifId: string;
  /** Metadata-only key/value bag. NEVER message content. */
  readonly data: Readonly<Record<string, string>>;
}

/** Per-message send outcome, mapped back to the originating outbox row. */
export interface TransportSendResult {
  readonly notifId: string;
  readonly deviceId: string;
  readonly transport: TransportName;
  readonly ok: boolean;
  /** Provider message id when accepted (the first receipt). */
  readonly providerId?: string;
  /** Normalised failure for classification (transient vs permanent). */
  readonly failure?: ProviderFailure;
}

export interface INotificationTransport {
  readonly name: TransportName;

  /**
   * Is this transport usable right now? (credentials present, SDK initialised).
   * A transport that returns false is skipped by the registry — a missing
   * provider degrades delivery, it never crashes the send path.
   */
  available(): boolean;

  /**
   * Which targets can this transport address? The registry routes a batch to
   * the transports that own its targets (native token → fcm/apns; web sub →
   * webpush).
   */
  supports(target: TransportTarget): boolean;

  /**
   * Send a batch (may be multicast under the hood, e.g. FCM ≤500 tokens).
   * Returns one result per input message. NEVER throws for a per-message
   * failure — those come back as `ok:false` with a normalised `failure` so the
   * outbox can classify and retry/prune.
   */
  send(messages: readonly TransportMessage[]): Promise<TransportSendResult[]>;
}
