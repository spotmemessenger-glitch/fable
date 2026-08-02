import {
  backoffCeilingMs,
  classifyFailure,
  DEFAULT_BACKOFF,
  isDeadRegistration,
  isExhausted,
  nextBackoffMs,
} from '../../src/notifications/outbox/backoff';

/**
 * Retry policy (design §8.2): exponential backoff with FULL jitter, and the
 * transient/permanent error taxonomy that drives retry-vs-prune.
 */
describe('backoff + error classification', () => {
  describe('exponential ceiling', () => {
    it('doubles each attempt and clamps at the cap', () => {
      expect(backoffCeilingMs(0)).toBe(2_000);
      expect(backoffCeilingMs(1)).toBe(4_000);
      expect(backoffCeilingMs(2)).toBe(8_000);
      expect(backoffCeilingMs(3)).toBe(16_000);
      // Far out, it is capped at 5 minutes, never Infinity.
      expect(backoffCeilingMs(50)).toBe(DEFAULT_BACKOFF.capMs);
      expect(backoffCeilingMs(1000)).toBe(DEFAULT_BACKOFF.capMs);
    });
  });

  describe('full jitter', () => {
    it('returns a value in [0, ceiling] for the attempt', () => {
      // rng at both extremes proves the full-jitter envelope.
      expect(nextBackoffMs(2, DEFAULT_BACKOFF, () => 0)).toBe(0);
      expect(nextBackoffMs(2, DEFAULT_BACKOFF, () => 0.999999)).toBeLessThan(8_000);
      expect(nextBackoffMs(2, DEFAULT_BACKOFF, () => 0.5)).toBe(4_000);
    });

    it('spreads across the range — no synchronised stampede', () => {
      const seen = new Set<number>();
      for (let i = 0; i < 200; i++) seen.add(nextBackoffMs(4));
      // With full jitter over a 32s ceiling, 200 draws must not collapse to one.
      expect(seen.size).toBeGreaterThan(50);
    });
  });

  describe('exhaustion', () => {
    it('abandons only once attempts reach maxAttempts', () => {
      expect(isExhausted(5)).toBe(false);
      expect(isExhausted(6)).toBe(true);
      expect(isExhausted(7)).toBe(true);
    });
  });

  describe('classification', () => {
    it('treats 5xx/429/timeouts as transient', () => {
      expect(classifyFailure({ statusCode: 503 })).toBe('transient');
      expect(classifyFailure({ statusCode: 429 })).toBe('transient');
      expect(classifyFailure({ code: 'messaging/internal-error' })).toBe('transient');
      expect(classifyFailure({ code: 'messaging/server-unavailable' })).toBe('transient');
    });

    it('treats 404/410 and dead-token codes as permanent', () => {
      expect(classifyFailure({ statusCode: 410 })).toBe('permanent');
      expect(classifyFailure({ statusCode: 404 })).toBe('permanent');
      expect(
        classifyFailure({ code: 'messaging/registration-token-not-registered' }),
      ).toBe('permanent');
      expect(classifyFailure({ code: 'messaging/invalid-argument' })).toBe('permanent');
    });

    it('defaults an unknown error to transient (bounded by the attempt cap)', () => {
      expect(classifyFailure({})).toBe('transient');
      expect(classifyFailure({ code: 'weird/unseen' })).toBe('transient');
    });

    it('flags permanent failures as dead registrations to prune', () => {
      expect(isDeadRegistration({ statusCode: 410 })).toBe(true);
      expect(isDeadRegistration({ statusCode: 503 })).toBe(false);
    });
  });
});
