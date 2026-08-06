/**
 * Phase 3E — Exchange dark instrumentation: disabled-by-default posture, closed
 * metric/label registry, identity/position/free-text value refusal.
 */

import {
  EXCHANGE_METRICS,
  EXCHANGE_METRIC_LABELS,
  ExchangeLabelViolation,
  assertExchangeLabels,
  createExchangeMetrics,
} from '../src/exchange/exchange.observability';
import { __resetMetricsForTest } from '../src/observability/metrics';

describe('exchange metrics (Phase 3E)', () => {
  const OLD = process.env.METRICS_ENABLED;
  afterEach(() => {
    if (OLD === undefined) delete process.env.METRICS_ENABLED; else process.env.METRICS_ENABLED = OLD;
    __resetMetricsForTest();
  });

  it('is a NO-OP without METRICS_ENABLED', () => {
    delete process.env.METRICS_ENABLED;
    __resetMetricsForTest();
    expect(createExchangeMetrics()).toBeNull();
  });

  it('accepts registered enum values and refuses everything else', () => {
    const m = EXCHANGE_METRICS.intentMutations;
    expect(() => assertExchangeLabels(m, { kind: 'need', outcome: 'ok' })).not.toThrow();
    expect(() => assertExchangeLabels(m, { kind: 'offer', outcome: 'conflict' })).not.toThrow();
    // Free text, coordinate, id, and unknown keys are all refused.
    expect(() => assertExchangeLabels(m, { kind: 'need', outcome: 'whatever' })).toThrow(ExchangeLabelViolation);
    expect(() => assertExchangeLabels(m, { kind: '12.971' } as never)).toThrow(ExchangeLabelViolation);
    expect(() => assertExchangeLabels(m, { userId: 'u-1' } as never)).toThrow(ExchangeLabelViolation);
    expect(() => assertExchangeLabels(m, { title: 'leaky tap' } as never)).toThrow(ExchangeLabelViolation);
  });

  it('no allow-list contains an identity/position dimension', () => {
    for (const labels of Object.values(EXCHANGE_METRIC_LABELS)) {
      for (const l of labels) expect(l).not.toMatch(/user|owner|title|text|lat|lon|cell|id$/i);
    }
  });
});
