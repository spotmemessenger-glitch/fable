import { RoutedNotification } from '../routing/notification-router';
import { TransportMessage, TransportTarget } from '../transport/notification-transport';

/**
 * The envelope seam (design §4).
 *
 * A builder turns a routed notification + a device target into the content-less
 * `TransportMessage` that goes on the wire. TWO implementations are DESIGNED:
 *
 *   - ContentlessEnvelopeBuilder — SHIPPED. Generic title/body, metadata-only
 *     data block, opaque collapse id. This is the guaranteed floor and is never
 *     worse than today's production behaviour.
 *
 *   - EncryptedEnvelopeBuilder — a REAL builder that seals a rich payload to a
 *     per-device notification WRAPPING key so the provider stays blind while the
 *     device shows "Alice · 1 new message". GATED: it throws unless BOTH
 *     `NOTIFICATIONS_V2_ENABLED` and `NOTIF_ENCRYPTED_PAYLOAD_ENABLED` are set,
 *     and the sub-flag needs the owner's ADR-008 §12 sign-off. The server holds
 *     no device private key; the seal's ephemeral key is discarded per call.
 */
export interface IEnvelopeBuilder {
  readonly kind: 'contentless' | 'encrypted';
  build(input: BuildEnvelopeInput): TransportMessage;
}

export interface BuildEnvelopeInput {
  readonly routed: RoutedNotification;
  readonly target: TransportTarget;
  /** The opaque outbox-row handle used for receipts. */
  readonly notifId: string;
  /** Coalesced event count (for "3 new messages"). */
  readonly count: number;
  /**
   * Typed actions the device may render (reply/mute/accept/…). Sealed into the
   * encrypted payload; the content-less floor ignores them (a content-less push
   * cannot carry per-notification action buttons safely).
   */
  readonly actions?: readonly string[];
}
