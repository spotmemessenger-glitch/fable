/**
 * Phase 6E — citation-integrity INVARIANTS (X3) + the closed-metrics fence
 * (X9). Evidence is immutable after mint (no post-ingestion relabeling);
 * removing evidence invalidates its dependent claims; a citation can never
 * cross envelopes; and no metric label can carry a query, a name, or any
 * free-form value — labels die by key name and by enum membership.
 */

import { DeterministicSummaryComposer } from '../src/assistant/assistant.compose';
import { mintEvidenceRecord, validateEnvelope } from '../src/assistant/assistant.evidence';
import { FixturePlaceEvidence } from '../src/assistant/assistant.fixtures';
import {
  ASSISTANT_METRICS, AssistantLabelViolation, assertAssistantLabels, createAssistantMetrics,
} from '../src/assistant/assistant.observability';
import type { CitedSummary, EvidenceRecord } from '../src/assistant/assistant.types';

const composer = new DeterministicSummaryComposer();

async function composedSummary(): Promise<CitedSummary> {
  const bundle = await new FixturePlaceEvidence().gather({ domain: 'places' }, 'cafes');
  const summary = composer.compose(bundle);
  if (!summary) throw new Error('fixture must compose');
  return summary;
}

describe('citation integrity invariants (X3)', () => {
  it('evidence records are FROZEN at mint — post-ingestion relabeling throws', () => {
    const record = mintEvidenceRecord({
      id: 'ev:x', sourceId: 's', sourceType: 'fixture', licenseClass: 'fixture',
      category: 'place-name', retrievedAtUTC: 1, sourceUpdatedAtUTC: null, freshness: 'current',
      contentRef: 'r', integrityDigest: 'sha256:abcd', attributionLabel: 'F',
      permittedUse: 'display-with-attribution',
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(() => { (record as { licenseClass: string }).licenseClass = 'scraped'; }).toThrow(TypeError);
    expect(() => { (record as { freshness: string }).freshness = 'current'; }).toThrow(TypeError);
    expect(record.licenseClass).toBe('fixture');
  });

  it('REMOVING evidence invalidates its dependent claims — the envelope fails closed', async () => {
    const summary = await composedSummary();
    expect(() => validateEnvelope(summary)).not.toThrow(); // intact envelope is valid
    const removedId = summary.claims[0].citationIds[0];
    const pruned: CitedSummary = {
      claims: summary.claims,
      sources: summary.sources.filter((s) => s.id !== removedId) as unknown as CitedSummary['sources'],
    };
    expect(() => validateEnvelope(pruned)).toThrow(/citation-unresolved/);
  });

  it('a citation can never cross envelopes — another request\'s record id does not resolve', async () => {
    const summary = await composedSummary();
    const foreign: CitedSummary = {
      claims: [{
        ...summary.claims[0],
        citationIds: ['ev:some-other-request:1'] as unknown as CitedSummary['claims'][0]['citationIds'],
      }] as unknown as CitedSummary['claims'],
      sources: summary.sources,
    };
    expect(() => validateEnvelope(foreign)).toThrow(/citation-unresolved/);
  });

  it('the composer never emits a source that supports no claim — no uncited evidence rides along', async () => {
    const summary = await composedSummary();
    const cited = new Set(summary.claims.flatMap((c) => [...c.citationIds] as string[]));
    for (const source of summary.sources as readonly EvidenceRecord[]) {
      expect(cited.has(source.id)).toBe(true);
    }
  });
});

describe('closed assistant metrics (X9)', () => {
  it('metrics are DARK by default: no registry without METRICS_ENABLED', () => {
    expect(process.env.METRICS_ENABLED).not.toBe('true');
    expect(createAssistantMetrics()).toBeNull();
  });

  it('accepts only registered keys with closed enum values', () => {
    expect(() => assertAssistantLabels(ASSISTANT_METRICS.queries,
      { outcome: 'domain-not-active', domain: 'places' })).not.toThrow();
    expect(() => assertAssistantLabels(ASSISTANT_METRICS.sensitiveQueries,
      { category: 'health' })).not.toThrow();
  });

  it('REFUSES a query-shaped label key by NAME', () => {
    for (const key of ['query', 'text', 'question', 'prompt']) {
      expect(() => assertAssistantLabels(ASSISTANT_METRICS.queries,
        { [key]: 'places' })).toThrow(AssistantLabelViolation);
    }
  });

  it('REFUSES free-text values by enum membership — query text can never become a label value', () => {
    expect(() => assertAssistantLabels(ASSISTANT_METRICS.queries,
      { outcome: 'where is the nearest clinic' })).toThrow(AssistantLabelViolation);
    expect(() => assertAssistantLabels(ASSISTANT_METRICS.sensitiveQueries,
      { category: 'my private situation' })).toThrow(AssistantLabelViolation);
    expect(() => assertAssistantLabels(ASSISTANT_METRICS.evidenceMinted,
      { license: 'scraped' })).toThrow(AssistantLabelViolation);
  });

  it('REFUSES unknown metrics and coordinate-shaped decimals', () => {
    expect(() => assertAssistantLabels('made_up_metric' as never, { outcome: 'results' }))
      .toThrow(AssistantLabelViolation);
    expect(() => assertAssistantLabels(ASSISTANT_METRICS.queries, { outcome: '12.972' }))
      .toThrow(AssistantLabelViolation);
  });
});
