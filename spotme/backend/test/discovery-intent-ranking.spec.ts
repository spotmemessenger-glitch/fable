/**
 * Checkpoint 8 — intent routing + the general ranking engine. The mission's
 * five proof obligations are individual tests: closer-beats-popular, safety
 * always wins, exact username beats fuzzy, unknown never invents weight,
 * sponsored influence is absent.
 */

import { DeterministicIntentRouter } from '../src/discovery/discovery.intent';
import {
  rankCandidates,
  RankingCandidate,
  RANKING_WEIGHTS_DEFAULTS,
  RANKING_SIGNALS,
  ClosedRegistryError,
  InvalidRankingWeightError,
} from '../src/discovery/discovery.ranking.engine';

describe('intent routing — deterministic baseline (no LLM, no keys, no network)', () => {
  const r = new DeterministicIntentRouter();

  it('routes the mission phrases correctly', () => {
    expect(r.parse('people near me')).toEqual({ kind: 'people' });
    expect(r.parse('coffee within 2 km')).toEqual({ kind: 'category', category: 'cafe' });
    expect(r.parse('orthopaedic hospital')).toEqual({ kind: 'category', category: 'hospital' });
    expect(r.parse('vegetarian restaurant open now')).toEqual({ kind: 'category', category: 'restaurant', openNow: true });
    expect(r.parse('@priya_k')).toEqual({ kind: 'username', handle: 'priya_k' });
  });

  it('future domains return a TYPED not-active answer, never a fabricated result', () => {
    expect(r.parse('exchange near me')).toEqual({ kind: 'unavailable-domain', domain: 'exchange' });
    expect(r.parse('events tonight')).toEqual({ kind: 'unavailable-domain', domain: 'events' });
    expect(r.parse('moments feed')).toEqual({ kind: 'unavailable-domain', domain: 'moments' });
    expect(r.parse('ask ai for help')).toEqual({ kind: 'unavailable-domain', domain: 'assistant' });
  });

  it('free text falls through to a place search; empty input is people', () => {
    expect(r.parse('Green Leaf')).toEqual({ kind: 'place', text: 'Green Leaf' });
    expect(r.parse('')).toEqual({ kind: 'people' });
  });
});

describe('ranking engine — explainable, honest, closed-registry', () => {
  const cand = (id: string, over: Partial<RankingCandidate> = {}): RankingCandidate => ({
    id,
    safetyEligible: true,
    evidence: {},
    ...over,
  });

  it('P1: a closer viable result outranks a "popular" distant one — popularity cannot even be expressed', () => {
    const close = cand('close', {
      evidence: {
        proximity: { value: 1, reason: 'under500m' },
        relevance: { value: 0.5, reason: 'partial match' },
      },
    });
    const distantShiny = cand('distant', {
      evidence: {
        proximity: { value: 0.1, reason: 'over5km' },
        relevance: { value: 1, reason: 'strong match' },
        sourceConfidence: { value: 1, reason: 'first-party' },
        availabilityEvidence: { value: 1, reason: 'open now (source-supported)' },
      },
    });
    const ranked = rankCandidates([distantShiny, close]);
    expect(ranked[0].id).toBe('close');
  });

  it('SAFETY ALWAYS WINS: an ineligible candidate never appears, whatever its evidence', () => {
    const perfect = cand('perfect-but-unsafe', {
      safetyEligible: false,
      evidence: Object.fromEntries(RANKING_SIGNALS.map((s) => [s, { value: 1, reason: 'max' }])),
    });
    const modest = cand('modest', { evidence: { proximity: { value: 0.2, reason: 'far' } } });
    const ranked = rankCandidates([perfect, modest]);
    expect(ranked.map((r) => r.id)).toEqual(['modest']);
  });

  it('explicit username match wins over fuzzy category matches', () => {
    const exact = cand('exact-handle', {
      evidence: { intentMatch: { value: 1, reason: 'exact @handle match' }, proximity: { value: 0.3, reason: 'under5km' } },
    });
    const fuzzy = cand('fuzzy-category', {
      evidence: { intentMatch: { value: 0.4, reason: 'category overlap' }, proximity: { value: 0.6, reason: 'under1km' }, relevance: { value: 0.6, reason: 'text' } },
    });
    const ranked = rankCandidates([fuzzy, exact]);
    expect(ranked[0].id).toBe('exact-handle');
  });

  it('UNKNOWN evidence never receives invented weight: omitted, visible, zero contribution', () => {
    const [r] = rankCandidates([cand('sparse', { evidence: { proximity: { value: 1, reason: 'close' } } })]);
    expect(r.breakdown.components.map((c) => c.signal)).toEqual(['proximity']);
    expect(r.breakdown.omittedSignals).toEqual(
      RANKING_SIGNALS.filter((s) => s !== 'proximity'),
    );
    expect(r.breakdown.total).toBeCloseTo(RANKING_WEIGHTS_DEFAULTS.proximity, 4);
    expect(r.breakdown.confidence).toBeLessThan(0.5); // sparse evidence = low confidence, disclosed
  });

  it('WEIGHT VALIDATION (F4.3): negative, NaN, and unregistered weights are refused', () => {
    const c = cand('x', { evidence: { proximity: { value: 1, reason: 'close' } } });
    // A negative proximity weight would silently invert "closer beats popular".
    expect(() => rankCandidates([c], { ...RANKING_WEIGHTS_DEFAULTS, proximity: -0.3 })).toThrow(InvalidRankingWeightError);
    expect(() => rankCandidates([c], { ...RANKING_WEIGHTS_DEFAULTS, freshness: NaN })).toThrow(InvalidRankingWeightError);
    // An unregistered weight key is rejected by the closed registry.
    expect(() => rankCandidates([c], { ...RANKING_WEIGHTS_DEFAULTS, sponsored: 1 } as never)).toThrow(ClosedRegistryError);
    // The defaults pass.
    expect(() => rankCandidates([c])).not.toThrow();
  });

  it('SPONSORED INFLUENCE IS ABSENT: the registry is closed and rejects it loudly', () => {
    expect(RANKING_SIGNALS as readonly string[]).not.toContain('sponsored');
    expect(RANKING_SIGNALS as readonly string[]).not.toContain('popularity');
    expect(RANKING_SIGNALS as readonly string[]).not.toContain('engagement');
    const paid = cand('paid', { evidence: { sponsored: { value: 1, reason: '$' } } as never });
    expect(() => rankCandidates([paid])).toThrow(ClosedRegistryError);
  });

  it('every response exposes total, components, reasons, omitted, confidence, source (P5)', () => {
    const [r] = rankCandidates([cand('x', { evidence: { proximity: { value: 0.8, reason: 'under1km band' } } })]);
    expect(r.breakdown.total).toBeGreaterThan(0);
    expect(r.breakdown.components[0].reason).toBe('under1km band');
    expect(Array.isArray(r.breakdown.omittedSignals)).toBe(true);
    expect(r.breakdown.confidence).toBeGreaterThan(0);
    expect(r.breakdown.source).toBe('deterministic-baseline');
  });

  it('deterministic: equal totals tie-break by id; identical input, identical output', () => {
    const a = cand('a', { evidence: { proximity: { value: 0.5, reason: 'r' } } });
    const b = cand('b', { evidence: { proximity: { value: 0.5, reason: 'r' } } });
    const r1 = rankCandidates([b, a]).map((r) => r.id);
    const r2 = rankCandidates([b, a]).map((r) => r.id);
    expect(r1).toEqual(['a', 'b']);
    expect(r1).toEqual(r2);
  });
});
