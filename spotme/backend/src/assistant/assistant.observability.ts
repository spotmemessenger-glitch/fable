/**
 * Phase 6E — DARK instrumentation for the assistant. Rides the Phase 1G
 * gates: the closed metric registry registers on the SHARED prom-client
 * registry only when METRICS_ENABLED=true; there are no call sites yet
 * (dark). Label keys AND values are CLOSED enums — X9 hard rule: query text
 * (or anything free-form) can never be a label. A 'query'/'text'-shaped key
 * is refused by name; a non-member value is refused by enum membership.
 */

import { getRegistry } from '../observability/metrics';

export const ASSISTANT_METRICS = {
  queries: 'assistant_queries_total',
  answerDuration: 'assistant_answer_duration_seconds',
  sensitiveQueries: 'assistant_sensitive_queries_total',
  evidenceMinted: 'assistant_evidence_minted_total',
  integrityFailures: 'assistant_integrity_failures_total',
} as const;

export type AssistantMetricName = (typeof ASSISTANT_METRICS)[keyof typeof ASSISTANT_METRICS];

export const ASSISTANT_METRIC_LABELS: Record<AssistantMetricName, readonly string[]> = {
  [ASSISTANT_METRICS.queries]: ['outcome', 'domain'],
  [ASSISTANT_METRICS.answerDuration]: ['outcome'],
  [ASSISTANT_METRICS.sensitiveQueries]: ['category'],
  [ASSISTANT_METRICS.evidenceMinted]: ['license'],
  [ASSISTANT_METRICS.integrityFailures]: ['code'],
};

/** Closed value enums per label key — membership is the defence. Note
 *  'category' is the CLOSED sensitive category, never text; 'code' is the
 *  closed AssistantError code set. */
export const ASSISTANT_LABEL_VALUES: Record<string, readonly string[]> = {
  outcome: ['results', 'insufficient-evidence', 'domain-not-active', 'unavailable', 'invalid'],
  domain: ['people', 'places', 'events', 'exchange', 'username', 'none'],
  category: ['health', 'crisis', 'legal', 'financial', 'none'],
  license: ['first-party', 'authorized-provider', 'licensed-provider', 'owner-supplied', 'consented-community', 'fixture'],
  code: [
    'invalid-query', 'unlicensed-evidence', 'forbidden-evidence-field',
    'unknown-evidence-category', 'malformed-evidence', 'citation-unresolved',
    'citation-category-mismatch', 'stale-current-state', 'uncited-claim',
    'unknown-template', 'fixture-mode-forbidden', 'provider-unconfigured',
    'unknown-facet', 'precise-route-origin',
  ],
};

const FORBIDDEN_LABEL_KEYS =
  /(query|text|question|prompt|user|origin|lat|lon|coord|cell|cursor|url|id|ip|email|phone|source|attribution|handle)/i;
const DECIMAL_VALUE = /\d\.\d/;

export class AssistantLabelViolation extends Error {
  constructor(detail: string) {
    super(`assistant metrics label violation: ${detail}`);
  }
}

export function assertAssistantLabels(
  metric: AssistantMetricName,
  labels: Record<string, string>,
): void {
  const allowed = ASSISTANT_METRIC_LABELS[metric];
  if (!allowed) throw new AssistantLabelViolation(`unknown metric ${metric}`);
  for (const [key, value] of Object.entries(labels)) {
    if (!allowed.includes(key)) throw new AssistantLabelViolation(`label key ${key} not allowed`);
    if (FORBIDDEN_LABEL_KEYS.test(key)) throw new AssistantLabelViolation(`label key ${key} forbidden`);
    const values = ASSISTANT_LABEL_VALUES[key];
    if (!values || !values.includes(value)) {
      // Free text (a query, a name, a coordinate) dies HERE, by membership.
      throw new AssistantLabelViolation(`label value for ${key} not in closed enum`);
    }
    if (DECIMAL_VALUE.test(value)) throw new AssistantLabelViolation('decimal label value');
  }
}

/** Instruments on the SHARED Phase 1G registry, or null while metrics are
 *  disabled — never instantiates its own registry (dark, no call sites yet). */
export function createAssistantMetrics(): { enabled: boolean } | null {
  const registry = getRegistry();
  if (!registry) return null;
  return { enabled: true };
}
