/**
 * Checkpoint 14 — DARK instrumentation for the discovery platform.
 *
 * Everything here rides the Phase 1G observability posture and inherits its
 * gates: metrics register on the SHARED prom-client registry and are a no-op
 * unless `METRICS_ENABLED=true` (metrics.ts); structured logs go through the
 * redacting JSON logger and are a no-op unless `LOG_FORMAT=json`
 * (json-logger.ts); tracing is name-constants only — the OTel SDK activates
 * exclusively through the Phase 1G initializer, never from here.
 *
 * CARDINALITY AND PRIVACY ARE ENFORCED, NOT PROMISED: metric names and label
 * keys are CLOSED SETS. `assertDiscoveryLabels` refuses any label key outside
 * the per-metric allow-list and any label VALUE that could carry identity or
 * position — user ids, handles, coordinate-shaped numbers, raw query text,
 * tokens. A label is an aggregation dimension, never a data channel.
 */

import { randomUUID } from 'node:crypto';
import type { Counter, Histogram } from 'prom-client';
import { getRegistry } from '../observability/metrics';
import { createJsonLogger, StructuredLogger } from '../observability/json-logger';

/* ----------------------------------------------------------- metric names */

/** The CLOSED registry of discovery metrics — nothing else may be emitted. */
export const DISCOVERY_METRICS = {
  queryDuration: 'discovery_query_duration_seconds',
  queryResults: 'discovery_query_results_total',
  searchProviderDuration: 'discovery_search_provider_duration_seconds',
  searchBreakerTransitions: 'discovery_search_breaker_transitions_total',
  visibilityWrites: 'discovery_visibility_writes_total',
  realtimePublishes: 'discovery_realtime_publish_total',
  expiredPresenceSwept: 'discovery_expired_presence_swept_total',
} as const;

export type DiscoveryMetricName = (typeof DISCOVERY_METRICS)[keyof typeof DISCOVERY_METRICS];

/**
 * Per-metric label allow-lists. Every value is a SMALL ENUM the caller picks
 * from — never free text. userId / handle / query / coordinates are absent by
 * construction and refused at runtime.
 */
export const DISCOVERY_METRIC_LABELS: Record<DiscoveryMetricName, readonly string[]> = {
  [DISCOVERY_METRICS.queryDuration]: ['scope', 'outcome', 'radius_bucket'],
  [DISCOVERY_METRICS.queryResults]: ['scope', 'outcome'],
  [DISCOVERY_METRICS.searchProviderDuration]: ['provider', 'outcome'],
  [DISCOVERY_METRICS.searchBreakerTransitions]: ['provider', 'to_state'],
  [DISCOVERY_METRICS.visibilityWrites]: ['outcome'],
  [DISCOVERY_METRICS.realtimePublishes]: ['event_type', 'outcome'],
  [DISCOVERY_METRICS.expiredPresenceSwept]: ['outcome'],
};

/** Label KEYS that may never appear, whatever the metric (identity/position). */
const FORBIDDEN_LABEL_KEYS =
  /(user|principal|handle|name|query|text|message|token|secret|key|lat|lon|lng|coord|cell|cursor|ip|email|phone)/i;

/** Label VALUES that look like data rather than an enum member. */
const FORBIDDEN_LABEL_VALUE =
  /^-?\d{1,3}\.\d{4,}$|eyJ[A-Za-z0-9_-]{10,}|:\/\/|@|\s/;

export class DiscoveryLabelViolation extends Error {
  constructor(detail: string) {
    super(`discovery metrics label violation: ${detail}`);
  }
}

/** Refuses unknown metrics, non-allow-listed keys, and data-shaped values. */
export function assertDiscoveryLabels(
  metric: DiscoveryMetricName,
  labels: Record<string, string>,
): void {
  const allowed = DISCOVERY_METRIC_LABELS[metric];
  if (!allowed) throw new DiscoveryLabelViolation(`unknown metric ${metric}`);
  for (const [k, v] of Object.entries(labels)) {
    if (!allowed.includes(k)) throw new DiscoveryLabelViolation(`label key '${k}' not allow-listed for ${metric}`);
    if (FORBIDDEN_LABEL_KEYS.test(k)) throw new DiscoveryLabelViolation(`label key '${k}' is categorically forbidden`);
    if (typeof v !== 'string' || v.length > 32 || FORBIDDEN_LABEL_VALUE.test(v)) {
      throw new DiscoveryLabelViolation(`label value for '${k}' looks like data, not an enum member`);
    }
  }
}

/** Radius → tiny bucket enum, so radius can be a label without cardinality. */
export function radiusBucket(radiusKm: number): 'lte2' | 'lte5' | 'lte10' | 'lte25' {
  if (radiusKm <= 2) return 'lte2';
  if (radiusKm <= 5) return 'lte5';
  if (radiusKm <= 10) return 'lte10';
  return 'lte25';
}

/* ------------------------------------------------------------ instruments */

export interface DiscoveryMetrics {
  observeQuery(labels: { scope: string; outcome: string; radius_bucket: string }, seconds: number): void;
  countResults(labels: { scope: string; outcome: string }, n: number): void;
  observeSearchProvider(labels: { provider: string; outcome: string }, seconds: number): void;
  countBreakerTransition(labels: { provider: string; to_state: string }): void;
  countVisibilityWrite(labels: { outcome: string }): void;
  countRealtimePublish(labels: { event_type: string; outcome: string }): void;
  countExpiredSwept(labels: { outcome: string }, n: number): void;
}

/**
 * Instruments on the SHARED Phase 1G registry, or null while metrics are
 * disabled — callers hold the null and skip, exactly like the rest of the
 * observability surface. Never instantiates its own registry.
 */
export function createDiscoveryMetrics(): DiscoveryMetrics | null {
  const registry = getRegistry();
  if (!registry) return null; // no-op without METRICS_ENABLED=true

  // prom-client is already a dependency (Phase 1G); required lazily so simply
  // importing this module never loads it on the dark path.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const client = require('prom-client') as typeof import('prom-client');
  const secondsBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

  const hist = (name: DiscoveryMetricName, help: string): Histogram<string> =>
    (registry.getSingleMetric(name) as Histogram<string>) ??
    new client.Histogram({
      name,
      help,
      labelNames: [...DISCOVERY_METRIC_LABELS[name]],
      buckets: secondsBuckets,
      registers: [registry],
    });
  const counter = (name: DiscoveryMetricName, help: string): Counter<string> =>
    (registry.getSingleMetric(name) as Counter<string>) ??
    new client.Counter({
      name,
      help,
      labelNames: [...DISCOVERY_METRIC_LABELS[name]],
      registers: [registry],
    });

  const queryDuration = hist(DISCOVERY_METRICS.queryDuration, 'Discovery query latency by scope/outcome/radius bucket');
  const queryResults = counter(DISCOVERY_METRICS.queryResults, 'Discovery results returned (count only — never content)');
  const providerDuration = hist(DISCOVERY_METRICS.searchProviderDuration, 'Search provider call latency');
  const breaker = counter(DISCOVERY_METRICS.searchBreakerTransitions, 'Search circuit-breaker state transitions');
  const visibility = counter(DISCOVERY_METRICS.visibilityWrites, 'Visibility preference writes by outcome');
  const realtime = counter(DISCOVERY_METRICS.realtimePublishes, 'Realtime discovery publishes by event type/outcome');
  const swept = counter(DISCOVERY_METRICS.expiredPresenceSwept, 'Expired presence rows swept');

  return {
    observeQuery(labels, seconds) {
      assertDiscoveryLabels(DISCOVERY_METRICS.queryDuration, labels);
      queryDuration.observe(labels, seconds);
    },
    countResults(labels, n) {
      assertDiscoveryLabels(DISCOVERY_METRICS.queryResults, labels);
      queryResults.inc(labels, n);
    },
    observeSearchProvider(labels, seconds) {
      assertDiscoveryLabels(DISCOVERY_METRICS.searchProviderDuration, labels);
      providerDuration.observe(labels, seconds);
    },
    countBreakerTransition(labels) {
      assertDiscoveryLabels(DISCOVERY_METRICS.searchBreakerTransitions, labels);
      breaker.inc(labels);
    },
    countVisibilityWrite(labels) {
      assertDiscoveryLabels(DISCOVERY_METRICS.visibilityWrites, labels);
      visibility.inc(labels);
    },
    countRealtimePublish(labels) {
      assertDiscoveryLabels(DISCOVERY_METRICS.realtimePublishes, labels);
      realtime.inc(labels);
    },
    countExpiredSwept(labels, n) {
      assertDiscoveryLabels(DISCOVERY_METRICS.expiredPresenceSwept, labels);
      swept.inc(labels, n);
    },
  };
}

/* --------------------------------------------------------------- logging */

/**
 * Correlation-scoped structured logger: every line carries an opaque
 * `correlationId` (a fresh UUID — derived from nothing) so one request's
 * lines can be joined WITHOUT any user identifier, and every field passes
 * through the Phase 1G redactor (coordinates, content, credentials).
 */
export interface DiscoveryLogger {
  readonly correlationId: string;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void;
}

/**
 * Discovery goes FURTHER than the Phase 1G redactor: a user's SEARCH TEXT is
 * behavioural data ("clinic near me") and never belongs in logs, so
 * query-shaped fields are redacted here before the base redactor runs.
 */
const DISCOVERY_SENSITIVE_KEY = /(query|search|term|input|intent[_-]?text)/i;

export function createDiscoveryLogger(
  base: StructuredLogger = createJsonLogger(),
  correlationId: string = randomUUID(),
): DiscoveryLogger {
  return {
    correlationId,
    log(level, message, fields = {}) {
      const scrubbed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        scrubbed[k] = DISCOVERY_SENSITIVE_KEY.test(k) ? '[redacted]' : v;
      }
      base.log(level, message, { component: 'discovery', correlationId, ...scrubbed });
    },
  };
}

/* --------------------------------------------------------------- tracing */

/**
 * Span NAME constants only. Spans come into existence exclusively when the
 * Phase 1G OTel initializer (observability/otel.ts) has activated the SDK;
 * this module never loads or configures OTel itself. Span attributes must be
 * drawn from the SAME allow-lists as metric labels.
 */
export const DISCOVERY_SPANS = {
  query: 'discovery.query',
  peopleRepository: 'discovery.people.repository',
  search: 'discovery.search.provider',
  visibilityWrite: 'discovery.visibility.write',
  realtimePublish: 'discovery.realtime.publish',
} as const;
