import { Injectable } from '@nestjs/common';
import {
  NOTIFICATION_CLASSES,
  NotificationClass,
  NotificationPolicy,
} from './notification-class';

/**
 * ONE typed catalog, not scattered call sites (ADR-009 §1).
 *
 * Every notification class resolves to exactly one immutable policy here. A new
 * class is a new row plus one producer line — no new notification logic at the
 * call site, and the priority/collapse/TTL differences between classes live in a
 * single reviewable table.
 *
 * The `titleTemplate`/`fallbackBody` strings are GENERIC by construction. The
 * server cannot read message content (E2E), so it cannot place it here even if
 * it wanted to — content-poverty is enforced by the type (no content field) and
 * by the fact that the producer never passes content in.
 */

// Common TTLs, named for intent.
const TTL_CALL = 30; // a call push five minutes late is noise, not a call
const TTL_SHORT = 5 * 60;
const TTL_MEDIUM = 60 * 60;
const TTL_LONG = 24 * 60 * 60;

const POLICIES: Readonly<Record<NotificationClass, NotificationPolicy>> = {
  message: {
    class: 'message',
    priority: 'high',
    collapse: 'per-room',
    channel: 'messages',
    ttlSeconds: TTL_LONG,
    titleTemplate: '{actor}',
    fallbackBody: 'New message',
    route: 'thread/:room',
    minLevel: 'all',
    canPierceDnd: false,
    defaultEnabled: true, // today's shipped behaviour, kept
  },
  knock: {
    class: 'knock',
    priority: 'high',
    collapse: 'per-actor',
    channel: 'messages',
    ttlSeconds: TTL_LONG,
    titleTemplate: 'New chat request',
    fallbackBody: 'Someone wants to chat',
    route: 'requests',
    minLevel: 'all',
    canPierceDnd: false,
    defaultEnabled: true, // kept
  },
  call: {
    class: 'call',
    priority: 'max',
    collapse: 'never', // never fold a ringing call into a summary
    channel: 'calls',
    ttlSeconds: TTL_CALL,
    titleTemplate: '{actor}',
    fallbackBody: 'Incoming call',
    route: 'call/:call',
    minLevel: 'none', // a call reaches you even at "none" if allowCallsInDnd
    canPierceDnd: true,
    defaultEnabled: false, // needs the P5 producer + owner sign-off
  },
  mention: {
    class: 'mention',
    priority: 'high',
    collapse: 'per-room',
    channel: 'messages',
    ttlSeconds: TTL_LONG,
    titleTemplate: '{actor}',
    fallbackBody: 'Mentioned you',
    route: 'thread/:room',
    minLevel: 'mentions',
    canPierceDnd: false,
    defaultEnabled: false, // owner metadata decision gates this (ADR-009 §5)
  },
  group: {
    class: 'group',
    priority: 'normal',
    collapse: 'per-room',
    channel: 'social',
    ttlSeconds: TTL_MEDIUM,
    titleTemplate: '{actor}',
    fallbackBody: 'Group activity',
    route: 'thread/:room',
    minLevel: 'all',
    canPierceDnd: false,
    defaultEnabled: false,
  },
  story: {
    class: 'story',
    priority: 'low',
    collapse: 'per-actor',
    channel: 'social',
    ttlSeconds: TTL_MEDIUM,
    titleTemplate: '{actor}',
    fallbackBody: 'Posted a story',
    route: 'story/:actor',
    minLevel: 'all',
    canPierceDnd: false,
    defaultEnabled: false,
  },
  security: {
    class: 'security',
    priority: 'high',
    collapse: 'singleton',
    channel: 'security',
    ttlSeconds: TTL_LONG,
    titleTemplate: 'Security alert',
    fallbackBody: 'Review recent account activity',
    route: 'settings/security',
    minLevel: 'none', // security always reaches you
    canPierceDnd: false,
    defaultEnabled: false,
  },
  login: {
    class: 'login',
    priority: 'normal',
    collapse: 'singleton',
    channel: 'security',
    ttlSeconds: TTL_MEDIUM,
    titleTemplate: 'New sign-in',
    fallbackBody: 'A new device signed in',
    route: 'settings/security',
    minLevel: 'none',
    canPierceDnd: false,
    defaultEnabled: false,
  },
  verification: {
    class: 'verification',
    priority: 'high',
    collapse: 'singleton',
    channel: 'security',
    ttlSeconds: TTL_SHORT,
    titleTemplate: 'Verification',
    fallbackBody: 'Confirm it is you',
    route: 'verify',
    minLevel: 'none',
    canPierceDnd: false,
    defaultEnabled: false,
  },
  silent: {
    class: 'silent',
    priority: 'silent',
    collapse: 'singleton',
    channel: 'silent',
    ttlSeconds: TTL_SHORT,
    titleTemplate: '',
    fallbackBody: '', // data-only; renders no UI
    route: '',
    minLevel: 'all',
    canPierceDnd: false,
    defaultEnabled: false,
  },
};

@Injectable()
export class NotificationCatalog {
  /** Resolve the immutable policy for a class. Throws on an unknown class. */
  policy(cls: NotificationClass): NotificationPolicy {
    const p = POLICIES[cls];
    if (!p) throw new Error(`unknown notification class: ${cls}`);
    return p;
  }

  /** True if `cls` is a class the catalog knows. */
  isKnown(cls: string): cls is NotificationClass {
    return Object.prototype.hasOwnProperty.call(POLICIES, cls);
  }

  /** All policies (for the metrics label set, admin views, and tests). */
  all(): NotificationPolicy[] {
    return NOTIFICATION_CLASSES.map((c) => POLICIES[c]);
  }

  /**
   * Fill a route template with the ids the server knows. Returns '' for the
   * silent class (no UI, no route). Never contains content.
   */
  renderRoute(
    cls: NotificationClass,
    ids: { room?: string; actor?: string; call?: string },
  ): string {
    const { route } = this.policy(cls);
    if (!route) return '';
    return route
      .replace(':room', ids.room ?? '')
      .replace(':actor', ids.actor ?? '')
      .replace(':call', ids.call ?? '');
  }
}
