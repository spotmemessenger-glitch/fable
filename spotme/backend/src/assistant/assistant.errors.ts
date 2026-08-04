/**
 * Assistant errors (Phase 6B) — a CLOSED code set, X9-safe by construction:
 * an AssistantError carries a code and an optional SAFE detail drawn from a
 * closed vocabulary. There is no free-text message channel, so query text can
 * never ride an exception into a log, trace, or client response (X9 — the
 * privacy battery asserts this on every error path).
 */

export type AssistantErrorCode =
  | 'invalid-query'
  | 'unlicensed-evidence'
  | 'forbidden-evidence-field'
  | 'unknown-evidence-category'
  | 'malformed-evidence'
  | 'citation-unresolved'
  | 'citation-category-mismatch'
  | 'stale-current-state'
  | 'uncited-claim'
  | 'unknown-template'
  | 'fixture-mode-forbidden'
  | 'provider-unconfigured'
  | 'unknown-facet'
  /** RESERVED since review repair F1: server-side off-grid detection is
   *  numerically impossible (jittered coarse values deviate MORE from the
   *  grid than raw fixes do), so the route boundary QUANTIZES instead of
   *  throwing. Kept in the closed registry for an activation-time
   *  origin-provenance model (e.g. signed coarse origins). */
  | 'precise-route-origin';

const CODES: ReadonlySet<string> = new Set([
  'invalid-query', 'unlicensed-evidence', 'forbidden-evidence-field',
  'unknown-evidence-category', 'malformed-evidence', 'citation-unresolved',
  'citation-category-mismatch', 'stale-current-state', 'uncited-claim',
  'unknown-template', 'fixture-mode-forbidden', 'provider-unconfigured',
  'unknown-facet', 'precise-route-origin',
]);

/** Safe details: closed identifiers only (a field NAME, a class NAME — never
 *  values, never query text). */
const SAFE_DETAIL = /^[a-z0-9-]{1,64}$/i;

export class AssistantError extends Error {
  readonly code: AssistantErrorCode;
  readonly detail: string | null;

  constructor(code: AssistantErrorCode, detail?: string) {
    if (!CODES.has(code)) throw new Error('assistant-error: unknown code');
    const safeDetail = detail != null && SAFE_DETAIL.test(detail) ? detail : null;
    super(safeDetail ? `${code}: ${safeDetail}` : code);
    this.name = 'AssistantError';
    this.code = code;
    this.detail = safeDetail;
  }
}
