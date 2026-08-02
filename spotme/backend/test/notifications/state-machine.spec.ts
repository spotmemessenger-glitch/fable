import {
  assertTransition,
  canTransition,
  isTerminal,
  nextStates,
  NOTIFICATION_STATES,
  NotificationState,
  TERMINAL_STATES,
} from '../../src/notifications/state/notification-state';

/**
 * The delivery state machine (design §7.1). Illegal moves must be rejected so a
 * stale/replayed receipt (e.g. opened-before-delivered) can never corrupt the
 * ledger.
 */
describe('notification state machine', () => {
  it('walks the happy path queued→sending→sent→delivered→opened', () => {
    const path: NotificationState[] = [
      'queued',
      'sending',
      'sent',
      'delivered',
      'opened',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('allows the documented branch transitions', () => {
    expect(canTransition('queued', 'suppressed')).toBe(true);
    expect(canTransition('queued', 'collapsed')).toBe(true);
    expect(canTransition('queued', 'abandoned')).toBe(true);
    expect(canTransition('sending', 'queued')).toBe(true); // transient retry
    expect(canTransition('sending', 'failed')).toBe(true); // permanent
    expect(canTransition('sent', 'expired')).toBe(true);
    expect(canTransition('delivered', 'dismissed')).toBe(true);
  });

  it('rejects illegal moves', () => {
    expect(canTransition('opened', 'sending')).toBe(false);
    expect(canTransition('sent', 'queued')).toBe(false);
    expect(canTransition('failed', 'sent')).toBe(false);
    expect(canTransition('suppressed', 'sending')).toBe(false);
    expect(canTransition('queued', 'opened')).toBe(false);
  });

  it('assertTransition throws a precise error on an illegal move', () => {
    expect(() => assertTransition('sending', 'sent')).not.toThrow();
    expect(() => assertTransition('opened', 'sending')).toThrow(
      /illegal notification transition: opened → sending/,
    );
  });

  it('marks exactly the terminal states as terminal, with no outgoing edges', () => {
    for (const s of NOTIFICATION_STATES) {
      expect(isTerminal(s)).toBe(TERMINAL_STATES.has(s));
      if (isTerminal(s)) expect(nextStates(s)).toHaveLength(0);
      else expect(nextStates(s).length).toBeGreaterThan(0);
    }
  });

  it('has no transition leading back into a terminal producer that reopens it', () => {
    // A terminal state must never be a source with edges.
    for (const s of TERMINAL_STATES) {
      expect(nextStates(s)).toEqual([]);
    }
  });
});
