/**
 * Checkpoint 14 — dark instrumentation: disabled-by-default posture, closed
 * metric/label registry, identity/position label refusal, correlation-scoped
 * redacted logging.
 */

import {
  DISCOVERY_METRICS,
  DISCOVERY_METRIC_LABELS,
  DiscoveryLabelViolation,
  assertDiscoveryLabels,
  createDiscoveryLogger,
  createDiscoveryMetrics,
  radiusBucket,
} from '../src/discovery/discovery.observability';
import { __resetMetricsForTest, getRegistry } from '../src/observability/metrics';
import { createJsonLogger } from '../src/observability/json-logger';

describe('discovery metrics (checkpoint 14)', () => {
  const OLD = process.env.METRICS_ENABLED;
  afterEach(() => {
    if (OLD === undefined) delete process.env.METRICS_ENABLED;
    else process.env.METRICS_ENABLED = OLD;
    __resetMetricsForTest();
  });

  it('is a NO-OP without METRICS_ENABLED — no registry is ever created', () => {
    delete process.env.METRICS_ENABLED;
    __resetMetricsForTest();
    expect(createDiscoveryMetrics()).toBeNull();
  });

  it('registers on the SHARED Phase 1G registry when enabled — never its own', async () => {
    process.env.METRICS_ENABLED = 'true';
    __resetMetricsForTest();
    const m = createDiscoveryMetrics();
    expect(m).not.toBeNull();
    m!.observeQuery({ scope: 'people', outcome: 'ok', radius_bucket: radiusBucket(2) }, 0.012);
    m!.countRealtimePublish({ event_type: 'cell-presence-updated', outcome: 'ok' });
    const text = await getRegistry()!.metrics();
    expect(text).toContain(DISCOVERY_METRICS.queryDuration);
    expect(text).toContain(DISCOVERY_METRICS.realtimePublishes);
  });

  it('every emitted metric name is in the CLOSED constant set', async () => {
    process.env.METRICS_ENABLED = 'true';
    __resetMetricsForTest();
    createDiscoveryMetrics();
    const names = (await getRegistry()!.getMetricsAsJSON()).map((j) => j.name);
    const closed = new Set<string>(Object.values(DISCOVERY_METRICS));
    for (const n of names.filter((x) => x.startsWith('discovery_'))) {
      expect(closed.has(n)).toBe(true);
    }
  });

  it('REFUSES label keys outside the allow-list and identity/position keys', () => {
    expect(() =>
      assertDiscoveryLabels(DISCOVERY_METRICS.queryDuration, { userId: 'u-1' } as never),
    ).toThrow(DiscoveryLabelViolation);
    expect(() =>
      assertDiscoveryLabels(DISCOVERY_METRICS.queryResults, { handle: 'priya' } as never),
    ).toThrow(DiscoveryLabelViolation);
    expect(() =>
      assertDiscoveryLabels(DISCOVERY_METRICS.searchProviderDuration, { query: 'coffee' } as never),
    ).toThrow(DiscoveryLabelViolation);
  });

  it('REFUSES any value outside the closed enum — incl. the shapes a regex missed (F9-1)', () => {
    const m = DISCOVERY_METRICS.queryDuration;
    // Full-precision coordinate (caught before, still caught):
    expect(() => assertDiscoveryLabels(m, { scope: '12.971612' })).toThrow(DiscoveryLabelViolation);
    // The bypasses the shape regex allowed — now refused by enum membership:
    expect(() => assertDiscoveryLabels(m, { scope: '12.971' })).toThrow(DiscoveryLabelViolation); // 3-decimal coord
    expect(() => assertDiscoveryLabels(m, { scope: 'priya' })).toThrow(DiscoveryLabelViolation); // short handle
    expect(() => assertDiscoveryLabels(m, { scope: 'dXNlci0xMjM0' })).toThrow(DiscoveryLabelViolation); // base64 id
    expect(() => assertDiscoveryLabels(m, { outcome: 'sneaky' } as never)).toThrow(DiscoveryLabelViolation);
    // The intended enum members pass.
    expect(() =>
      assertDiscoveryLabels(m, { scope: 'people', outcome: 'ok', radius_bucket: 'lte2' }),
    ).not.toThrow();
  });

  it('no allow-list contains an identity/position dimension (registry self-audit)', () => {
    for (const labels of Object.values(DISCOVERY_METRIC_LABELS)) {
      for (const l of labels) {
        expect(l).not.toMatch(/user|handle|query|lat|lon|cell|cursor|token/i);
      }
    }
  });
});

describe('discovery structured logging (checkpoint 14)', () => {
  it('carries an opaque correlationId and passes fields through the Phase 1G redactor', () => {
    const lines: string[] = [];
    const logger = createDiscoveryLogger(
      createJsonLogger({ enabled: true, sink: (l) => lines.push(l) }),
    );
    logger.log('info', 'query served', {
      scope: 'people',
      lat: 12.971612345678, // redacted by the Phase 1G coordinate rule
      query: 'clinic near me', // redacted by the DISCOVERY rule (search text = behavioural data)
      resultCount: 7,
    });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.component).toBe('discovery');
    expect(parsed.correlationId).toBe(logger.correlationId);
    expect(parsed.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines[0]).not.toContain('12.971612345678');
    expect(lines[0]).not.toContain('clinic near me');
    expect(parsed.lat).toBe('[redacted]');
    expect(parsed.query).toBe('[redacted]');
    expect(parsed.resultCount).toBe(7);
  });

  it('redacts short query aliases and user-id fields (F9-3) and cannot be overridden (F9-4)', () => {
    const lines: string[] = [];
    const logger = createDiscoveryLogger(createJsonLogger({ enabled: true, sink: (l) => lines.push(l) }));
    logger.log('info', 'served', {
      q: 'clinic near me',        // short alias the base redactor misses
      needle: 'plumber',
      userId: 'u-123',            // never log a user id (runbook promise)
      handle: 'priya',
      resultCount: 3,
      // An attempt to override the opaque id / component must NOT win.
      correlationId: 'attacker-supplied',
      component: 'not-discovery',
    });
    const parsed = JSON.parse(lines[0]);
    expect(parsed.q).toBe('[redacted]');
    expect(parsed.needle).toBe('[redacted]');
    expect(parsed.userId).toBe('[redacted]');
    expect(parsed.handle).toBe('[redacted]');
    expect(parsed.resultCount).toBe(3);
    expect(parsed.component).toBe('discovery');            // not overridden
    expect(parsed.correlationId).toBe(logger.correlationId); // not overridden
    expect(lines[0]).not.toContain('clinic near me');
    expect(lines[0]).not.toContain('attacker-supplied');
  });

  it('is a NO-OP without LOG_FORMAT=json (Phase 1G gate inherited)', () => {
    const lines: string[] = [];
    const logger = createDiscoveryLogger(createJsonLogger({ enabled: false, sink: (l) => lines.push(l) }));
    logger.log('error', 'anything', { detail: 'x' });
    expect(lines).toHaveLength(0);
  });

  it('two loggers never share a correlationId; an explicit id is honored', () => {
    const a = createDiscoveryLogger(createJsonLogger({ enabled: false }));
    const b = createDiscoveryLogger(createJsonLogger({ enabled: false }));
    expect(a.correlationId).not.toBe(b.correlationId);
    const fixed = createDiscoveryLogger(createJsonLogger({ enabled: false }), 'corr-fixed');
    expect(fixed.correlationId).toBe('corr-fixed');
  });
});
