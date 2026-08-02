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
 *   - EncryptedEnvelopeBuilder — a DOCUMENTED SEAM ONLY, NOT shipped. It would
 *     seal a rich payload to a per-device notification WRAPPING key so the
 *     provider stays blind while the device shows "Alice · 1 new message".
 *     Generating/persisting that key is gated on a separate owner security
 *     review (ADR-008 §12); no such key is created anywhere in this branch.
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
}
