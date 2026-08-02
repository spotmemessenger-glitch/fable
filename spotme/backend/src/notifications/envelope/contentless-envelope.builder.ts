import { Injectable } from '@nestjs/common';
import { TransportMessage } from '../transport/notification-transport';
import { BuildEnvelopeInput, IEnvelopeBuilder } from './envelope.types';

/**
 * The content-less envelope builder — the SHIPPED floor (design §4.6).
 *
 * By construction there is no path by which message content reaches the wire:
 *   - `title`/`body` are the GENERIC catalog strings the router rendered from
 *     server-known display identity, never message text;
 *   - the `data` block is metadata only — class, coalesced count, and the opaque
 *     notif handle used for the receipt round-trip. No room id, no route, no
 *     content (the cleartext `tag:roomId` leak is closed via `collapseId`);
 *   - `collapseId` is the OPAQUE, non-reversible grouping token from the router.
 *
 * This is exactly today's shipped privacy posture (a push says *something
 * arrived, from whom*, never what) made typed and testable. The rich, decrypted
 * upgrade is the gated `EncryptedEnvelopeBuilder` (default OFF) — this floor is
 * the shipped default and never worse than production.
 */
@Injectable()
export class ContentlessEnvelopeBuilder implements IEnvelopeBuilder {
  readonly kind = 'contentless' as const;

  build(input: BuildEnvelopeInput): TransportMessage {
    const { routed, target, notifId, count } = input;
    return {
      target,
      class: routed.class,
      priority: routed.priority,
      title: routed.title,
      body: routed.body,
      collapseId: routed.wireCollapseId,
      ttlSeconds: routed.ttlSeconds,
      notifId,
      // Metadata ONLY. Deliberately excludes roomId/route/content.
      data: {
        k: routed.class,
        c: String(count),
        n: notifId,
      },
    };
  }
}
