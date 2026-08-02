import { TransportMessage } from '../transport/notification-transport';
import { BuildEnvelopeInput, IEnvelopeBuilder } from './envelope.types';

/**
 * EncryptedEnvelopeBuilder — a DOCUMENTED SEAM, DELIBERATELY UNIMPLEMENTED.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE HOLDS NO CRYPTO
 * ─────────────────────────────────────────────────────────────────────────────
 * The design (§4.2) calls for a per-device notification WRAPPING key so the
 * provider stays blind while the device renders a rich, decrypted notification.
 * Generating or persisting that key is gated on a SEPARATE owner security review
 * (ADR-008 §12) and is NOT part of this branch. Therefore:
 *
 *   - this class generates NO key, reads NO key, and persists NO key;
 *   - it imports NOTHING from the messaging-identity crypto (the isolation fence
 *     asserts the whole notifications module imports no such symbol);
 *   - `build()` throws — it is a seam that proves the interface admits an
 *     encrypted builder later, without shipping one now.
 *
 * When the review authorises it, the implementation would:
 *   1. read the device's registered `notifPub` (public X25519 wrapping key);
 *   2. seal `{class, room, actor, preview:"1 new message", count, route, seq}`
 *      with AES-256-GCM(HKDF(ECDH(serverEph, notifPub)), iv, aad);
 *   3. place `{ephPub, iv, ct}` as an opaque blob in `data`, keeping a generic
 *      visible fallback so a decrypt failure degrades to the content-less floor.
 * None of that runs here; the content-less builder is the only live builder.
 */
export class EncryptedEnvelopeBuilder implements IEnvelopeBuilder {
  readonly kind = 'encrypted' as const;

  build(_input: BuildEnvelopeInput): TransportMessage {
    throw new Error(
      'EncryptedEnvelopeBuilder is a documented seam only — gated on owner ' +
        'security review (ADR-008 §12). No notification key is generated or ' +
        'persisted in this branch. Use ContentlessEnvelopeBuilder.',
    );
  }
}
