/**
 * COMPILE-TIME NEGATIVE TESTS for the Phase 6 Assistant contracts (X1–X6).
 * Each `@ts-expect-error` asserts the marked assignment DOES NOT compile.
 */

import type {
  AssistantAnswer, CitedClaim, CitedSummary, EvidenceRecord, EvidenceRecordId,
  EvidenceLicenseClass, ReviewIntelligence, RouteAdvice, RouteOrigin,
  CoarsePublicLocation, NonEmptyArray, ReviewFacet,
} from '../src/index.ts';

const eid = (s: string) => s as EvidenceRecordId;
const coarse = { lat: 12.972, lon: 77.595 } as unknown as CoarsePublicLocation;

const record: EvidenceRecord = {
  id: eid('ev1'), sourceId: 'fixture:places', sourceType: 'fixture',
  licenseClass: 'fixture', category: 'place-name', retrievedAtUTC: 1,
  sourceUpdatedAtUTC: null, freshness: 'current', contentRef: 'ref:1',
  integrityDigest: 'sha256:x', attributionLabel: 'Fixture Places', permittedUse: 'display-with-attribution',
};

const claim: CitedClaim = {
  id: 'c1', text: 'Cafe Azul exists on 5th street.', category: 'place-name',
  citationIds: [eid('ev1')],
  confidence: { level: 'high', basis: { sourceDiversity: 1, freshness: 'current', density: 1 } },
  evidenceStatus: 'supported',
};

/* X1: there is NO prose answer variant. */
export const okAnswer: AssistantAnswer = { kind: 'results', domain: 'places', summary: { claims: [claim], sources: [record] } };
// @ts-expect-error a prose/free-text answer kind does not exist (X1)
export const proseBad: AssistantAnswer = { kind: 'prose', text: 'Cafe Azul is great!' };
export const badResults: AssistantAnswer = {
  kind: 'results', domain: 'places',
  // @ts-expect-error a results answer cannot carry a bare string body (X1)
  summary: 'Cafe Azul is great!',
};

/* X1: an UNCITED claim is unrepresentable — citationIds is non-empty by type. */
export const uncited: CitedClaim = {
  id: 'c2', text: 'x', category: 'place-name',
  // @ts-expect-error empty citation list cannot type as NonEmptyArray (X1/X3)
  citationIds: [],
  confidence: claim.confidence, evidenceStatus: 'supported',
};

/* X1: a summary with zero claims or zero sources is unrepresentable. */
// @ts-expect-error claims must be non-empty (X1)
export const emptySummary: CitedSummary = { claims: [], sources: [record] };

/* X2: unknown/scraped license classes are not members. */
// @ts-expect-error 'scraped' is not a license class (X2, D11a no-scrape)
export const scraped: EvidenceLicenseClass = 'scraped';
// @ts-expect-error 'unknown' is not a license class (X2)
export const unknownLc: EvidenceLicenseClass = 'unknown';

/* X2: precise coordinates / payload / prompt fields don't exist on evidence. */
export function noPreciseOnEvidence(e: EvidenceRecord): void {
  // @ts-expect-error evidence carries no coordinates (X2)
  void e.lat;
  // @ts-expect-error evidence carries no raw provider payload (X2)
  void e.rawPayload;
  // @ts-expect-error evidence carries no provider prompt/instructions (X2)
  void e.providerPrompt;
}

/* X5: NO generated rating anywhere on review shapes. */
export function noRating(r: ReviewIntelligence, f: ReviewFacet): void {
  // @ts-expect-error review intelligence has no star rating (X5)
  void r.rating;
  // @ts-expect-error facets have no numeric score/stars (X5)
  void f.stars;
}

/* X6: a precise device origin is unrepresentable on a route. */
export const okOrigin: RouteOrigin = { kind: 'coarse', origin: coarse };
export const badOrigin: RouteOrigin = {
  kind: 'coarse',
  // @ts-expect-error a raw {lat,lon} device fix is not a branded coarse origin (X6)
  origin: { lat: 12.9716, lon: 77.5946 },
};
export const slBad: RouteAdvice = {
  kind: 'straight-line', origin: okOrigin,
  // @ts-expect-error the straight-line label is a fixed literal — cannot claim to be a route (X6)
  estimate: { label: 'route distance', distanceM: 100 },
};

/* NonEmptyArray sanity: a populated list is fine. */
export const one: NonEmptyArray<string> = ['a'];
