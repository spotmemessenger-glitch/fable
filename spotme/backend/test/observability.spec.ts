import { createJsonLogger, redactFields } from '../src/observability/json-logger';
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

  it('JSON logger emits valid JSON when enabled', () => {
    const lines: string[] = [];
    const logger = createJsonLogger({ enabled: true, sink: (l) => lines.push(l) });
    logger.log('warn', 'auth attempt', { userId: 'u1' });
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.level).toBe('warn');
    expect(rec.message).toBe('auth attempt');
    expect(rec.userId).toBe('u1');
    expect(typeof rec.ts).toBe('string');
  });

  /* ------------------------------------------------------------------ *
   * REDACTION — one test per required category. These are the admission
   * price of structured logging in an E2EE product; a category regressing
   * here must fail the build, not surface in an incident review.
   * ------------------------------------------------------------------ */
  describe('redaction (field-name + value axes, recursive)', () => {
    it('tokens and credentials', () => {
      const out = redactFields({ token: 'abc', refreshToken: 'r1', jwt: 'x.y.z', password: 'hunter2', apiKey: 'k' });
      for (const v of Object.values(out)) expect(v).toBe('[redacted]');
    });

    it('authorization headers', () => {
      const out = redactFields({ authorization: 'Bearer abc123', authHeader: 'Basic xyz' });
      expect(out.authorization).toBe('[redacted]');
      expect(out.authHeader).toBe('[redacted]');
    });

    it('precise coordinates — an E2EE messenger must not leak positions via ops', () => {
      const out = redactFields({ lat: 12.9716, lon: 77.5946, latitude: 1, longitude: 2, coords: { lat: 1, lon: 2 }, geo_point: 'x' });
      for (const v of Object.values(out)) expect(v).toBe('[redacted]');
    });

    it('message contents — content never belongs in logs, encrypted or not', () => {
      const out = redactFields({ message: 'hi there', body: 'b', text: 't', content: 'c', payload: { x: 1 }, plaintext: 'p', ciphertext: 'q' });
      for (const v of Object.values(out)) expect(v).toBe('[redacted]');
    });

    it('encryption/signing key material', () => {
      const out = redactFields({ privateKey: 'pk', publicKey: 'pub', encryptionKey: 'ek', signingKey: 'sk', sharedSecret: 'ss', prekey: 'opk' });
      for (const v of Object.values(out)) expect(v).toBe('[redacted]');
    });

    it('REDIS_URL — by field name AND as a value hidden in an innocent field', () => {
      const byName = redactFields({ redisUrl: 'rediss://default:s3cr3t@dfly.example:6385', REDIS_URL: 'x' });
      expect(byName.redisUrl).toBe('[redacted]');
      expect(byName.REDIS_URL).toBe('[redacted]');
      const byValue = redactFields({ note: 'failed connecting to rediss://default:s3cr3t@dfly.example:6385 twice' });
      expect(String(byValue.note)).not.toContain('s3cr3t');
      expect(String(byValue.note)).toContain('[redacted-url]');
    });

    it('database URLs — by field name AND by value', () => {
      const out = redactFields({
        databaseUrl: 'postgresql://app:dbpass@db.internal:5432/spotme',
        connectionString: 'x',
        err: 'PrismaClientInitializationError: postgresql://app:dbpass@db.internal:5432/spotme unreachable',
      });
      expect(out.databaseUrl).toBe('[redacted]');
      expect(out.connectionString).toBe('[redacted]');
      expect(String(out.err)).not.toContain('dbpass');
      expect(String(out.err)).toContain('[redacted-url]');
    });

    it('redaction is RECURSIVE — nesting cannot smuggle a secret out', () => {
      const out = redactFields({
        request: { headers: { authorization: 'Bearer abc' }, user: { location: { lat: 1.23, lon: 4.56 } } },
      });
      const req = out.request as Record<string, unknown>;
      expect((req.headers as Record<string, unknown>).authorization).toBe('[redacted]');
      const user = req.user as Record<string, unknown>;
      // `location` is not itself a sensitive name; its lat/lon children are.
      const loc = user.location as Record<string, unknown>;
      expect(loc.lat).toBe('[redacted]');
      expect(loc.lon).toBe('[redacted]');
    });

    it('the log MESSAGE line itself scrubs credentialed URLs', () => {
      const lines: string[] = [];
      const logger = createJsonLogger({ enabled: true, sink: (l) => lines.push(l) });
      logger.log('error', 'boot failed: rediss://default:s3cr3t@dfly.example:6385 refused');
      const rec = JSON.parse(lines[0]);
      expect(rec.message).not.toContain('s3cr3t');
      expect(rec.message).toContain('[redacted-url]');
    });

    it('non-sensitive fields pass through untouched', () => {
      const out = redactFields({ userId: 'u1', roomId: 'r9', durationMs: 42, ok: true });
      expect(out).toEqual({ userId: 'u1', roomId: 'r9', durationMs: 42, ok: true });
    });
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
