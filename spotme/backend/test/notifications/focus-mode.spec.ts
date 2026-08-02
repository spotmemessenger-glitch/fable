import { PreferenceEvaluator } from '../../src/notifications/preferences/preference-evaluator';
import {
  AccountPreference,
  ClassTraits,
} from '../../src/notifications/preferences/preference.types';

/**
 * FOCUS MODE — a manual allowlist that overrides levels/mute. Only an allowed
 * class (or a permitted call, or an always-critical class) gets through; the rest
 * are suppressed with reason `focus`. Evaluated server-side, deterministically.
 */

const evaluator = new PreferenceEvaluator();

const account = (over: Partial<AccountPreference> = {}): AccountPreference => ({
  dndEnabled: false,
  dndStart: null,
  dndEnd: null,
  dndTz: null,
  allowCallsInDnd: true,
  defaultLevel: 'all',
  focusMode: false,
  focusAllow: [],
  ...over,
});

const traits = (over: Partial<ClassTraits> = {}): ClassTraits => ({
  class: 'message',
  minLevel: 'all',
  priority: 'high',
  canPierceDnd: false,
  critical: false,
  ...over,
});

const now = new Date('2026-08-02T12:00:00Z');

describe('focus mode', () => {
  it('suppresses a non-allowed class with reason focus', () => {
    const d = evaluator.evaluate({
      account: account({ focusMode: true, focusAllow: ['call'] }),
      traits: traits({ class: 'message' }),
      now,
    });
    expect(d).toEqual({ deliver: false, reason: 'focus' });
  });

  it('delivers a class that is on the focus allowlist', () => {
    const d = evaluator.evaluate({
      account: account({ focusMode: true, focusAllow: ['message'] }),
      traits: traits({ class: 'message' }),
      now,
    });
    expect(d.deliver).toBe(true);
  });

  it('lets a permitted call pierce focus even when not listed', () => {
    const d = evaluator.evaluate({
      account: account({ focusMode: true, focusAllow: [], allowCallsInDnd: true }),
      traits: traits({ class: 'call', minLevel: 'none', canPierceDnd: true }),
      now,
    });
    expect(d.deliver).toBe(true);
  });

  it('never suppresses a critical class in focus mode', () => {
    const d = evaluator.evaluate({
      account: account({ focusMode: true, focusAllow: [] }),
      traits: traits({ class: 'security', minLevel: 'none', critical: true }),
      now,
    });
    expect(d.deliver).toBe(true);
  });

  it('is a no-op when focus mode is off', () => {
    const d = evaluator.evaluate({
      account: account({ focusMode: false }),
      traits: traits({ class: 'message' }),
      now,
    });
    expect(d.deliver).toBe(true);
  });
});
