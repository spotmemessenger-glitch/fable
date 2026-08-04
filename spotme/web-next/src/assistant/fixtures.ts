/**
 * Assistant fixtures (Phase 6D) — deterministic canned responses shaped by
 * the Phase 6A contracts. All data synthetic (X9). The fixture routes by
 * simple keyword so every honest answer state is reachable from the inert
 * surface: cited results, insufficient-evidence, domain-not-active,
 * unavailable, and the sensitive-notice path.
 */

import type {
  AssistantAnswer, CitedClaim, EvidenceRecord, EvidenceRecordId,
  CoarsePublicLocation, ReviewIntelligence, RouteAdvice,
} from '@spotme/contracts';
import type { AssistantApiPort, AssistantQueryInput, AssistantResponseView } from './ports';

const eid = (s: string) => s as EvidenceRecordId;

const record = (over: Omit<Partial<EvidenceRecord>, 'id'> & { id: string }): EvidenceRecord => ({
  sourceId: 'fixture:places-a', sourceType: 'fixture', licenseClass: 'fixture',
  category: 'place-name', retrievedAtUTC: 1_700_000_000_000, sourceUpdatedAtUTC: null,
  freshness: 'current', contentRef: `ref:${over.id}`, integrityDigest: 'sha256:f1x',
  attributionLabel: 'Fixture Places', permittedUse: 'display-with-attribution',
  ...over, id: eid(over.id),
});

const nameA = record({ id: 'ev:azul:name' });
const nameB = record({ id: 'ev:azul:name-b', sourceId: 'fixture:places-b', attributionLabel: 'Fixture Atlas' });
const hours = record({ id: 'ev:azul:hours', category: 'place-hours', sourceUpdatedAtUTC: 1_699_990_000_000 });
const staleReview = record({
  id: 'ev:azul:rev-old', category: 'place-review', freshness: 'stale',
  sourceId: 'fixture:reviews-a', attributionLabel: 'Fixture Reviews',
});

const claims: CitedClaim[] = [
  { id: 'c1', text: 'Cafe Azul is a listed place in the plaza.', category: 'place-name',
    citationIds: [nameA.id, nameB.id],
    confidence: { level: 'high', basis: { sourceDiversity: 2, freshness: 'current', density: 2 } },
    evidenceStatus: 'supported' },
  { id: 'c2', text: 'Cafe Azul lists hours 09:00-17:00.', category: 'place-hours',
    citationIds: [hours.id],
    confidence: { level: 'medium', basis: { sourceDiversity: 1, freshness: 'current', density: 1 } },
    evidenceStatus: 'supported' },
  { id: 'c3', text: 'Reviewers mention friendly staff.', category: 'place-review',
    citationIds: [staleReview.id],
    confidence: { level: 'low', basis: { sourceDiversity: 1, freshness: 'stale', density: 1 } },
    evidenceStatus: 'supported' },
];

const resultsAnswer: AssistantAnswer = {
  kind: 'results', domain: 'places',
  summary: { claims: claims as never, sources: [nameA, nameB, hours, staleReview] as never },
};

const reviewA = record({ id: 'ev:rev:a', category: 'place-review', licenseClass: 'licensed-provider', sourceId: 'fixture:reviews-a', attributionLabel: 'Fixture Reviews A' });
const reviewB = record({ id: 'ev:rev:b', category: 'place-review', licenseClass: 'consented-community', sourceId: 'fixture:reviews-b', attributionLabel: 'Fixture Reviews B' });

const reviewFixture: ReviewIntelligence = {
  subjectRef: 'place:cafe-azul',
  facets: [
    { field: 'service', state: 'supported', claims: [
      { id: 'rf1', text: 'Reviewers describe service as friendly and quick.', category: 'place-review',
        citationIds: [reviewA.id, reviewB.id],
        confidence: { level: 'high', basis: { sourceDiversity: 2, freshness: 'current', density: 2 } },
        evidenceStatus: 'supported' },
    ] },
    { field: 'noise-level', state: 'mixed', claims: [
      { id: 'rf2', text: 'Reviewers describe noise-level as quiet on weekdays.', category: 'place-review',
        citationIds: [reviewA.id],
        confidence: { level: 'medium', basis: { sourceDiversity: 1, freshness: 'current', density: 1 } },
        evidenceStatus: 'mixed' },
      { id: 'rf3', text: 'Reviewers describe noise-level as loud on weekends.', category: 'place-review',
        citationIds: [reviewB.id],
        confidence: { level: 'medium', basis: { sourceDiversity: 1, freshness: 'current', density: 1 } },
        evidenceStatus: 'mixed' },
    ] },
    { field: 'best-time-to-visit', state: 'insufficient-evidence', claims: [] },
    { field: 'wait-time', state: 'insufficient-evidence', claims: [] },
  ] as never,
  sources: [reviewA, reviewB] as never,
};

const routeLegRecord = record({
  id: 'ev:route:walk', category: 'route-leg', licenseClass: 'licensed-provider',
  sourceId: 'fixture:routes', attributionLabel: 'Fixture Routes',
});

/** [PROPOSED] — mirrors the closed backend copy; carried as DATA here. */
const HEALTH_NOTICE =
  'This assistant cannot provide medical advice, diagnosis, or treatment. ' +
  'For health concerns, please consult a qualified healthcare professional.';

export class FixtureAssistantApi implements AssistantApiPort {
  /** Outbound payloads, captured for the privacy mutation battery. */
  readonly outbound: unknown[] = [];

  async query(input: AssistantQueryInput): Promise<AssistantResponseView> {
    this.outbound.push({ endpoint: 'assistant/query', payload: input });
    const lower = input.text.toLowerCase();

    const respond = (answer: AssistantAnswer, sensitive = false): AssistantResponseView => ({
      correlationId: `fix-${this.outbound.length}`,
      answer,
      sensitiveCategory: sensitive ? 'health' : 'none',
      sensitiveNotice: sensitive ? HEALTH_NOTICE : null,
    });

    if (lower.includes('clinic')) {
      return respond({ kind: 'domain-not-active', domain: 'places' }, true);
    }
    if (lower.includes('event')) return respond({ kind: 'domain-not-active', domain: 'events' });
    if (lower.includes('nothing')) {
      return respond({ kind: 'insufficient-evidence', domain: 'places', reason: 'no-evidence' });
    }
    if (lower.includes('offline')) {
      return respond({ kind: 'unavailable', reason: 'provider-unconfigured' });
    }
    return respond(resultsAnswer);
  }

  async reviewIntelligence(subjectRef: string): Promise<ReviewIntelligence | null> {
    this.outbound.push({ endpoint: 'assistant/review', payload: { subjectRef } });
    return subjectRef === 'place:cafe-azul' ? reviewFixture : null;
  }

  async routeAdvice(destinationRef: string, origin: CoarsePublicLocation | null): Promise<RouteAdvice> {
    this.outbound.push({ endpoint: 'assistant/route', payload: { destinationRef, origin } });
    if (destinationRef === 'place:cafe-azul') {
      return {
        kind: 'provider-route',
        origin: { kind: 'place-ref', placeRefId: destinationRef },
        legs: [{ mode: 'walk', providerDistanceM: 850, providerDurationS: 660,
          attribution: 'Fixture Routes', citationId: routeLegRecord.id }] as never,
        sources: [routeLegRecord] as never,
      };
    }
    if (destinationRef === 'place:faraway' && origin) {
      return {
        kind: 'straight-line',
        origin: { kind: 'coarse', origin },
        estimate: { label: 'straight-line estimate', distanceM: 1200 },
      };
    }
    return { kind: 'unavailable', reason: 'provider-unconfigured' };
  }
}
