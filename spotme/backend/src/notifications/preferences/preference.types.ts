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
  /**
   * FOCUS MODE — a manual allowlist mode (design §9.3). When on, ONLY classes in
   * `focusAllow` (plus always-critical security + a permitted call) deliver;
   * everything else is suppressed with reason `focus`. Distinct from DND (a time
   * window): focus is an explicit "let nothing through but X" toggle.
   */
  readonly focusMode: boolean;
  /** Classes allowed to deliver during focus mode. Empty ⇒ only critical/calls. */
  readonly focusAllow: readonly NotificationClass[];
}

export const DEFAULT_ACCOUNT_PREFERENCE: AccountPreference = {
  dndEnabled: false,
  dndStart: null,
  dndEnd: null,
  dndTz: null,
  allowCallsInDnd: true,
  defaultLevel: 'all',
  focusMode: false,
  focusAllow: [],
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
  readonly reason?: 'level' | 'mute' | 'dnd' | 'focus';
  /** Deliver, but quietly (normal priority, no sound) — DND downgrade. */
  readonly downgrade?: boolean;
  /** Hold until the DND window ends, then release as a digest. */
  readonly hold?: boolean;
  /** This class pierced DND/mute (a call with allowCallsInDnd, or a critical). */
  readonly pierced?: boolean;
}
