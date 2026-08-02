import { NotificationClass, NotificationPriority, PreferenceLevel } from '../catalog/notification-class';

/** Per-account preferences (design §5.5 / §12.1 NotificationPreference). */
export interface AccountPreference {
  readonly dndEnabled: boolean;
  /** Minutes since local midnight; window is [start, end). Crosses midnight OK. */
  readonly dndStart?: number | null;
  readonly dndEnd?: number | null;
  /** IANA tz. null/absent ⇒ DND disabled (safe default — no UTC surprises). */
  readonly dndTz?: string | null;
  readonly allowCallsInDnd: boolean;
  readonly defaultLevel: PreferenceLevel;
}

export const DEFAULT_ACCOUNT_PREFERENCE: AccountPreference = {
  dndEnabled: false,
  dndStart: null,
  dndEnd: null,
  dndTz: null,
  allowCallsInDnd: true,
  defaultLevel: 'all',
};

/** Per-conversation preference. `level:'default'` defers to the account level. */
export interface ConversationPreference {
  readonly level: PreferenceLevel | 'default';
  /** Epoch ms; null ⇒ per level (none = forever). undefined ⇒ no temp mute. */
  readonly muteUntil?: number | null;
}

/** Traits the evaluator needs about a class — derived from the catalog. */
export interface ClassTraits {
  readonly class: NotificationClass;
  readonly minLevel: PreferenceLevel;
  readonly priority: NotificationPriority;
  /** Only the call class; gated by allowCallsInDnd. */
  readonly canPierceDnd: boolean;
  /** Security / login / verification — never suppressed by level/mute. */
  readonly critical: boolean;
}

/** The evaluator's verdict for one (recipient, class) at a moment in time. */
export interface PreferenceDecision {
  readonly deliver: boolean;
  /** Why it was suppressed (only when deliver=false). */
  readonly reason?: 'level' | 'mute' | 'dnd';
  /** Deliver, but quietly (normal priority, no sound) — DND downgrade. */
  readonly downgrade?: boolean;
  /** Hold until the DND window ends, then release as a digest. */
  readonly hold?: boolean;
  /** This class pierced DND/mute (a call with allowCallsInDnd, or a critical). */
  readonly pierced?: boolean;
}
