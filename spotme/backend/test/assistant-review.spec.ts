/**
 * Phase 6C — the X5 review-intelligence engine. Facet states are closed;
 * mixed keeps BOTH conflicting claims visible; absent evidence yields honest
 * insufficient-evidence rows; there is no rating of any kind anywhere; and
 * confidence derives from diversity+freshness+density, not review count.
 */

import { AssistantError } from '../src/assistant/assistant.errors';
import { ReviewIntelligenceEngine, REVIEW_FACET_FIELDS } from '../src/assistant/assistant.review';
import { FixtureReviewSource } from '../src/assistant/assistant.fixtures';
import { mintEvidenceRecord } from '../src/assistant/assistant.evidence';
import type { ReviewEvidenceBundle, ReviewEvidenceRecord } from '../src/assistant/assistant.ports';

const engine = new ReviewIntelligenceEngine();

const reviewRecord = (id: string, sourceId: string): ReviewEvidenceRecord =>
  mintEvidenceRecord({
    id, sourceId, sourceType: 'fixture', licenseClass: 'licensed-provider',
    category: 'place-review', retrievedAtUTC: 1000, sourceUpdatedAtUTC: null,
    freshness: 'current', contentRef: `ref:${id}`, integrityDigest: 'sha256:abcd',
    attributionLabel: 'Fixture Reviews', permittedUse: 'display-with-attribution',
  }) as ReviewEvidenceRecord;

describe('ReviewIntelligenceEngine (X5)', () => {
  it('builds supported + MIXED facets from the fixture bundle; both conflict sides stay visible', async () => {
    const bundle = await new FixtureReviewSource().fetchReviewEvidence('place:cafe-azul');
    const intel = engine.build('place:cafe-azul', bundle)!;
    expect(intel).not.toBeNull();

    const service = intel.facets.find((f) => f.field === 'service')!;
    expect(service.state).toBe('supported');
    expect(service.claims[0].confidence.level).toBe('high'); // two distinct sources
    expect(service.claims[0].confidence.basis.sourceDiversity).toBe(2);

    const noise = intel.facets.find((f) => f.field === 'noise-level')!;
    expect(noise.state).toBe('mixed');
    expect(noise.claims.length).toBe(2); // BOTH sides visible
    expect(noise.claims.map((c) => c.text)).toEqual([
      'Reviewers describe noise-level as quiet on weekdays.',
      'Reviewers describe noise-level as loud on weekends.',
    ]);
    for (const claim of noise.claims) expect(claim.evidenceStatus).toBe('mixed');
  });

  it('every registry facet appears; evidence-free facets are HONEST insufficient-evidence rows', async () => {
    const bundle = await new FixtureReviewSource().fetchReviewEvidence('place:cafe-azul');
    const intel = engine.build('place:cafe-azul', bundle)!;
    expect(intel.facets.map((f) => f.field).sort()).toEqual([...REVIEW_FACET_FIELDS].sort());
    const bestTime = intel.facets.find((f) => f.field === 'best-time-to-visit')!;
    expect(bestTime.state).toBe('insufficient-evidence');
    expect(bestTime.claims).toEqual([]); // never invented from popularity/count
  });

  it('supports explicit not-applicable facets', async () => {
    const bundle = await new FixtureReviewSource().fetchReviewEvidence('place:cafe-azul');
    const intel = engine.build('place:cafe-azul', bundle, ['wait-time'])!;
    expect(intel.facets.find((f) => f.field === 'wait-time')!.state).toBe('not-applicable');
  });

  it('carries NO rating anywhere: no stars/score/rating key on any output object', async () => {
    const bundle = await new FixtureReviewSource().fetchReviewEvidence('place:cafe-azul');
    const intel = engine.build('place:cafe-azul', bundle)!;
    const forbidden = /"(rating|stars|score|sentimentScore|popularity)"/;
    expect(JSON.stringify(intel)).not.toMatch(forbidden);
  });

  it('returns null when nothing is citable — honesty, not an invented summary', () => {
    expect(engine.build('place:nowhere', { records: [], statements: [] })).toBeNull();
  });

  it('THROWS on an unknown facet field — the registry is closed', () => {
    const a = reviewRecord('ev:r1', 'src-a');
    const bundle: ReviewEvidenceBundle = {
      records: [a],
      statements: [{ id: 'x', category: 'place-review', templateKey: 'place-review-theme',
        params: { facet: 'vibes-rating', theme: 'great', stance: 'positive' }, citationIds: [a.id] }],
    };
    expect(() => engine.build('place:x', bundle)).toThrow(AssistantError);
  });

  it('drops statements whose citations do not resolve — fail closed, no partial credit', () => {
    const a = reviewRecord('ev:r1', 'src-a');
    const bundle: ReviewEvidenceBundle = {
      records: [a],
      statements: [
        { id: 'ok', category: 'place-review', templateKey: 'place-review-theme',
          params: { facet: 'service', theme: 'kind', stance: 'positive' }, citationIds: [a.id] },
        { id: 'bad', category: 'place-review', templateKey: 'place-review-theme',
          params: { facet: 'value', theme: 'cheap', stance: 'positive' }, citationIds: ['ev:elsewhere'] },
      ],
    };
    const intel = engine.build('place:x', bundle)!;
    expect(intel.facets.find((f) => f.field === 'service')!.state).toBe('supported');
    expect(intel.facets.find((f) => f.field === 'value')!.state).toBe('insufficient-evidence');
  });

  it('confidence stays medium for many records from ONE source — count alone buys nothing', () => {
    const recs = [reviewRecord('ev:1', 'same'), reviewRecord('ev:2', 'same'), reviewRecord('ev:3', 'same')];
    const bundle: ReviewEvidenceBundle = {
      records: recs,
      statements: [{ id: 's', category: 'place-review', templateKey: 'place-review-theme',
        params: { facet: 'service', theme: 'fine', stance: 'positive' },
        citationIds: recs.map((r) => r.id) }],
    };
    const intel = engine.build('place:x', bundle)!;
    const claim = intel.facets.find((f) => f.field === 'service')!.claims[0];
    expect(claim.confidence.level).toBe('medium');
    expect(claim.confidence.basis.density).toBe(3);
  });
});

describe('X11 review repairs — regression battery (6C scope)', () => {
  it('F4: a review theme asserting current-state language yields NO claim', () => {
    const a = reviewRecord('ev:r1', 'src-a');
    const bundle: ReviewEvidenceBundle = {
      records: [a],
      statements: [
        { id: 'sneaky', category: 'place-review', templateKey: 'place-review-theme',
          params: { facet: 'service', theme: 'great and open right now', stance: 'positive' },
          citationIds: [a.id] },
        { id: 'ok', category: 'place-review', templateKey: 'place-review-theme',
          params: { facet: 'service', theme: 'consistently friendly', stance: 'positive' },
          citationIds: [a.id] },
      ],
    };
    const intel = engine.build('place:x', bundle)!;
    const service = intel.facets.find((f) => f.field === 'service')!;
    expect(service.claims.length).toBe(1);
    expect(service.claims[0].text).toContain('consistently friendly');
    expect(JSON.stringify(intel)).not.toContain('open right now');
  });
});
