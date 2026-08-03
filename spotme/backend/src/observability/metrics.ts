/**
 * Metrics via prom-client (already a dependency) — no-op unless configured.
 *
 * `METRICS_ENABLED=true` turns on a registry with Node/process default metrics;
 * without it there is no registry and `metricsText()` is empty. This is the
 * canonical metrics store; the OTel bridge (otel.ts) exports FROM here rather
 * than standing up a parallel pipeline.
 */
import client from 'prom-client';

let registry: client.Registry | null = null;

export function metricsEnabled(): boolean {
  return process.env.METRICS_ENABLED === 'true';
}

/** The shared registry, or null when metrics are disabled. */
export function getRegistry(): client.Registry | null {
  if (!metricsEnabled()) return null; // no-op without config
  if (!registry) {
    registry = new client.Registry();
    client.collectDefaultMetrics({ register: registry });
  }
  return registry;
}

/** Prometheus text exposition, or '' when disabled. */
export async function metricsText(): Promise<string> {
  const r = getRegistry();
  return r ? r.metrics() : '';
}

/** Test-only: drop the registry so env changes take effect. */
export function __resetMetricsForTest(): void {
  registry = null;
}
