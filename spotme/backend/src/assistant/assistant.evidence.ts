/**
 * The evidence ingestion boundary (Phase 6B, X2/X3/X4) — every EvidenceRecord
 * in the assistant is MINTED here, allow-list style: unknown keys are dropped,
 * forbidden keys (raw payloads, credentials, precise coordinates, HTML,
 * prompts) THROW by name, non-member license classes THROW (D11a no-scrape),
 * and the result is frozen. Envelope validation enforces the X3 fail-closed
 * citation rules and the X4 freshness gate at runtime — the same invariants
 * the contracts make uncompilable where types can reach.
 */

import { AssistantError } from './assistant.errors';
import {
  CURRENT_STATE_CATEGORIES, EVIDENCE_CATEGORIES, EVIDENCE_LICENSE_CLASSES,
  EVIDENCE_PERMITTED_USES, EVIDENCE_SOURCE_TYPES,
} from './assistant.types';
import type {
  CitedSummary, ClaimConfidence, EvidenceCategory, EvidenceLicenseClass,
  EvidencePermittedUse, EvidenceRecord, EvidenceSourceType, FreshnessState,
} from './assistant.types';

/** Field names that must never appear on an evidence candidate (X2). Their
 *  PRESENCE — not just their value — is refused, so a poisoned provider
 *  payload cannot smuggle content past the allow-list silently. */
const FORBIDDEN_EVIDENCE_KEYS: readonly string[] = [
  'rawPayload', 'payload', 'raw', 'html', 'body', 'markup',
  'prompt', 'providerPrompt', 'instructions', 'systemPrompt',
  'credentials', 'apiKey', 'token', 'secret',
  'lat', 'lon', 'latitude', 'longitude', 'coordinates', 'geometry', 'point',
  'script', 'javascript',
];

const FRESHNESS: readonly FreshnessState[] = ['current', 'stale', 'superseded', 'unknown'];

const ID_SHAPE = /^[a-z0-9:_-]{1,128}$/i;
const DIGEST_SHAPE = /^sha256:[0-9a-f]{4,64}$/i;

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 512) {
    throw new AssistantError('malformed-evidence', field);
  }
  return v;
}

/**
 * Mint an EvidenceRecord from an untrusted candidate. Allow-list only: the
 * returned record carries EXACTLY the contract fields; everything else on the
 * candidate is discarded (and forbidden keys throw first).
 */
export function mintEvidenceRecord(candidate: Record<string, unknown>): EvidenceRecord {
  if (candidate == null || typeof candidate !== 'object') {
    throw new AssistantError('malformed-evidence', 'candidate');
  }

  for (const key of Object.keys(candidate)) {
    if (FORBIDDEN_EVIDENCE_KEYS.includes(key)) {
      throw new AssistantError('forbidden-evidence-field', key);
    }
  }

  const licenseClass = candidate.licenseClass as EvidenceLicenseClass;
  if (!EVIDENCE_LICENSE_CLASSES.includes(licenseClass)) {
    // 'scraped', 'unknown', and every other non-member land here (X2/D11a).
    throw new AssistantError('unlicensed-evidence',
      typeof licenseClass === 'string' ? licenseClass.slice(0, 64) : undefined);
  }

  const category = candidate.category as EvidenceCategory;
  if (!EVIDENCE_CATEGORIES.includes(category)) {
    throw new AssistantError('unknown-evidence-category',
      typeof category === 'string' ? category.slice(0, 64) : undefined);
  }

  const sourceType = candidate.sourceType as EvidenceSourceType;
  if (!EVIDENCE_SOURCE_TYPES.includes(sourceType)) {
    throw new AssistantError('malformed-evidence', 'sourceType');
  }

  const permittedUse = candidate.permittedUse as EvidencePermittedUse;
  if (!EVIDENCE_PERMITTED_USES.includes(permittedUse)) {
    throw new AssistantError('malformed-evidence', 'permittedUse');
  }

  const freshness = candidate.freshness as FreshnessState;
  if (!FRESHNESS.includes(freshness)) {
    throw new AssistantError('malformed-evidence', 'freshness');
  }

  const id = requireString(candidate.id, 'id');
  if (!ID_SHAPE.test(id)) throw new AssistantError('malformed-evidence', 'id');

  const contentRef = requireString(candidate.contentRef, 'contentRef');
  const integrityDigest = requireString(candidate.integrityDigest, 'integrityDigest');
  if (!DIGEST_SHAPE.test(integrityDigest)) {
    throw new AssistantError('malformed-evidence', 'integrityDigest');
  }

  const retrievedAtUTC = candidate.retrievedAtUTC;
  if (typeof retrievedAtUTC !== 'number' || !Number.isFinite(retrievedAtUTC)) {
    throw new AssistantError('malformed-evidence', 'retrievedAtUTC');
  }
  const sourceUpdatedAtUTC =
    candidate.sourceUpdatedAtUTC == null ? null : candidate.sourceUpdatedAtUTC;
  if (sourceUpdatedAtUTC !== null &&
      (typeof sourceUpdatedAtUTC !== 'number' || !Number.isFinite(sourceUpdatedAtUTC))) {
    throw new AssistantError('malformed-evidence', 'sourceUpdatedAtUTC');
  }

  return Object.freeze({
    id,
    sourceId: requireString(candidate.sourceId, 'sourceId'),
    sourceType,
    licenseClass,
    category,
    retrievedAtUTC,
    sourceUpdatedAtUTC,
    freshness,
    contentRef,
    integrityDigest,
    attributionLabel: requireString(candidate.attributionLabel, 'attributionLabel'),
    permittedUse,
  });
}

/**
 * X3/X4 envelope validation — fail closed:
 *  - every citationId resolves WITHIN this envelope's sources;
 *  - every cited record's category MATCHES the claim's category;
 *  - a current-state claim (X4 set) is supported ONLY by 'current' records;
 *  - claims and sources are non-empty (uncited claims cannot exist).
 */
export function validateEnvelope(summary: CitedSummary): void {
  if (!summary.claims.length || !summary.sources.length) {
    throw new AssistantError('uncited-claim');
  }
  const byId = new Map(summary.sources.map((s) => [s.id, s]));
  for (const claim of summary.claims) {
    if (!claim.citationIds.length) throw new AssistantError('uncited-claim', claim.id);
    for (const cid of claim.citationIds) {
      const record = byId.get(cid);
      if (!record) throw new AssistantError('citation-unresolved', claim.id);
      if (record.category !== claim.category) {
        throw new AssistantError('citation-category-mismatch', claim.id);
      }
      if (CURRENT_STATE_CATEGORIES.has(claim.category) && record.freshness !== 'current') {
        throw new AssistantError('stale-current-state', claim.id);
      }
    }
  }
}

/**
 * Confidence from the X5 basis: source DIVERSITY (distinct sourceIds) +
 * worst-case FRESHNESS + citation DENSITY — never a bare record count.
 */
export function confidenceFor(records: readonly EvidenceRecord[]): ClaimConfidence {
  if (!records.length) throw new AssistantError('uncited-claim');
  const diversity = new Set(records.map((r) => r.sourceId)).size;
  const rank: Record<FreshnessState, number> = { current: 3, stale: 2, unknown: 1, superseded: 0 };
  const worst = records.reduce<FreshnessState>(
    (acc, r) => (rank[r.freshness] < rank[acc] ? r.freshness : acc), 'current');
  const density = records.length;
  const level =
    worst !== 'current' ? 'low'
    : diversity >= 2 ? 'high'
    : 'medium';
  return { level, basis: { sourceDiversity: diversity, freshness: worst, density } };
}
