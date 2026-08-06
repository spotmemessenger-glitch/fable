/**
 * Phase 5C — Moments policy: the input boundary (M5 tiers, coarse-only opt-in
 * location, A3/no-counters refusals), the closed reaction registry (M4), the
 * closed moderation + story transition tables, and the signed cursor.
 */

import {
  validateMomentInput, assertReaction, assertModerationTransition, assertStoryTransition,
  MODERATION_TRANSITIONS, STORY_TRANSITIONS, MOMENT_REACTIONS,
} from '../src/moments/moments.policy';
import { encodeCursor, decodeCursor } from '../src/moments/moments.cursor';
import { MomentsError } from '../src/moments/moments.errors';

const ok = (over: Record<string, unknown> = {}) => ({
  kind: 'text', text: 'hello nearby', visibility: 'public', ...over,
});

const expectCode = (fn: () => unknown, code: string) => {
  try { fn(); throw new Error('expected a refusal'); }
  catch (e) { expect(e).toBeInstanceOf(MomentsError); expect((e as MomentsError).code).toBe(code); }
};

describe('moment input boundary (M5)', () => {
  it('accepts each of the four tiers; location only on nearby/public', () => {
    for (const v of ['private', 'friends', 'nearby', 'public']) {
      expect(validateMomentInput('u1', ok({ visibility: v })).visibility).toBe(v);
    }
    const withLoc = validateMomentInput('u1', ok({ visibility: 'nearby', location: { lat: 12.972, lon: 77.595 } }));
    expect(withLoc.coarseCell).toBe('g12.972:77.595');
    expect(withLoc.cityCell).toBe('c13.0:77.6'); // 1-decimal city cell, never finer
    expectCode(() => validateMomentInput('u1', ok({ visibility: 'private', location: { lat: 12.972, lon: 77.595 } })), 'LOCATION_TIER_REFUSED');
    expectCode(() => validateMomentInput('u1', ok({ visibility: 'friends', location: { lat: 12.972, lon: 77.595 } })), 'LOCATION_TIER_REFUSED');
  });

  it('REFUSES a precise fix: 4+ decimal resolution, accuracy shape, precise cell', () => {
    expectCode(() => validateMomentInput('u1', ok({ visibility: 'nearby', location: { lat: 12.9716, lon: 77.5946 } })), 'PRECISE_LOCATION_REFUSED');
    expectCode(() => validateMomentInput('u1', ok({ visibility: 'nearby', location: { lat: 12.972, lon: 77.595, accuracy: 5 } })), 'PRECISE_LOCATION_REFUSED');
    expectCode(() => validateMomentInput('u1', ok({ visibility: 'public', location: { lat: 12.972, lon: 77.595, cell: '12.9716123,77.5946' } })), 'PRECISE_LOCATION_REFUSED');
  });

  it('A3 + no-counters: forbidden and unknown fields are refused', () => {
    for (const f of ['age', 'gender', 'viewCount', 'likeCount', 'priceAmount']) {
      expectCode(() => validateMomentInput('u1', ok({ [f]: 1 })), 'UNSUPPORTED_FIELD');
    }
    expectCode(() => validateMomentInput('u1', ok({ boostFactor: 9 })), 'UNSUPPORTED_FIELD');
  });

  it('kind/media coherence is enforced', () => {
    expectCode(() => validateMomentInput('u1', ok({ kind: 'photo', mediaIds: [] })), 'MALFORMED_MOMENT');
    expectCode(() => validateMomentInput('u1', ok({ kind: 'text', text: '' })), 'MALFORMED_MOMENT');
    expect(validateMomentInput('u1', ok({ kind: 'photo', mediaIds: ['m1'] })).mediaIds).toEqual(['m1']);
  });
});

describe('reactions (M4 closed registry)', () => {
  it('accepts exactly the five; rejects anything else', () => {
    for (const r of MOMENT_REACTIONS) expect(() => assertReaction(r)).not.toThrow();
    expectCode(() => assertReaction('angry'), 'UNKNOWN_REACTION');
    expectCode(() => assertReaction('fire'), 'UNKNOWN_REACTION');
  });
});

describe('moderation machine (closed)', () => {
  it('legal transitions pass; illegal throw; removed is terminal', () => {
    expect(() => assertModerationTransition('visible', 'reported')).not.toThrow();
    expect(() => assertModerationTransition('reported', 'limited')).not.toThrow();
    expectCode(() => assertModerationTransition('removed', 'visible'), 'ILLEGAL_TRANSITION');
    expect(MODERATION_TRANSITIONS.removed).toEqual([]);
  });
});

describe('story lifecycle (M3)', () => {
  it('the six states form a closed table; deleted is terminal', () => {
    expect(Object.keys(STORY_TRANSITIONS).sort()).toEqual(['active', 'archived', 'deleted', 'expired', 'hidden', 'moderation-hidden']);
    expect(() => assertStoryTransition('active', 'expired')).not.toThrow();
    expect(() => assertStoryTransition('hidden', 'active')).not.toThrow();
    expectCode(() => assertStoryTransition('deleted', 'active'), 'ILLEGAL_TRANSITION');
    expectCode(() => assertStoryTransition('moderation-hidden', 'active'), 'ILLEGAL_TRANSITION'); // un-hide is a moderation seam
  });
});

describe('cursor (anti-enumeration)', () => {
  it('round-trips signed; rejects forgery; bounds depth', () => {
    const c = { t: 123, i: 'id-9', depth: 2 };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expectCode(() => decodeCursor('nope'), 'INVALID_CURSOR');
    expectCode(() => decodeCursor(encodeCursor({ t: 1, i: 'x', depth: 99 })), 'CURSOR_TOO_DEEP');
  });
});
