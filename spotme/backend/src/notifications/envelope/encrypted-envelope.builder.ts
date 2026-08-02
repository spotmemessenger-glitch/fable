import { Injectable } from '@nestjs/common';
import { NotificationFlags } from '../notifications.config';
import { TransportMessage } from '../transport/notification-transport';
import { BuildEnvelopeInput, IEnvelopeBuilder } from './envelope.types';
import { RichNotificationPayload } from './rich-payload.types';
import { sealRichPayload } from './notif-crypto';

/**
 * EncryptedEnvelopeBuilder — the GATED rich-payload upgrade over the content-less
 * floor (design §4.2). It seals a rich `{class, room, route, actor, preview,
 * count, seq, actions}` payload to the device's registered public notification
 * key so the DEVICE can render "Alice · 1 new message · [Reply][Mute]" while the
 * push provider stays blind. The seal is ECDH-ES → HKDF → AES-256-GCM
 * (`notif-crypto`), the same construction family as e2e_v2, with zero shared
 * code or imports with the Priority-1 crypto.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO GATES — BOTH MUST OPEN, AND THE SUB-FLAG NEEDS OWNER SIGN-OFF
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. `NOTIFICATIONS_V2_ENABLED` (master, default false)
 *   2. `NOTIF_ENCRYPTED_PAYLOAD_ENABLED` (sub-flag, default false)
 *
 * With either off, `build()` THROWS before touching any crypto — so NO key is
 * generated and NO sealing runs (the isolation fence asserts this). Flipping the
 * sub-flag on is gated on the owner's ADR-008 §12 security review ruling that a
 * public wrapping-key registration is not "key publication" in the §12 sense
 * (see docs/priority-2/security-review-encrypted-payload.md). The content-less
 * floor stays the default and the guaranteed never-worse-than-today behaviour.
 *
 * GRACEFUL DEGRADE: even when enabled, a target with no registered key gets the
 * content-less floor (no seal). The visible `title`/`body` are always the generic
 * catalog strings, so a device that cannot decrypt still shows the floor.
 */
@Injectable()
export class EncryptedEnvelopeBuilder implements IEnvelopeBuilder {
  readonly kind = 'encrypted' as const;

  constructor(private readonly flags: NotificationFlags) {}

  build(input: BuildEnvelopeInput): TransportMessage {
    // GATE. Nothing below runs — no ephemeral key, no ECDH, no AES — unless BOTH
    // flags are set. This is the "no sealing while off" guarantee.
    if (!this.flags.encryptedPayloadEnabled) {
      throw new Error(
        'EncryptedEnvelopeBuilder is gated: set NOTIFICATIONS_V2_ENABLED and ' +
          'NOTIF_ENCRYPTED_PAYLOAD_ENABLED (the latter requires the owner ' +
          'ADR-008 §12 security-review sign-off). Use ContentlessEnvelopeBuilder.',
      );
    }

    const { routed, target, notifId, count, actions } = input;

    // The content-less floor — always emitted, as the visible fallback.
    const data: Record<string, string> = {
      k: routed.class,
      c: String(count),
      n: notifId,
    };

    // Seal ONLY when the device registered a public notification key. No key ⇒
    // no seal ⇒ the floor (never worse than today).
    if (target.notifPublicKey) {
      const payload: RichNotificationPayload = {
        class: routed.class,
        room: routed.roomId,
        route: routed.route || undefined,
        actor: routed.title,
        preview: routed.body,
        count,
        seq: routed.eventSeq,
        actions: actions && actions.length ? actions : undefined,
      };
      const sealed = sealRichPayload(target.notifPublicKey, payload, notifId);
      // Opaque blob — the provider sees base64url noise, the device unseals it.
      data.e = JSON.stringify(sealed);
    }

    return {
      target,
      class: routed.class,
      priority: routed.priority,
      title: routed.title,
      body: routed.body,
      collapseId: routed.wireCollapseId,
      ttlSeconds: routed.ttlSeconds,
      notifId,
      data,
    };
  }
}
