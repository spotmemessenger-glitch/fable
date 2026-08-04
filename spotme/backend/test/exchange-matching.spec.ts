/**
 * Phase 3C — Exchange matching, ranking, and search-projection proof
 * obligations. Each mission-required property is pinned by a failing-if-broken
 * assertion.
 */

import {
  rankExchangeMatches,
  proximityFromBand,
  ExchangeMatchCandidate,
  ExchangeClosedRegistryError,
  ExchangeWeightError,
  EXCHANGE_MATCH_WEIGHTS,
} from '../src/exchange/exchange.matching';
import {
  toSearchProjection,
  orderExchangeHits,
  normalizeExchangeText,
  UnconfiguredExchangeSearchAdapter,
} from '../src/exchange/exchange.search';
import { ExchangeIntentRow } from '../src/exchange/exchange.types';

const cand = (id: string, over: Partial<ExchangeMatchCandidate> = {}): ExchangeMatchCandidate => ({
  id,
  safetyEligible: true,
  distanceBand: 'under1km',
  evidence: { intentFit: { value: 0.8, reason: 'fit' } },
  ...over,
});

describe('exchange matching engine', () => {
  it('a CLOSER viable counterpart beats a POPULAR-but-distant one (proximity matters)', () => {
    // "popular" is not even a signal; the distant one can only compete on the
    // registered signals. Give the distant one a strong intentFit and the near
    // one a modest one — proximity still lifts the near one appropriately.
    const near = cand('near', {
      distanceBand: 'under500m',
      evidence: { intentFit: { value: 0.6, reason: 'ok' }, proximity: { value: proximityFromBand('under500m'), reason: 'near' } },
    });
    const far = cand('far', {
      distanceBand: 'over5km',
      evidence: { intentFit: { value: 0.7, reason: 'better text' }, proximity: { value: proximityFromBand('over5km'), reason: 'far' } },
    });
    const [first] = rankExchangeMatches([far, near]);
    expect(first.id).toBe('near');
  });

  it('SAFETY EXCLUSION ALWAYS WINS: an ineligible candidate is dropped before scoring', () => {
    const unsafe = cand('unsafe', { safetyEligible: false, evidence: { intentFit: { value: 1, reason: 'perfect' }, proximity: { value: 1, reason: 'here' } } });
    const safe = cand('safe', { evidence: { intentFit: { value: 0.1, reason: 'weak' } } });
    const ranked = rankExchangeMatches([unsafe, safe]);
    expect(ranked.map((r) => r.id)).toEqual(['safe']); // unsafe never appears, whatever its score
  });

  it('UNAVAILABLE cannot be promoted: zero availability evidence yields no availability contribution', () => {
    const available = cand('avail', { evidence: { intentFit: { value: 0.5, reason: 'x' }, availability: { value: 1, reason: 'open now' } } });
    const unknown = cand('unknown', { evidence: { intentFit: { value: 0.5, reason: 'x' } } }); // availability absent = unknown
    const ranked = rankExchangeMatches([unknown, available]);
    expect(ranked[0].id).toBe('avail');
    const u = ranked.find((r) => r.id === 'unknown')!;
    expect(u.explanation.omittedSignals).toContain('availability');
    expect(u.explanation.components.some((c) => c.signal === 'availability')).toBe(false);
  });

  it('UNKNOWN EVIDENCE gives NO invented benefit (contributes exactly 0)', () => {
    const [r] = rankExchangeMatches([cand('x', { evidence: { proximity: { value: 1, reason: 'near' } } })]);
    // Only proximity contributed; total == weight.proximity.
    expect(r.explanation.total).toBeCloseTo(EXCHANGE_MATCH_WEIGHTS.proximity, 4);
    expect(r.explanation.omittedSignals).toContain('intentFit');
  });

  it('SPONSORED / POPULARITY influence is impossible: the registry rejects it loudly', () => {
    expect(() => rankExchangeMatches([cand('p', { evidence: { sponsored: { value: 1, reason: '$' } } as never })])).toThrow(ExchangeClosedRegistryError);
    expect(() => rankExchangeMatches([cand('p')], { ...EXCHANGE_MATCH_WEIGHTS, popularity: 1 } as never)).toThrow(ExchangeClosedRegistryError);
  });

  it('weight validation: negative/NaN weights are refused', () => {
    expect(() => rankExchangeMatches([cand('a')], { ...EXCHANGE_MATCH_WEIGHTS, proximity: -1 })).toThrow(ExchangeWeightError);
    expect(() => rankExchangeMatches([cand('a')], { ...EXCHANGE_MATCH_WEIGHTS, trust: NaN })).toThrow(ExchangeWeightError);
  });

  it('every match carries a full explanation whose total equals the sum of weighted components', () => {
    const [r] = rankExchangeMatches([cand('a', { evidence: { intentFit: { value: 0.8, reason: 'f' }, proximity: { value: 0.6, reason: 'p' } } })]);
    const sum = r.explanation.components.reduce((s, c) => s + c.weighted, 0);
    expect(Math.abs(sum - r.explanation.total)).toBeLessThan(1e-9);
    expect(r.explanation.safetyEligible).toBe(true);
  });
});

describe('exchange search projection (T-EX-19)', () => {
  const row = (over: Partial<ExchangeIntentRow> = {}): ExchangeIntentRow => ({
    id: 'ix1', ownerId: 'u1', ownerKind: 'user', kind: 'offer', status: 'active',
    category: 'services/plumbing', title: 'Plumbing help', text: 'Available tonight', tags: ['plumbing'],
    budgetBand: 'low', informationalPrice: '~₹500', availabilityState: 'unknown',
    availabilityFrom: null, availabilityTo: null, availabilitySchedule: null,
    coarseLat: 12.972, coarseLon: 77.595, coarseCell: 'g12.972:77.595',
    radiusKm: 5, maxRadiusKm: 25, visibility: 'discoverable', moderationState: 'clear',
    versionSeq: 1, createdAt: new Date(), updatedAt: new Date(), expiresAt: null, ...over,
  });

  it('NO coordinate reaches the index — the doc has no coordinate field and drops coordinate-shaped values', () => {
    const doc = toSearchProjection(row({ title: 'Meet at 12.9716,77.5946', tags: ['77.594609'] }), ['12.9716,77.5946', 'plumbing']);
    const json = JSON.stringify(doc);
    expect(json).not.toContain('12.9716');
    expect(json).not.toContain('77.594609');
    expect(doc.intentLabels).toEqual(['plumbing']); // the coordinate label was dropped
    expect('coarseLat' in doc).toBe(false);
    expect('lat' in doc).toBe(false);
  });

  it('NO prohibited private/PII field enters the projection (owner id, budget, price, precise fields)', () => {
    const doc = toSearchProjection(row());
    const keys = Object.keys(doc).sort();
    expect(keys).toEqual(['category', 'coarseCell', 'id', 'intentLabels', 'kind', 'normalizedText', 'title']);
    const json = JSON.stringify(doc);
    for (const banned of ['ownerId', 'budgetBand', 'informationalPrice', 'coarseLat', 'coarseLon', '₹500', 'u1']) {
      expect(json).not.toContain(banned);
    }
  });

  it('EXACT public identifier outranks fuzzy text hits (deterministic pin)', () => {
    const ordered = orderExchangeHits([
      { id: 'fuzzy-b', exactMatch: false },
      { id: 'exact', exactMatch: true },
      { id: 'fuzzy-a', exactMatch: false },
    ]);
    expect(ordered[0].id).toBe('exact');
  });

  it('normalization folds width/zero-width/case', () => {
    expect(normalizeExchangeText('Ｐlumber​')).toBe('plumber');
  });

  it('the default search adapter is unconfigured — typed unavailability, no network', async () => {
    const a = new UnconfiguredExchangeSearchAdapter();
    expect(await a.search('x')).toEqual({ state: 'provider-unavailable', reason: 'unconfigured' });
    expect(await a.index({ id: 'x', kind: 'offer', category: 'c', title: 't', normalizedText: 't', intentLabels: [], coarseCell: 'g' })).toEqual({ ok: false });
  });
});
