import { createJsonLogger } from '../src/observability/json-logger';
import {
  getRegistry,
  metricsText,
  metricsEnabled,
  __resetMetricsForTest,
} from '../src/observability/metrics';
import { initSentry } from '../src/observability/sentry';
import { initOtel } from '../src/observability/otel';
import { initObservability } from '../src/observability/observability';

const OBS_ENV = [
  'LOG_FORMAT',
  'METRICS_ENABLED',
  'SENTRY_DSN',
  'SENTRY_TRACES_SAMPLE_RATE',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_SERVICE_NAME',
];

describe('observability baseline — no-op without config/env', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of OBS_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    __resetMetricsForTest();
  });

  afterEach(() => {
    for (const k of OBS_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __resetMetricsForTest();
  });

  it('is entirely disabled with a clean environment', async () => {
    const state = await initObservability();
    expect(state.logger.enabled).toBe(false);
    expect(state.sentry).toBe('disabled');
    expect(state.otel).toBe('disabled');
    expect(state.metrics).toBe('disabled');
    expect(metricsEnabled()).toBe(false);
    expect(getRegistry()).toBeNull();
    expect(await metricsText()).toBe('');
  });

  it('JSON logger is a no-op unless enabled', () => {
    const lines: string[] = [];
    const logger = createJsonLogger({ sink: (l) => lines.push(l) }); // LOG_FORMAT unset
    logger.log('info', 'hello', { a: 1 });
    expect(lines).toHaveLength(0);
  });

  it('JSON logger emits valid JSON and redacts secrets when enabled', () => {
    const lines: string[] = [];
    const logger = createJsonLogger({ enabled: true, sink: (l) => lines.push(l) });
    logger.log('warn', 'auth attempt', { userId: 'u1', password: 'hunter2', token: 'abc' });
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.level).toBe('warn');
    expect(rec.message).toBe('auth attempt');
    expect(rec.userId).toBe('u1');
    expect(rec.password).toBe('[redacted]');
    expect(rec.token).toBe('[redacted]');
    expect(typeof rec.ts).toBe('string');
  });

  it('metrics register default collectors only when METRICS_ENABLED', async () => {
    process.env.METRICS_ENABLED = 'true';
    __resetMetricsForTest();
    const reg = getRegistry();
    expect(reg).not.toBeNull();
    const text = await metricsText();
    expect(text).toContain('process_cpu'); // a default prom-client metric
  });

  it('Sentry stays no-op with a DSN but no @sentry/node installed', async () => {
    process.env.SENTRY_DSN = 'https://example@o0.ingest.sentry.io/0';
    // The optional package is not a dependency, so this must not throw.
    await expect(initSentry()).resolves.toBe('unavailable');
  });

  it('OTel stays no-op with an endpoint but no SDK installed', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
    await expect(initOtel()).resolves.toBe('unavailable');
  });
});
