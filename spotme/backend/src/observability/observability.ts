/**
 * Observability baseline orchestrator — ALL no-op without config/env.
 *
 * One entry point that wires structured JSON logging, Sentry, OTel, and
 * prom-client metrics. With a clean environment every leg is disabled and this
 * changes nothing about how the app runs. Each leg turns on independently via
 * its own env var. Prepared but NOT imported by AppModule (see
 * observability.module.ts) — additive and dark.
 */
import { createJsonLogger, type StructuredLogger } from './json-logger';
import { initSentry, type SentryStatus } from './sentry';
import { initOtel, type OtelStatus } from './otel';
import { metricsEnabled } from './metrics';

export interface ObservabilityState {
  logger: StructuredLogger;
  sentry: SentryStatus;
  otel: OtelStatus;
  metrics: 'enabled' | 'disabled';
}

export async function initObservability(): Promise<ObservabilityState> {
  const logger = createJsonLogger();
  const [sentry, otel] = await Promise.all([initSentry(), initOtel()]);
  return {
    logger,
    sentry,
    otel,
    metrics: metricsEnabled() ? 'enabled' : 'disabled',
  };
}
