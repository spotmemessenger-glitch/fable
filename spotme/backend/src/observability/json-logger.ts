/**
 * Structured JSON logging — no-op unless configured.
 *
 * Emits one JSON object per line (the shape log aggregators want) ONLY when
 * `LOG_FORMAT=json`. Without that env it does nothing, so nothing changes in
 * the current human-readable Nest logs until an operator opts in. Never logs a
 * secret: known-sensitive field names are redacted before serialization.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface StructuredLogger {
  readonly enabled: boolean;
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
}

const SENSITIVE = /(password|secret|token|authorization|api[_-]?key|dsn|redis[_-]?url|cookie)/i;

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = SENSITIVE.test(k) ? '[redacted]' : v;
  }
  return out;
}

export function createJsonLogger(opts: {
  enabled?: boolean;
  sink?: (line: string) => void;
} = {}): StructuredLogger {
  const enabled = opts.enabled ?? process.env.LOG_FORMAT === 'json';
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + '\n'));
  return {
    enabled,
    log(level, message, fields = {}) {
      if (!enabled) return; // no-op without config
      sink(
        JSON.stringify({
          ts: new Date().toISOString(),
          level,
          message,
          ...redact(fields),
        }),
      );
    },
  };
}
