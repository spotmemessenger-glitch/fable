/**
 * The notification delivery state machine (design §7.1), expressed as typed
 * transitions so an illegal move is a compile- or test-time error, not a silent
 * bad row.
 *
 *   queued ──▶ sending ──▶ sent ──▶ delivered ──▶ opened
 *      │          │          │          └────────▶ dismissed
 *      │          │          └────────▶ expired          (TTL, no receipt)
 *      │          ├────────▶ queued    (transient → backoff)
 *      │          └────────▶ failed    (permanent → prune token)
 *      ├────────▶ suppressed (prefs / DND / flag-off at claim)
 *      ├────────▶ collapsed  (merged into a newer row, same collapseKey)
 *      └────────▶ abandoned  (attempts > MAX → dead-letter)
 */

export const NOTIFICATION_STATES = [
  'queued',
  'sending',
  'sent',
  'delivered',
  'opened',
  'dismissed',
  'failed',
  'abandoned',
  'collapsed',
  'suppressed',
  'expired',
] as const;

export type NotificationState = (typeof NOTIFICATION_STATES)[number];

/** Terminal states never transition again. */
export const TERMINAL_STATES: ReadonlySet<NotificationState> = new Set([
  'opened',
  'dismissed',
  'failed',
  'abandoned',
  'collapsed',
  'suppressed',
  'expired',
]);

/** Allowed next-states for each state. Empty ⇒ terminal. */
const TRANSITIONS: Readonly<Record<NotificationState, readonly NotificationState[]>> = {
  queued: ['sending', 'suppressed', 'collapsed', 'abandoned'],
  sending: ['sent', 'queued', 'failed'],
  sent: ['delivered', 'expired'],
  delivered: ['opened', 'dismissed'],
  opened: [],
  dismissed: [],
  failed: [],
  abandoned: [],
  collapsed: [],
  suppressed: [],
  expired: [],
};

export function isTerminal(state: NotificationState): boolean {
  return TERMINAL_STATES.has(state);
}

/** May `from` legally move to `to`? */
export function canTransition(
  from: NotificationState,
  to: NotificationState,
): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** The set of states reachable in one step from `from`. */
export function nextStates(from: NotificationState): readonly NotificationState[] {
  return TRANSITIONS[from] ?? [];
}

/**
 * Assert a transition, throwing a precise error otherwise. Callers that mutate
 * an outbox row's status go through this so an impossible status change (e.g.
 * `opened → sending`, a replayed/stale receipt) fails loudly instead of
 * corrupting the ledger.
 */
export function assertTransition(
  from: NotificationState,
  to: NotificationState,
): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal notification transition: ${from} → ${to}`);
  }
}
