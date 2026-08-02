import { Inject, Injectable, Optional } from '@nestjs/common';
import { NotificationFlags } from '../notifications.config';
import { NotificationService } from '../notification.service';
import { NotificationEvent } from '../routing/notification-event';
import { NotificationClass } from '../catalog/notification-class';
import { PRESENCE_PORT, PresencePort } from './presence.port';

/**
 * The producers (design §5.3). ONE typed entrypoint per real-world event
 * (message/mention/reply/reaction/call/security/login/verification), each of
 * which builds a `NotificationEvent` and hands it to `NotificationService`.
 * Producers know WHO to notify; the catalog/router/outbox decide everything
 * else — off the socket path.
 *
 * FLAG-GATED AND INERT: every method early-returns when `NOTIFICATIONS_V2_ENABLED`
 * is off, and the whole class is only PROVIDED when the module registers ON (the
 * DynamicModule gate). Callers hold it as an OPTIONAL dependency, so with the
 * platform off there is nothing to call and existing behaviour is byte-identical.
 *
 * Senders can never address recipients over the wire — enqueue is an internal
 * producer call, exactly as the shipped `notify` no-op documents.
 */
@Injectable()
export class NotificationProducer {
  constructor(
    private readonly flags: NotificationFlags,
    private readonly notifications: NotificationService,
    @Optional() @Inject(PRESENCE_PORT) private readonly presence?: PresencePort,
  ) {}

  /** Is the platform live? Callers check this before doing producer work. */
  get enabled(): boolean {
    return this.flags.enabled;
  }

  /**
   * Filter a recipient list down to those NOT currently connected, using the
   * PresencePort when one is wired. A caller that already excluded connected
   * users (the gateway) passes them through untouched by not relying on this.
   */
  async resolveAbsent(recipients: readonly string[]): Promise<string[]> {
    if (!this.presence) return [...recipients];
    const connected = await this.presence.connectedUsers();
    return recipients.filter((id) => !connected.has(id));
  }

  /**
   * The core fan-out: enqueue one event per recipient. Returns the per-recipient
   * outcomes for observability/tests. A no-op (empty) when the flag is off or the
   * recipient set is empty.
   */
  async enqueueFor(
    recipients: readonly string[],
    base: Omit<NotificationEvent, 'recipientId'>,
  ): Promise<number> {
    if (!this.flags.enabled || recipients.length === 0) return 0;
    const results = await Promise.all(
      recipients.map((recipientId) =>
        this.notifications
          .enqueue({ ...base, recipientId })
          .then((r) => (r.outcome === 'created' ? 1 : 0))
          .catch(() => 0),
      ),
    );
    return results.reduce((a, b) => a + b, 0);
  }

  // ── typed per-event producers ───────────────────────────────────────────────

  private roomEvent(
    cls: NotificationClass,
    roomId: string,
    actorId: string,
    actorName: string | undefined,
    eventSeq: number | undefined,
    meta?: NotificationEvent['meta'],
  ): Omit<NotificationEvent, 'recipientId'> {
    return { class: cls, roomId, actorId, actorName, eventSeq, meta };
  }

  onMessage(roomId: string, actorId: string, actorName: string | undefined, eventSeq: number | undefined, recipients: readonly string[]) {
    return this.enqueueFor(recipients, this.roomEvent('message', roomId, actorId, actorName, eventSeq));
  }

  onKnock(roomId: string, actorId: string, actorName: string | undefined, recipients: readonly string[]) {
    return this.enqueueFor(recipients, this.roomEvent('knock', roomId, actorId, actorName, undefined));
  }

  onMention(roomId: string, actorId: string, actorName: string | undefined, eventSeq: number | undefined, recipients: readonly string[]) {
    return this.enqueueFor(recipients, this.roomEvent('mention', roomId, actorId, actorName, eventSeq));
  }

  onReply(roomId: string, actorId: string, actorName: string | undefined, eventSeq: number | undefined, recipients: readonly string[]) {
    return this.enqueueFor(recipients, this.roomEvent('reply', roomId, actorId, actorName, eventSeq));
  }

  onReaction(roomId: string, actorId: string, actorName: string | undefined, eventSeq: number | undefined, recipients: readonly string[]) {
    return this.enqueueFor(recipients, this.roomEvent('reaction', roomId, actorId, actorName, eventSeq));
  }

  onCall(roomId: string, callId: string, actorId: string, actorName: string | undefined, recipients: readonly string[]) {
    return this.enqueueFor(recipients, {
      class: 'call',
      roomId,
      actorId,
      actorName,
      meta: { callId },
    });
  }

  onSecurity(recipientId: string) {
    return this.enqueueFor([recipientId], { class: 'security' });
  }

  onLogin(recipientId: string) {
    return this.enqueueFor([recipientId], { class: 'login' });
  }

  onVerification(recipientId: string) {
    return this.enqueueFor([recipientId], { class: 'verification' });
  }
}
