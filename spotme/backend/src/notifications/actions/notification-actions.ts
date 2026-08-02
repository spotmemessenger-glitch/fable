import { NotificationClass } from '../catalog/notification-class';
import { NotificationState } from '../state/notification-state';

/**
 * Typed notification ACTIONS (design §4.8, §5.4). An action is a user response to
 * a delivered notification — reply inline, mark read, mute, archive, accept or
 * decline a call, open media, play a voice note. Actions are declared PER CLASS
 * so the device renders exactly the buttons a class supports (a call gets
 * accept/decline, never "reply").
 *
 * CONTENT-LESS BY DEFAULT. The floor push carries no action buttons — a
 * content-less notification cannot safely offer "Reply to <hidden message>". The
 * action set travels only inside the GATED encrypted payload (`data.e`), where
 * the device already learned the rich context. What we record on the server is
 * the RESULT of an action (an opaque receipt), never its content.
 */

export type NotificationAction =
  | 'markRead'
  | 'inlineReply'
  | 'mute'
  | 'archive'
  | 'accept'
  | 'decline'
  | 'view'
  | 'react'
  | 'openMedia'
  | 'playVoice';

export const ALL_ACTIONS: readonly NotificationAction[] = [
  'markRead',
  'inlineReply',
  'mute',
  'archive',
  'accept',
  'decline',
  'view',
  'react',
  'openMedia',
  'playVoice',
];

const ACTION_SET = new Set<string>(ALL_ACTIONS);

export function isNotificationAction(v: string): v is NotificationAction {
  return ACTION_SET.has(v);
}

/** The base action set a class supports (media actions added per meta.kind). */
const BY_CLASS: Readonly<Record<NotificationClass, readonly NotificationAction[]>> = {
  message: ['markRead', 'inlineReply', 'mute', 'archive'],
  reply: ['markRead', 'inlineReply', 'mute', 'archive'],
  mention: ['markRead', 'inlineReply', 'mute', 'archive'],
  reaction: ['markRead', 'mute'],
  knock: ['accept', 'decline'],
  call: ['accept', 'decline'],
  group: ['markRead', 'mute'],
  story: ['view', 'mute'],
  security: ['markRead'],
  login: ['markRead'],
  verification: [],
  silent: [],
};

/** The actions a class supports, optionally extended by an attachment kind. */
export function actionsFor(
  cls: NotificationClass,
  kind?: 'photo' | 'voice' | 'file' | 'location',
): readonly NotificationAction[] {
  const base = BY_CLASS[cls] ?? [];
  if (!kind) return base;
  if (kind === 'photo' || kind === 'file') return [...base, 'openMedia'];
  if (kind === 'voice') return [...base, 'playVoice'];
  return base;
}

/**
 * The RESULT an action maps to: an opaque receipt `event` (for analytics) and,
 * where the action represents engagement or refusal, the canonical delivery
 * state to advance to. Actions that are pure preference/UI ops (mute, archive)
 * record a receipt but do NOT move the delivery state machine.
 */
export interface ActionEffect {
  /** The receipt event name recorded (content-free). */
  readonly event: string;
  /** The canonical state transition, if any (validated against the machine). */
  readonly state?: Extract<NotificationState, 'opened' | 'dismissed'>;
}

const EFFECTS: Readonly<Record<NotificationAction, ActionEffect>> = {
  markRead: { event: 'read', state: 'opened' },
  inlineReply: { event: 'replied', state: 'opened' },
  openMedia: { event: 'opened', state: 'opened' },
  playVoice: { event: 'opened', state: 'opened' },
  view: { event: 'viewed', state: 'opened' },
  react: { event: 'reacted', state: 'opened' },
  accept: { event: 'accepted', state: 'opened' },
  decline: { event: 'declined', state: 'dismissed' },
  mute: { event: 'muted' }, // preference op — no state change
  archive: { event: 'archived' }, // UI op — no state change
};

export function actionEffect(action: NotificationAction): ActionEffect {
  return EFFECTS[action];
}
