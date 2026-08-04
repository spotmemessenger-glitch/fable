/**
 * The deterministic summary composer (Phase 6B) — SummaryPort-shaped, the same
 * seam as the merged Phase 1E AI Gateway SummaryPort: TEMPLATE COMPOSITION,
 * no generation. Adapters assert statements referencing a CLOSED template
 * registry; this composer renders text ONLY from those templates, builds
 * claims whose citations it verifies against the envelope (X3), applies the
 * X4 freshness gate (a current-state statement backed by non-current evidence
 * yields NO claim), computes X5 confidence, and returns null — not prose —
 * when nothing survives.
 */

import { AssistantError } from './assistant.errors';
import { confidenceFor, validateEnvelope } from './assistant.evidence';
import { CURRENT_STATE_CATEGORIES } from './assistant.types';
import type {
  CitedClaim, CitedSummary, EvidenceRecord, NonEmptyArray,
} from './assistant.types';
import type { AssistantSummaryPort, EvidenceBundle, EvidenceStatement } from './assistant.ports';

/** CLOSED template registry — the only place answer text comes from. Params
 *  are interpolated verbatim after sanitization; there is no free-form path. */
const TEMPLATES: Readonly<Record<string, (p: Record<string, string>) => string>> = Object.freeze({
  'place-exists': (p) => `${p.name} is a listed place${p.area ? ` in ${p.area}` : ''}.`,
  'place-hours': (p) => `${p.name} lists hours ${p.hours}.`,
  'place-review-theme': (p) => `Reviewers mention ${p.theme}.`,
  'person-presence-band': (p) => `${p.label} was recently active ${p.band}.`,
  'event-scheduled': (p) => `${p.title} is listed ${p.when}.`,
  'exchange-listing': (p) => `A listing matches: ${p.title}.`,
  'username-found': (p) => `@${p.handle} is a registered username.`,
  'route-summary': (p) => `${p.mode} route via ${p.provider}: ${p.distance}, about ${p.duration}.`,
  'road-condition': (p) => `${p.source} reports ${p.condition} on ${p.where}.`,
});

/** Param sanitization: bounded plain text, control characters stripped —
 *  params are DATA slotted into fixed templates, never markup or directives. */
function sanitizeParam(value: string): string {
  return String(value).replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, 160);
}

function renderStatement(statement: EvidenceStatement): string {
  const template = TEMPLATES[statement.templateKey];
  if (!template) throw new AssistantError('unknown-template', statement.templateKey.slice(0, 64));
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(statement.params)) params[k] = sanitizeParam(v);
  return template(params);
}

export class DeterministicSummaryComposer implements AssistantSummaryPort {
  readonly name = 'deterministic-template-composer';

  compose(bundle: EvidenceBundle): CitedSummary | null {
    const recordsById = new Map(bundle.records.map((r) => [r.id, r]));
    const claims: CitedClaim[] = [];
    const citedRecordIds = new Set<string>();

    for (const statement of bundle.statements) {
      // An uncited statement never becomes a claim (X1).
      if (!statement.citationIds.length) continue;

      const cited: EvidenceRecord[] = [];
      let valid = true;
      for (const cid of statement.citationIds) {
        const record = recordsById.get(cid);
        // Unresolved or category-mismatched citations disqualify the
        // statement (X3) — fail closed, no partial credit.
        if (!record || record.category !== statement.category) { valid = false; break; }
        // X4: current-state statements survive only on fully current evidence.
        if (CURRENT_STATE_CATEGORIES.has(statement.category) && record.freshness !== 'current') {
          valid = false; break;
        }
        cited.push(record);
      }
      if (!valid) continue;

      claims.push({
        id: `claim:${statement.id}`,
        text: renderStatement(statement),
        category: statement.category,
        citationIds: statement.citationIds as unknown as NonEmptyArray<string>,
        confidence: confidenceFor(cited),
        evidenceStatus: 'supported',
      });
      for (const record of cited) citedRecordIds.add(record.id);
    }

    if (!claims.length) return null;

    // The envelope carries ONLY the records that support surviving claims —
    // uncited evidence does not ride along into the answer.
    const sources = bundle.records.filter((r) => citedRecordIds.has(r.id));
    const summary: CitedSummary = {
      claims: claims as unknown as NonEmptyArray<CitedClaim>,
      sources: sources as unknown as NonEmptyArray<EvidenceRecord>,
    };
    validateEnvelope(summary);
    return summary;
  }
}
