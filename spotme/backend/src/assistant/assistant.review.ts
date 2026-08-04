/**
 * Review-intelligence engine (Phase 6C, X5) — aggregation over licensed
 * review EvidenceRecords into PER-FIELD facets. The X5 laws, enforced here
 * and tested:
 *
 *  - facet states are the CLOSED set supported | mixed | insufficient-evidence
 *    | not-applicable — a facet with no evidence says so instead of inventing;
 *  - a MIXED facet keeps BOTH conflicting claims visible — conflicts are
 *    surfaced, never averaged away;
 *  - there is NO rating anywhere: no stars, no score, no sentiment-to-number
 *    conversion — the output shapes carry no numeric field at all beyond the
 *    confidence basis;
 *  - 'best-time-to-visit' (and every facet) fills ONLY from explicit
 *    statements — popularity/attendance is never derived from record counts;
 *  - confidence comes from source diversity + freshness + density
 *    (confidenceFor), not the number of reviews.
 */

import { AssistantError } from './assistant.errors';
import { sanitizeParam } from './assistant.compose';
import { confidenceFor } from './assistant.evidence';
import type {
  CitedClaim, EvidenceRecord, NonEmptyArray, ReviewFacet, ReviewIntelligence,
} from './assistant.types';
import type { EvidenceStatement, ReviewEvidenceBundle } from './assistant.ports';

/** CLOSED facet field registry — an unknown field in a statement THROWS. */
export const REVIEW_FACET_FIELDS = [
  'service', 'noise-level', 'cleanliness', 'wait-time', 'value', 'best-time-to-visit',
] as const;
export type ReviewFacetField = (typeof REVIEW_FACET_FIELDS)[number];

/** Closed stances — conflict means both present on one facet. */
const STANCES: readonly string[] = ['positive', 'negative'];

/** The one review claim template — text renders from facet+theme data only. */
function renderReviewText(facet: string, theme: string): string {
  return `Reviewers describe ${sanitizeParam(facet)} as ${sanitizeParam(theme)}.`;
}

interface FacetAccumulator {
  claims: CitedClaim[];
  stances: Set<string>;
}

export class ReviewIntelligenceEngine {
  /**
   * Build ReviewIntelligence for a subject from a licensed review bundle.
   * Every registry field appears exactly once: with claims (supported/mixed)
   * or as an honest insufficient-evidence / not-applicable row.
   */
  build(
    subjectRef: string,
    bundle: ReviewEvidenceBundle,
    notApplicable: readonly ReviewFacetField[] = [],
  ): ReviewIntelligence | null {
    const recordsById = new Map<string, EvidenceRecord>(bundle.records.map((r) => [r.id, r]));
    const accumulators = new Map<ReviewFacetField, FacetAccumulator>();
    const citedRecordIds = new Set<string>();

    for (const statement of bundle.statements) {
      const facet = this.facetOf(statement);
      const stance = statement.params.stance ?? 'positive';
      if (!STANCES.includes(stance)) throw new AssistantError('malformed-evidence', 'stance');
      if (!statement.citationIds.length) continue; // uncited assertions die here (X1)

      const cited: EvidenceRecord[] = [];
      let valid = true;
      for (const cid of statement.citationIds) {
        const record = recordsById.get(cid);
        if (!record || record.category !== 'place-review') { valid = false; break; }
        cited.push(record);
      }
      if (!valid) continue; // fail closed (X3) — no partial credit

      const acc = accumulators.get(facet) ?? { claims: [], stances: new Set<string>() };
      acc.claims.push({
        id: `review:${subjectRef}:${facet}:${statement.id}`,
        text: renderReviewText(facet, statement.params.theme ?? ''),
        category: 'place-review',
        citationIds: statement.citationIds as unknown as NonEmptyArray<string>,
        confidence: confidenceFor(cited),
        evidenceStatus: 'supported', // rewritten to 'mixed' below when the facet conflicts
      });
      acc.stances.add(stance);
      accumulators.set(facet, acc);
      for (const record of cited) citedRecordIds.add(record.id);
    }

    const facets: ReviewFacet[] = REVIEW_FACET_FIELDS.map((field) => {
      if (notApplicable.includes(field)) return { field, state: 'not-applicable', claims: [] };
      const acc = accumulators.get(field);
      if (!acc || !acc.claims.length) return { field, state: 'insufficient-evidence', claims: [] };
      const mixed = acc.stances.size > 1;
      const claims = mixed
        ? acc.claims.map((c) => ({ ...c, evidenceStatus: 'mixed' as const }))
        : acc.claims;
      // MIXED keeps every conflicting claim; nothing is dropped or averaged.
      return { field, state: mixed ? 'mixed' : 'supported', claims };
    });

    const sources = bundle.records.filter((r) => citedRecordIds.has(r.id));
    if (!sources.length) return null; // no supported facet at all — honest null

    return {
      subjectRef,
      facets: facets as unknown as NonEmptyArray<ReviewFacet>,
      sources: sources as unknown as NonEmptyArray<EvidenceRecord>,
    };
  }

  private facetOf(statement: EvidenceStatement): ReviewFacetField {
    const facet = statement.params.facet;
    if (!REVIEW_FACET_FIELDS.includes(facet as ReviewFacetField)) {
      throw new AssistantError('unknown-facet',
        typeof facet === 'string' ? facet.slice(0, 64) : undefined);
    }
    return facet as ReviewFacetField;
  }
}
