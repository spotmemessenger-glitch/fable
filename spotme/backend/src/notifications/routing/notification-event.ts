import { NotificationClass } from '../catalog/notification-class';

/**
 * The producer→core contract (design §5.3).
 *
 * This is NOT a public HTTP route — senders cannot address recipients (that is
 * forgeable; the existing `notify` no-op documents exactly why). Producers
 * (`rooms.gateway`, `realtime.controller`, calls signaling, stories) emit a
 * `NotificationEvent`; the catalog + router decide everything else.
 *
 * THERE IS NO CONTENT FIELD ON THIS INTERFACE — enforced by the type and by the
 * `isolation.spec` fence. `meta.kind` is a cleartext routing hint the sender's
 * client already chooses to expose (e.g. "photo"), never the bytes.
 */
export interface NotificationEvent {
  readonly class: NotificationClass;
  /** The user to notify (one row per recipient; devices fanned later). */
  readonly recipientId: string;
  /** Routing (server-visible, opaque id). */
  readonly roomId?: string;
  /** RoomEvent.id — dedupe + client ordering. */
  readonly eventSeq?: number;
  /** Display identity (server-known room membership). */
  readonly actorId?: string;
  /** Human display name of the actor (server-known); used only for the title. */
  readonly actorName?: string;
  readonly meta?: {
    readonly kind?: 'photo' | 'voice' | 'file' | 'location';
    readonly callId?: string;
    readonly storyAuthor?: string;
  };
}
