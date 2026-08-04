/**
 * Phase 3E — DARK instrumentation for Exchange. Rides the Phase 1G gates: the
 * closed metric registry registers on the SHARED prom-client registry only when
 * METRICS_ENABLED=true; there are no call sites yet (dark). Label values are a
 * CLOSED enum per key — a userId/handle/coordinate/free-text value is refused,
 * so a label can never become an identity/position channel.
 */

import { getRegistry } from '../observability/metrics';

export const EXCHANGE_METRICS = {
  intentMutations: 'exchange_intent_mutations_total',
  lifecycleTransitions: 'exchange_lifecycle_transitions_total',
  browseDuration: 'exchange_browse_duration_seconds',
  matchProposals: 'exchange_match_proposals_total',
  searchProviderDuration: 'exchange_search_provider_duration_seconds',
  contactRequests: 'exchange_contact_requests_total',
} as const;

export type ExchangeMetricName = (typeof EXCHANGE_METRICS)[keyof typeof EXCHANGE_METRICS];

export const EXCHANGE_METRIC_LABELS: Record<ExchangeMetricName, readonly string[]> = {
  [EXCHANGE_METRICS.intentMutations]: ['kind', 'outcome'],
  [EXCHANGE_METRICS.lifecycleTransitions]: ['to_status', 'by'],
  [EXCHANGE_METRICS.browseDuration]: ['outcome'],
  [EXCHANGE_METRICS.matchProposals]: ['outcome'],
  [EXCHANGE_METRICS.searchProviderDuration]: ['provider', 'outcome'],
  [EXCHANGE_METRICS.contactRequests]: ['outcome'],
};

/** Closed value enums per label key — enum membership is the defence. */
export const EXCHANGE_LABEL_VALUES: Record<string, readonly string[]> = {
  kind: ['need', 'offer', 'service'],
  outcome: ['ok', 'empty', 'unavailable', 'error', 'refused', 'conflict'],
  to_status: ['draft', 'active', 'paused', 'matched', 'fulfilled', 'expired', 'withdrawn', 'removed'],
  by: ['owner', 'moderation', 'system-expiry'],
  provider: ['typesense', 'unconfigured'],
};

const FORBIDDEN_LABEL_KEYS = /(user|principal|owner|handle|title|text|query|lat|lon|coord|cell|cursor|id|ip|email|phone)/i;
const DECIMAL_VALUE = /\d\.\d/;

export class ExchangeLabelViolation extends Error {
  constructor(detail: string) {
    super(`exchange metrics label violation: ${detail}`);
  }
}

export function assertExchangeLabels(metric: ExchangeMetricName, labels: Record<string, string>): void {
  const allowed = EXCHANGE_METRIC_LABELS[metric];
  if (!allowed) throw new ExchangeLabelViolation(`unknown metric ${metric}`);
  for (const [k, v] of Object.entries(labels)) {
    if (!allowed.includes(k)) throw new ExchangeLabelViolation(`label key '${k}' not allow-listed for ${metric}`);
    if (FORBIDDEN_LABEL_KEYS.test(k)) throw new ExchangeLabelViolation(`label key '${k}' is categorically forbidden`);
    if (typeof v !== 'string') throw new ExchangeLabelViolation(`label value for '${k}' must be a string`);
    if (DECIMAL_VALUE.test(v)) throw new ExchangeLabelViolation(`label value for '${k}' contains a number — refused`);
    const values = EXCHANGE_LABEL_VALUES[k];
    if (!values || !values.includes(v)) throw new ExchangeLabelViolation(`label value '${v}' is not a registered enum member for '${k}'`);
  }
}

/** Instruments on the SHARED Phase 1G registry, or null while metrics are
 *  disabled — never instantiates its own registry (dark, no call sites yet). */
export function createExchangeMetrics(): { enabled: boolean } | null {
  const registry = getRegistry();
  if (!registry) return null;
  return { enabled: true };
}
