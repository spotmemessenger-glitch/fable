/**
 * Phase 5E — DARK instrumentation for Nearby Moments. Rides the Phase 1G gates:
 * the closed metric registry registers on the SHARED prom-client registry only
 * when METRICS_ENABLED=true; there are no call sites yet (dark). Label values
 * are a CLOSED enum per key — an author/viewer/coordinate/free-text value is
 * refused, so a label can never become an identity/position/content channel.
 */

import { getRegistry } from '../observability/metrics';

export const MOMENTS_METRICS = {
  posts: 'moments_posts_total',
  feedDuration: 'moments_feed_duration_seconds',
  storyTransitions: 'moments_story_transitions_total',
  reactions: 'moments_reactions_total',
  reports: 'moments_reports_total',
  mediaIngest: 'moments_media_ingest_total',
} as const;

export type MomentsMetricName = (typeof MOMENTS_METRICS)[keyof typeof MOMENTS_METRICS];

export const MOMENTS_METRIC_LABELS: Record<MomentsMetricName, readonly string[]> = {
  [MOMENTS_METRICS.posts]: ['visibility', 'kind'],
  [MOMENTS_METRICS.feedDuration]: ['mode', 'outcome'],
  [MOMENTS_METRICS.storyTransitions]: ['to_state'],
  [MOMENTS_METRICS.reactions]: ['reaction'],
  [MOMENTS_METRICS.reports]: ['reason', 'priority'],
  [MOMENTS_METRICS.mediaIngest]: ['outcome'],
};

/** Closed value enums per label key — enum membership is the defence. */
export const MOMENTS_LABEL_VALUES: Record<string, readonly string[]> = {
  visibility: ['private', 'friends', 'nearby', 'public'],
  kind: ['photo', 'video', 'text'],
  mode: ['nearby', 'friends', 'city'],
  outcome: ['ok', 'empty', 'unavailable', 'failed', 'refused', 'stored', 'deduplicated'],
  to_state: ['active', 'expired', 'deleted', 'archived', 'hidden', 'moderation-hidden'],
  reaction: ['like', 'love', 'laugh', 'wow', 'support'],
  reason: ['spam', 'harassment', 'doxxing', 'image-abuse', 'child-safety', 'revenge-content', 'fake-business', 'malware-link', 'other-report'],
  priority: ['child-safety', 'standard'],
};

const FORBIDDEN_LABEL_KEYS = /(user|author|viewer|origin|text|title|note|query|lat|lon|coord|cell|cursor|url|id|ip|email|phone)/i;
const DECIMAL_VALUE = /\d\.\d/;

export class MomentsLabelViolation extends Error {
  constructor(detail: string) {
    super(`moments metrics label violation: ${detail}`);
  }
}

export function assertMomentsLabels(metric: MomentsMetricName, labels: Record<string, string>): void {
  const allowed = MOMENTS_METRIC_LABELS[metric];
  if (!allowed) throw new MomentsLabelViolation(`unknown metric ${metric}`);
  for (const [k, v] of Object.entries(labels)) {
    if (!allowed.includes(k)) throw new MomentsLabelViolation(`label key '${k}' not allow-listed for ${metric}`);
    if (FORBIDDEN_LABEL_KEYS.test(k)) throw new MomentsLabelViolation(`label key '${k}' is categorically forbidden`);
    if (typeof v !== 'string') throw new MomentsLabelViolation(`label value for '${k}' must be a string`);
    if (DECIMAL_VALUE.test(v)) throw new MomentsLabelViolation(`label value for '${k}' contains a number — refused`);
    const values = MOMENTS_LABEL_VALUES[k];
    if (!values || !values.includes(v)) throw new MomentsLabelViolation(`label value '${v}' is not a registered enum member for '${k}'`);
  }
}

/** Instruments on the SHARED Phase 1G registry, or null while metrics are
 *  disabled — never instantiates its own registry (dark, no call sites yet). */
export function createMomentsMetrics(): { enabled: boolean } | null {
  const registry = getRegistry();
  if (!registry) return null;
  return { enabled: true };
}
