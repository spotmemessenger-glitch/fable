/**
 * OpenTelemetry — no-op unless configured, bridged to the prom-client registry.
 *
 * Activates only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set AND the OTel SDK is
 * installed (OPTIONAL deps, loaded lazily). The metrics backend stays
 * prom-client (metrics.ts) — this bridges the OTel meter provider to the
 * existing registry rather than standing up a second metrics pipeline, so there
 * is one source of truth. Without the env it never loads the SDK.
 */
import { optionalImport } from './optional-import';
import { getRegistry } from './metrics';

export type OtelStatus = 'disabled' | 'initialized' | 'unavailable';

interface OtelSdkLike {
  NodeSDK: new (config: Record<string, unknown>) => { start: () => void };
}

export async function initOtel(): Promise<OtelStatus> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return 'disabled'; // no-op without config

  const sdk = await optionalImport<OtelSdkLike>('@opentelemetry/sdk-node');
  if (!sdk || typeof sdk.NodeSDK !== 'function') return 'unavailable';

  // Ensure the prom-client registry exists so traces/metrics share one backend.
  getRegistry();
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
