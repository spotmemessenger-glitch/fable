/**
 * Phase 5E — Moments instrumentation: closed metric + label registries. A label
 * can never become an identity/position/content channel.
 */

import {
  assertMomentsLabels, MOMENTS_METRICS, MOMENTS_METRIC_LABELS, MOMENTS_LABEL_VALUES, MomentsLabelViolation,
} from '../src/moments/moments.observability';

describe('moments observability (closed registries)', () => {
  it('accepts allow-listed metric + enum label values', () => {
    expect(() => assertMomentsLabels(MOMENTS_METRICS.posts, { visibility: 'nearby', kind: 'photo' })).not.toThrow();
    expect(() => assertMomentsLabels(MOMENTS_METRICS.reports, { reason: 'child-safety', priority: 'child-safety' })).not.toThrow();
  });

  it('refuses non-allow-listed and categorically-forbidden keys', () => {
    expect(() => assertMomentsLabels(MOMENTS_METRICS.posts, { authorId: 'u1' } as never)).toThrow(MomentsLabelViolation);
    for (const k of ['viewerLat', 'text', 'cell', 'url', 'authorId']) {
      expect(() => assertMomentsLabels(MOMENTS_METRICS.feedDuration, { [k]: 'x', mode: 'nearby', outcome: 'ok' } as never)).toThrow(MomentsLabelViolation);
    }
  });

  it('refuses off-enum and decimal-shaped values', () => {
    expect(() => assertMomentsLabels(MOMENTS_METRICS.reactions, { reaction: 'angry' })).toThrow(MomentsLabelViolation);
    expect(() => assertMomentsLabels(MOMENTS_METRICS.feedDuration, { mode: '12.972', outcome: 'ok' })).toThrow(MomentsLabelViolation);
  });

  it('the registries are closed and complete', () => {
    expect(Object.keys(MOMENTS_METRICS).length).toBe(6);
    for (const labels of Object.values(MOMENTS_METRIC_LABELS)) expect(Array.isArray(labels)).toBe(true);
    expect(MOMENTS_LABEL_VALUES.reaction).toEqual(['like', 'love', 'laugh', 'wow', 'support']);
  });
});
