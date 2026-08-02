import { NotificationPriority } from '../catalog/notification-class';

/**
 * Catalog priority → per-provider delivery parameters (design §8.6).
 *
 * The shipped `push.service.ts` sends everything at `high`/`10` — correct for
 * messages, wrong for stories (battery) and insufficient for calls (no
 * time-sensitive marker). This table makes priority a per-class property.
 *
 * NOTE: APNs `critical` (pierces silent mode) needs an Apple entitlement and is
 * deliberately NOT used; calls use `time-sensitive`, which respects silent mode.
 */

export interface FcmPriorityParams {
  /** android.priority */
  readonly androidPriority: 'high' | 'normal';
  /** android.notification.priority */
  readonly androidNotificationPriority:
    | 'PRIORITY_MAX'
    | 'PRIORITY_HIGH'
    | 'PRIORITY_DEFAULT'
    | 'PRIORITY_LOW';
}

export interface ApnsPriorityParams {
  /** apns-priority header. */
  readonly apnsPriority: '10' | '5';
  /** interruption-level. */
  readonly interruptionLevel: 'time-sensitive' | 'active' | 'passive';
}

export interface WebPushPriorityParams {
  /** RFC 8030 Urgency header. */
  readonly urgency: 'high' | 'normal' | 'low';
}

export interface PriorityMapping {
  readonly fcm: FcmPriorityParams;
  readonly apns: ApnsPriorityParams;
  readonly webpush: WebPushPriorityParams;
  /** Whether the payload is data-only (no visible notification block). */
  readonly dataOnly: boolean;
}

const MAP: Readonly<Record<NotificationPriority, PriorityMapping>> = {
  max: {
    fcm: { androidPriority: 'high', androidNotificationPriority: 'PRIORITY_MAX' },
    apns: { apnsPriority: '10', interruptionLevel: 'time-sensitive' },
    webpush: { urgency: 'high' },
    dataOnly: false,
  },
  high: {
    fcm: { androidPriority: 'high', androidNotificationPriority: 'PRIORITY_HIGH' },
    apns: { apnsPriority: '10', interruptionLevel: 'active' },
    webpush: { urgency: 'high' },
    dataOnly: false,
  },
  normal: {
    fcm: { androidPriority: 'high', androidNotificationPriority: 'PRIORITY_DEFAULT' },
    apns: { apnsPriority: '10', interruptionLevel: 'passive' },
    webpush: { urgency: 'normal' },
    dataOnly: false,
  },
  low: {
    fcm: { androidPriority: 'normal', androidNotificationPriority: 'PRIORITY_LOW' },
    apns: { apnsPriority: '5', interruptionLevel: 'passive' },
    webpush: { urgency: 'low' },
    dataOnly: false,
  },
  silent: {
    fcm: { androidPriority: 'normal', androidNotificationPriority: 'PRIORITY_LOW' },
    apns: { apnsPriority: '5', interruptionLevel: 'passive' },
    webpush: { urgency: 'low' },
    dataOnly: true, // data-only prefetch: no UI
  },
};

export function priorityParams(priority: NotificationPriority): PriorityMapping {
  return MAP[priority];
}
