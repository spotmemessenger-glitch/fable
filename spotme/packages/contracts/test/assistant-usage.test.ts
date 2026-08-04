/**
 * COMPILE-TIME POSITIVE CONTROL for the Phase 6 Assistant contracts (X1–X8).
 *
 * The negative file proves forbidden shapes DON'T compile; this file proves
 * the intended shapes DO — so the negatives aren't vacuous (a broken import
 * would make every `@ts-expect-error` "pass"). If these break, the contracts
 * became unusable, not just stricter.
 */

import { ASSISTANT_CONTRACTS_VERSION } from '../src/index.ts';
import type {
  AssistantAnswer, AssistantDomain, AssistantQuery, CitedClaim, CitedSummary,
  CoarsePublicLocation, DomainDarknessRegistry, EvidenceRecord, EvidenceRecordId,
  NonEmptyArray, ReviewFacet, ReviewIntelligence, RouteAdvice, RouteOrigin,
  SensitiveQueryCategory, VoiceSeamRef,
} from '../src/index.ts';

export const version: 1 = ASSISTANT_CONTRACTS_VERSION;

const eid = (s: string) => s as EvidenceRecordId;
const coarse = { lat: 12.972, lon: 77.595 } as unknown as CoarsePublicLocation;

/* ---------------- fixtures (all synthetic, X9) ---------------- */

const placeNameRecord: EvidenceRecord = {
  id: eid('ev-place-1'), sourceId: 'fixture:places', sourceType: 'fixture',
  licenseClass: 'fixture', category: 'place-name', retrievedAtUTC: 1_700_000_000_000,
  sourceUpdatedAtUTC: null, freshness: 'current', contentRef: 'ref:place-1',
  integrityDigest: 'sha256:aaaa', attributionLabel: 'Fixture Places', permittedUse: 'display-with-attribution',
};

const hoursRecord: EvidenceRecord = {
  id: eid('ev-hours-1'), sourceId: 'fixture:places', sourceType: 'fixture',
  licenseClass: 'fixture', category: 'place-hours', retrievedAtUTC: 1_700_000_000_000,
  sourceUpdatedAtUTC: 1_699_990_000_000, freshness: 'current', contentRef: 'ref:hours-1',
  integrityDigest: 'sha256:bbbb', attributionLabel: 'Fixture Places', permittedUse: 'display-with-attribution',
};

const reviewRecordA: EvidenceRecord = {
  id: eid('ev-rev-a'), sourceId: 'fixture:reviews', sourceType: 'fixture',
  licenseClass: 'fixture', category: 'place-review', retrievedAtUTC: 1_700_000_000_000,
  sourceUpdatedAtUTC: null, freshness: 'current', contentRef: 'ref:rev-a',
  integrityDigest: 'sha256:cccc', attributionLabel: 'Fixture Reviews', permittedUse: 'display-with-attribution',
};

const reviewRecordB: EvidenceRecord = {
  ...reviewRecordA, id: eid('ev-rev-b'), contentRef: 'ref:rev-b', integrityDigest: 'sha256:dddd',
};

const nameClaim: CitedClaim = {
  id: 'c-name', text: 'Fixture Cafe is a listed place.', category: 'place-name',
  citationIds: [placeNameRecord.id],
  confidence: { level: 'high', basis: { sourceDiversity: 1, freshness: 'current', density: 1 } },
  evidenceStatus: 'supported',
};

const hoursClaim: CitedClaim = {
  id: 'c-hours', text: 'Listed hours: 09:00-17:00 (fixture).', category: 'place-hours',
  citationIds: [hoursRecord.id],
  confidence: { level: 'medium', basis: { sourceDiversity: 1, freshness: 'current', density: 1 } },
  evidenceStatus: 'supported',
};

/* ---------------- X1: a valid cited answer constructs ---------------- */

const summary: CitedSummary = {
  claims: [nameClaim, hoursClaim],
  sources: [placeNameRecord, hoursRecord],
};

export const resultsAnswer: AssistantAnswer = { kind: 'results', domain: 'places', summary };

/* ---------------- X1/X8: exhaustive union narrowing — NO prose arm ---------------- */

export function describeAnswer(a: AssistantAnswer): string {
  switch (a.kind) {
    case 'results':
      return `cited:${a.summary.claims.length}`;
    case 'insufficient-evidence':
      return `insufficient:${a.reason}`;
    case 'domain-not-active':
      return `dark:${a.domain}`;
    case 'unavailable':
      return `unavailable:${a.reason}`;
    default: {
      // Exhaustiveness proof: if a prose (or any other) variant existed,
      // this assignment would fail to compile.
      const never: never = a;
      return never;
    }
  }
}

/* Honest states are first-class answers, constructible without evidence. */
export const insufficient: AssistantAnswer = {
  kind: 'insufficient-evidence', domain: 'events', reason: 'all-evidence-stale',
};
export const dark: AssistantAnswer = { kind: 'domain-not-active', domain: 'exchange' };
export const down: AssistantAnswer = { kind: 'unavailable', reason: 'provider-unconfigured' };

/* ---------------- X8: darkness registry is total over AssistantDomain ---------------- */

export const registry: DomainDarknessRegistry = {
  people: 'implemented-dark',
  places: 'implemented-dark',
  events: 'implemented-dark',
  exchange: 'implemented-dark',
  username: 'implemented-dark',
};
export const allDomains: readonly AssistantDomain[] = ['people', 'places', 'events', 'exchange', 'username'];

/* ---------------- X5: mixed facet keeps BOTH conflicting claims visible ---------------- */

const conflictingA: CitedClaim = {
  id: 'c-noise-quiet', text: 'Reviewers describe the space as quiet.', category: 'place-review',
  citationIds: [reviewRecordA.id],
  confidence: { level: 'low', basis: { sourceDiversity: 1, freshness: 'current', density: 1 } },
  evidenceStatus: 'mixed',
};
const conflictingB: CitedClaim = {
  id: 'c-noise-loud', text: 'Reviewers describe the space as loud on weekends.', category: 'place-review',
  citationIds: [reviewRecordB.id],
  confidence: { level: 'low', basis: { sourceDiversity: 1, freshness: 'current', density: 1 } },
  evidenceStatus: 'mixed',
};

const noiseFacet: ReviewFacet = { field: 'noise-level', state: 'mixed', claims: [conflictingA, conflictingB] };
/* No-evidence facets are honest, not invented. */
const unknownFacet: ReviewFacet = { field: 'best-time-to-visit', state: 'insufficient-evidence', claims: [] };

export const review: ReviewIntelligence = {
  subjectRef: 'place:fixture-cafe',
  facets: [noiseFacet, unknownFacet],
  sources: [reviewRecordA, reviewRecordB],
};

/* ---------------- X6: both legal origins; both route kinds ---------------- */

const coarseOrigin: RouteOrigin = { kind: 'coarse', origin: coarse };
const placeRefOrigin: RouteOrigin = { kind: 'place-ref', placeRefId: 'place:fixture-cafe' };

const routeRecord: EvidenceRecord = {
  id: eid('ev-route-1'), sourceId: 'fixture:routes', sourceType: 'fixture',
  licenseClass: 'fixture', category: 'route-leg', retrievedAtUTC: 1_700_000_000_000,
  sourceUpdatedAtUTC: null, freshness: 'current', contentRef: 'ref:route-1',
  integrityDigest: 'sha256:eeee', attributionLabel: 'Fixture Routes', permittedUse: 'display-with-attribution',
};

/* Provider legs are ATTRIBUTED passthrough, each leg cited (X6). */
export const providerRoute: RouteAdvice = {
  kind: 'provider-route',
  origin: placeRefOrigin,
  legs: [{
    mode: 'walk', providerDistanceM: 850, providerDurationS: 660,
    attribution: 'Fixture Routes', citationId: routeRecord.id,
  }],
  sources: [routeRecord],
};

/* The fallback carries its FIXED label — the only label the type admits. */
export const straightLine: RouteAdvice = {
  kind: 'straight-line',
  origin: coarseOrigin,
  estimate: { label: 'straight-line estimate', distanceM: 1200 },
};

export const routeDown: RouteAdvice = { kind: 'unavailable', reason: 'provider-unconfigured' };

/* ---------------- Query, voice seam, sensitive categories ---------------- */

const voiceSeam: VoiceSeamRef = { seam: 'ai-gateway-voice-port', state: 'disabled' };
export const query: AssistantQuery = { text: 'coffee near the plaza', origin: coarse, voice: voiceSeam };
/* Origin and voice are optional — a bare text query is legal. */
export const bareQuery: AssistantQuery = { text: 'quiet cafes' };
export const sensitiveNone: SensitiveQueryCategory = 'none';
export const sensitiveHealth: SensitiveQueryCategory = 'health';

/* ---------------- NonEmptyArray sanity ---------------- */

export const one: NonEmptyArray<string> = ['head'];
export const many: NonEmptyArray<string> = ['head', 'tail'];
export const head: string = many[0];
