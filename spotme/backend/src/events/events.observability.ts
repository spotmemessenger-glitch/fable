/**
 * Phase 4D — DARK instrumentation for Live Nearby Events. Rides the Phase 1G
 * gates: the closed metric registry registers on the SHARED prom-client registry
 * only when METRICS_ENABLED=true; there are no call sites yet (dark). Label
 * values are a CLOSED enum per key — a source-name/coordinate/free-text value is
 * refused, so a label can never become an identity/position/attribution channel.
 */

import { getRegistry } from '../observability/metrics';

export const EVENTS_METRICS = {
  ingestBatches: 'events_ingest_batches_total',
  ingestWritten: 'events_ingest_written_total',
  dedupMerges: 'events_dedup_merges_total',
  browseDuration: 'events_browse_duration_seconds',
  providerDuration: 'events_provider_duration_seconds',
  retentionSwept: 'events_retention_swept_total',
} as const;

export type EventsMetricName = (typeof EVENTS_METRICS)[keyof typeof EVENTS_METRICS];

export const EVENTS_METRIC_LABELS: Record<EventsMetricName, readonly string[]> = {
  [EVENTS_METRICS.ingestBatches]: ['outcome'],
  [EVENTS_METRICS.ingestWritten]: ['outcome'],
  [EVENTS_METRICS.dedupMerges]: ['basis'],
  [EVENTS_METRICS.browseDuration]: ['outcome'],
  [EVENTS_METRICS.providerDuration]: ['provider', 'outcome'],
  [EVENTS_METRICS.retentionSwept]: ['outcome'],
};

/** Closed value enums per label key — enum membership is the defence. Note
 *  'provider' is a CLOSED enum of adapter TYPES, never a source/organizer name. */
export const EVENTS_LABEL_VALUES: Record<string, readonly string[]> = {
  outcome: ['ok', 'empty', 'partial', 'unavailable', 'failed'],
  basis: ['exact-provider-identity', 'cross-provider-match'],
  provider: ['fixture', 'unconfigured', 'unavailable'],
};

const FORBIDDEN_LABEL_KEYS = /(user|origin|organizer|organiser|source|title|desc|query|lat|lon|coord|cell|cursor|url|id|ip|email|phone)/i;
const DECIMAL_VALUE = /\d\.\d/;

export class EventsLabelViolation extends Error {
  constructor(detail: string) {
    super(`events metrics label violation: ${detail}`);
  }
}

export function assertEventsLabels(metric: EventsMetricName, labels: Record<string, string>): void {
  const allowed = EVENTS_METRIC_LABELS[metric];
  if (!allowed) throw new EventsLabelViolation(`unknown metric ${metric}`);
  for (const [k, v] of Object.entries(labels)) {
    if (!allowed.includes(k)) throw new EventsLabelViolation(`label key '${k}' not allow-listed for ${metric}`);
    if (FORBIDDEN_LABEL_KEYS.test(k)) throw new EventsLabelViolation(`label key '${k}' is categorically forbidden`);
    if (typeof v !== 'string') throw new EventsLabelViolation(`label value for '${k}' must be a string`);
    if (DECIMAL_VALUE.test(v)) throw new EventsLabelViolation(`label value for '${k}' contains a number — refused`);
    const values = EVENTS_LABEL_VALUES[k];
    if (!values || !values.includes(v)) throw new EventsLabelViolation(`label value '${v}' is not a registered enum member for '${k}'`);
  }
}

/** Instruments on the SHARED Phase 1G registry, or null while metrics are
 *  disabled — never instantiates its own registry (dark, no call sites yet). */
export function createEventsMetrics(): { enabled: boolean } | null {
  const registry = getRegistry();
  if (!registry) return null;
  return { enabled: true };
}
