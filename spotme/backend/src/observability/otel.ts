/**
 * OpenTelemetry — an OPTIONAL SDK, no-op unless configured. Nothing more.
 *
 * Activates only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set AND the OTel SDK is
 * installed (an OPTIONAL dependency, loaded lazily); otherwise the SDK is never
 * even loaded.
 *
 * DELIBERATELY NOT CLAIMED: any bridge between OTel and prom-client. The
 * prom-client metrics (metrics.ts) exist INDEPENDENTLY and are untouched by
 * this initializer — no metric instrument is duplicated into OTel, and no
 * metrics endpoint is replaced (on current master none exists: prom-client is
 * a declared-but-unimported dependency, so metrics.ts is the first real use,
 * itself gated behind METRICS_ENABLED). If a prom↔OTel bridge is ever wanted,
 * it is its own reviewed design, not a side effect of turning the SDK on.
 */
import { optionalImport } from './optional-import';

export type OtelStatus = 'disabled' | 'initialized' | 'unavailable';

interface OtelSdkLike {
  NodeSDK: new (config: Record<string, unknown>) => { start: () => void };
}

export async function initOtel(): Promise<OtelStatus> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return 'disabled'; // no-op without config

  const sdk = await optionalImport<OtelSdkLike>('@opentelemetry/sdk-node');
  if (!sdk || typeof sdk.NodeSDK !== 'function') return 'unavailable';

  try {
    const instance = new sdk.NodeSDK({
      serviceName: process.env.OTEL_SERVICE_NAME ?? 'spotme-backend',
    });
    instance.start();
    return 'initialized';
  } catch {
    return 'unavailable';
  }
}
