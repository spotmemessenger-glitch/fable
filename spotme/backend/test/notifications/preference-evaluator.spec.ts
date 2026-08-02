import { PreferenceEvaluator } from '../../src/notifications/preferences/preference-evaluator';
import {
  AccountPreference,
  ClassTraits,
  DEFAULT_ACCOUNT_PREFERENCE,
} from '../../src/notifications/preferences/preference.types';
import { isDndActive, localMinutesInTz } from '../../src/notifications/preferences/dnd-window';

/**
 * Server-side preference evaluation (design §9). Untrusted client ⇒ a muted
 * conversation must produce NO delivery. This pins the full matrix: level ×
 * mute × DND × class, plus the call override and a midnight-crossing DND window.
 */

const TRAITS: Record<string, ClassTraits> = {
  message: { class: 'message', minLevel: 'all', priority: 'high', canPierceDnd: false, critical: false },
  mention: { class: 'mention', minLevel: 'mentions', priority: 'high', canPierceDnd: false, critical: false },
  call: { class: 'call', minLevel: 'none', priority: 'max', canPierceDnd: true, critical: false },
  group: { class: 'group', minLevel: 'all', priority: 'normal', canPierceDnd: false, critical: false },
  story: { class: 'story', minLevel: 'all', priority: 'low', canPierceDnd: false, critical: false },
  security: { class: 'security', minLevel: 'none', priority: 'high', canPierceDnd: false, critical: true },
};

const account = (over: Partial<AccountPreference> = {}): AccountPreference => ({
  ...DEFAULT_ACCOUNT_PREFERENCE,
  ...over,
});

describe('PreferenceEvaluator', () => {
  const ev = new PreferenceEvaluator();
  const NOON = new Date('2026-08-02T12:00:00Z');

  describe('level gate', () => {
    it('delivers everything at level "all" with no mute/DND', () => {
      for (const t of Object.values(TRAITS)) {
        expect(ev.evaluate({ account: account(), traits: t, now: NOON }).deliver).toBe(true);
      }
    });

    it('at level "none" suppresses a message but a call still rings', () => {
      const acc = account({ defaultLevel: 'none' });
      expect(ev.evaluate({ account: acc, traits: TRAITS.message, now: NOON })).toEqual({
        deliver: false,
        reason: 'level',
      });
      expect(ev.evaluate({ account: acc, traits: TRAITS.call, now: NOON }).deliver).toBe(true);
    });

    it('at level "mentions" delivers mention + call, suppresses plain messages', () => {
      const acc = account({ defaultLevel: 'mentions' });
      expect(ev.evaluate({ account: acc, traits: TRAITS.mention, now: NOON }).deliver).toBe(true);
      expect(ev.evaluate({ account: acc, traits: TRAITS.call, now: NOON }).deliver).toBe(true);
      expect(ev.evaluate({ account: acc, traits: TRAITS.message, now: NOON }).reason).toBe('level');
    });

    it('lets a per-conversation level override the account default', () => {
      const acc = account({ defaultLevel: 'all' });
      const decision = ev.evaluate({
        account: acc,
        conversation: { level: 'none' },
        traits: TRAITS.message,
        now: NOON,
      });
      expect(decision).toEqual({ deliver: false, reason: 'level' });
    });
  });

  describe('mute gate', () => {
    it('suppresses a message while a temporary mute is in force, then delivers after', () => {
      const future = NOON.getTime() + 60_000;
      const muted = ev.evaluate({
        account: account(),
        conversation: { level: 'default', muteUntil: future },
        traits: TRAITS.message,
        now: NOON,
      });
      expect(muted).toEqual({ deliver: false, reason: 'mute' });

      const later = new Date(future + 1);
      expect(
        ev.evaluate({
          account: account(),
          conversation: { level: 'default', muteUntil: future },
          traits: TRAITS.message,
          now: later,
        }).deliver,
      ).toBe(true);
    });

    it('lets a call pierce a muted conversation (allowCallsInDnd)', () => {
      const future = NOON.getTime() + 60_000;
      expect(
        ev.evaluate({
          account: account(),
          conversation: { level: 'default', muteUntil: future },
          traits: TRAITS.call,
          now: NOON,
        }).deliver,
      ).toBe(true);
    });
  });

  describe('DND gate', () => {
    const dnd = account({
      dndEnabled: true,
      dndStart: 22 * 60, // 22:00
      dndEnd: 7 * 60, // 07:00 — crosses midnight
      dndTz: 'UTC',
      allowCallsInDnd: true,
    });
    const INSIDE = new Date('2026-08-02T23:30:00Z'); // 23:30 UTC → inside window
    const OUTSIDE = new Date('2026-08-02T12:00:00Z'); // 12:00 UTC → outside

    it('delivers high-value classes quietly (downgrade) during DND', () => {
      const d = ev.evaluate({ account: dnd, traits: TRAITS.message, now: INSIDE });
      expect(d.deliver).toBe(true);
      expect(d.downgrade).toBe(true);
    });

    it('holds low-value classes (group/story) for a digest during DND', () => {
      expect(ev.evaluate({ account: dnd, traits: TRAITS.group, now: INSIDE }).hold).toBe(true);
      expect(ev.evaluate({ account: dnd, traits: TRAITS.story, now: INSIDE }).hold).toBe(true);
    });

    it('lets a call pierce DND when allowed', () => {
      const d = ev.evaluate({ account: dnd, traits: TRAITS.call, now: INSIDE });
      expect(d).toEqual({ deliver: true, pierced: true });
    });

    it('does not apply DND outside the window', () => {
      const d = ev.evaluate({ account: dnd, traits: TRAITS.message, now: OUTSIDE });
      expect(d).toEqual({ deliver: true });
    });
  });

  describe('critical classes', () => {
    it('always deliver regardless of level/mute, quietly during DND', () => {
      const acc = account({ defaultLevel: 'none' });
      expect(
        ev.evaluate({
          account: acc,
          conversation: { level: 'none', muteUntil: null },
          traits: TRAITS.security,
          now: NOON,
        }).deliver,
      ).toBe(true);

      const dnd = account({
        dndEnabled: true,
        dndStart: 0,
        dndEnd: 24 * 60 - 1,
        dndTz: 'UTC',
        allowCallsInDnd: true,
      });
      const d = ev.evaluate({ account: dnd, traits: TRAITS.security, now: NOON });
      expect(d.deliver).toBe(true);
      expect(d.downgrade).toBe(true);
    });
  });
});

describe('DND window (tz-correct)', () => {
  it('reads recipient-local minutes from the IANA tz', () => {
    // 12:00 UTC is 17:30 in India (UTC+5:30).
    const noonUtc = new Date('2026-08-02T12:00:00Z');
    expect(localMinutesInTz(noonUtc, 'UTC')).toBe(12 * 60);
    expect(localMinutesInTz(noonUtc, 'Asia/Kolkata')).toBe(17 * 60 + 30);
  });

  it('returns null (⇒ DND disabled) for an invalid tz', () => {
    expect(localMinutesInTz(new Date(), 'Not/AZone')).toBeNull();
  });

  it('handles a window that crosses midnight', () => {
    const pref = {
      ...DEFAULT_ACCOUNT_PREFERENCE,
      dndEnabled: true,
      dndStart: 22 * 60,
      dndEnd: 7 * 60,
      dndTz: 'UTC',
    };
    expect(isDndActive(pref, new Date('2026-08-02T23:00:00Z'))).toBe(true); // after start
    expect(isDndActive(pref, new Date('2026-08-02T03:00:00Z'))).toBe(true); // before end
    expect(isDndActive(pref, new Date('2026-08-02T12:00:00Z'))).toBe(false); // midday
  });

  it('is disabled when tz is missing even if enabled', () => {
    const pref = {
      ...DEFAULT_ACCOUNT_PREFERENCE,
      dndEnabled: true,
      dndStart: 0,
      dndEnd: 100,
      dndTz: null,
    };
    expect(isDndActive(pref, new Date())).toBe(false);
  });
});
