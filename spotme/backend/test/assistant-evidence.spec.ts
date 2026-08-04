/**
 * Phase 6B — the evidence ingestion boundary (X2/X3/X4/X5). Non-member
 * license classes THROW by name, forbidden fields THROW by presence, the
 * envelope fails closed on unresolved/mismatched citations and on stale
 * evidence under current-state claims, and confidence comes from
 * diversity+freshness+density.
 */

import { confidenceFor, mintEvidenceRecord, validateEnvelope } from '../src/assistant/assistant.evidence';
import { AssistantError } from '../src/assistant/assistant.errors';
import type { CitedSummary, EvidenceRecord, NonEmptyArray } from '../src/assistant/assistant.types';

const cand = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'ev:1', sourceId: 'fixture:src', sourceType: 'fixture', licenseClass: 'fixture',
  category: 'place-name', retrievedAtUTC: 1000, sourceUpdatedAtUTC: null,
  freshness: 'current', contentRef: 'ref:1', integrityDigest: 'sha256:abcd',
  attributionLabel: 'Fixture', permittedUse: 'display-with-attribution',
  ...over,
});

const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { if (e instanceof AssistantError) return e.code; throw e; }
  throw new Error('expected throw');
};

describe('mintEvidenceRecord (X2)', () => {
  it('mints and freezes a well-formed record', () => {
    const r = mintEvidenceRecord(cand());
    expect(r.licenseClass).toBe('fixture');
    expect(Object.isFrozen(r)).toBe(true);
  });

  it("THROWS 'unlicensed-evidence' for scraped and unknown license classes (D11a)", () => {
    expect(codeOf(() => mintEvidenceRecord(cand({ licenseClass: 'scraped' })))).toBe('unlicensed-evidence');
    expect(codeOf(() => mintEvidenceRecord(cand({ licenseClass: 'unknown' })))).toBe('unlicensed-evidence');
    expect(codeOf(() => mintEvidenceRecord(cand({ licenseClass: undefined })))).toBe('unlicensed-evidence');
  });

  it('THROWS on forbidden fields BY PRESENCE — payloads, prompts, credentials, coordinates', () => {
    for (const key of ['rawPayload', 'html', 'prompt', 'providerPrompt', 'instructions', 'credentials', 'apiKey', 'lat', 'lon', 'coordinates', 'script']) {
      expect(codeOf(() => mintEvidenceRecord(cand({ [key]: 'x' })))).toBe('forbidden-evidence-field');
    }
  });

  it('drops unknown (non-forbidden) keys — allow-list output only', () => {
    const r = mintEvidenceRecord(cand({ vendorExtra: 'noise' }));
    expect((r as unknown as Record<string, unknown>).vendorExtra).toBeUndefined();
    expect(Object.keys(r).sort()).toEqual([
      'attributionLabel', 'category', 'contentRef', 'freshness', 'id',
      'integrityDigest', 'licenseClass', 'permittedUse', 'retrievedAtUTC',
      'sourceId', 'sourceType', 'sourceUpdatedAtUTC',
    ]);
  });

  it('refuses unknown categories and malformed core fields', () => {
    expect(codeOf(() => mintEvidenceRecord(cand({ category: 'gossip' })))).toBe('unknown-evidence-category');
    expect(codeOf(() => mintEvidenceRecord(cand({ integrityDigest: 'md5:xx' })))).toBe('malformed-evidence');
    expect(codeOf(() => mintEvidenceRecord(cand({ retrievedAtUTC: 'now' })))).toBe('malformed-evidence');
    expect(codeOf(() => mintEvidenceRecord(cand({ freshness: 'fresh' })))).toBe('malformed-evidence');
  });
});

describe('validateEnvelope (X3/X4)', () => {
  const rec = (over: Record<string, unknown> = {}) => mintEvidenceRecord(cand(over));

  const summaryWith = (claims: unknown[], sources: EvidenceRecord[]): CitedSummary => ({
    claims: claims as unknown as CitedSummary['claims'],
    sources: sources as unknown as CitedSummary['sources'],
  });

  const claim = (over: Record<string, unknown> = {}) => ({
    id: 'c1', text: 'Cafe Azul is a listed place.', category: 'place-name',
    citationIds: ['ev:1'] as unknown as NonEmptyArray<string>,
    confidence: { level: 'medium', basis: { sourceDiversity: 1, freshness: 'current', density: 1 } },
    evidenceStatus: 'supported',
    ...over,
  });

  it('accepts a resolving, category-matched, current envelope', () => {
    expect(() => validateEnvelope(summaryWith([claim()], [rec()]))).not.toThrow();
  });

  it('fails closed on an unresolved citation — no cross-request/cross-envelope citation', () => {
    expect(codeOf(() => validateEnvelope(summaryWith([claim({ citationIds: ['ev:other-request'] })], [rec()]))))
      .toBe('citation-unresolved');
  });

  it('fails closed on a category mismatch — a place-name record cannot support an hours claim', () => {
    expect(codeOf(() => validateEnvelope(summaryWith(
      [claim({ category: 'place-hours', text: 'Open 09:00-17:00.' })], [rec()]))))
      .toBe('citation-category-mismatch');
  });

  it('fails closed on stale/superseded/unknown evidence under a current-state claim (X4)', () => {
    for (const freshness of ['stale', 'superseded', 'unknown']) {
      expect(codeOf(() => validateEnvelope(summaryWith(
        [claim({ category: 'place-hours' })],
        [rec({ category: 'place-hours', freshness })]))))
        .toBe('stale-current-state');
    }
  });

  it('allows stale evidence under a NON-current-state claim (display-with-disclosure)', () => {
    expect(() => validateEnvelope(summaryWith(
      [claim({ category: 'place-review', text: 'Reviewers mention friendly staff.' })],
      [rec({ category: 'place-review', freshness: 'stale' })]))).not.toThrow();
  });

  it('refuses an empty claims or sources list', () => {
    expect(codeOf(() => validateEnvelope(summaryWith([], [rec()])))).toBe('uncited-claim');
    expect(codeOf(() => validateEnvelope(summaryWith([claim()], [])))).toBe('uncited-claim');
  });
});

describe('confidenceFor (X5)', () => {
  const rec = (over: Record<string, unknown> = {}) => mintEvidenceRecord(cand(over));

  it('is high only with source DIVERSITY and full currency — not record count', () => {
    const diverse = confidenceFor([rec(), rec({ id: 'ev:2', sourceId: 'fixture:other', integrityDigest: 'sha256:beef' })]);
    expect(diverse.level).toBe('high');
    expect(diverse.basis.sourceDiversity).toBe(2);

    // Three records from ONE source stay medium — count alone buys nothing.
    const sameSource = confidenceFor([
      rec(), rec({ id: 'ev:2', integrityDigest: 'sha256:beef' }), rec({ id: 'ev:3', integrityDigest: 'sha256:cafe' }),
    ]);
    expect(sameSource.level).toBe('medium');
    expect(sameSource.basis.sourceDiversity).toBe(1);
    expect(sameSource.basis.density).toBe(3);
  });

  it('degrades to low on any non-current record, and worst freshness wins', () => {
    const c = confidenceFor([rec(), rec({ id: 'ev:2', sourceId: 'x', freshness: 'stale', integrityDigest: 'sha256:beef' })]);
    expect(c.level).toBe('low');
    expect(c.basis.freshness).toBe('stale');
  });
});
