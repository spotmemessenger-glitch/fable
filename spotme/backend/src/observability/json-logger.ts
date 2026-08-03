/**
 * Structured JSON logging — no-op unless configured.
 *
 * Emits one JSON object per line (the shape log aggregators want) ONLY when
 * `LOG_FORMAT=json`. Without that env it does nothing, so nothing changes in
 * the current human-readable Nest logs until an operator opts in.
 *
 * REDACTION IS THE ADMISSION PRICE of structured logging in an E2EE product:
 * once logs are machine-shippable they will eventually be shipped, so nothing
 * sensitive may survive serialization. Redaction is applied RECURSIVELY and on
 * two axes, and `test/observability.spec.ts` pins every category:
 *
 *  - FIELD NAMES: credentials (password/secret/token/jwt/bearer/credential),
 *    authorization headers, API keys, DSNs, cookies, connection strings
 *    (REDIS_URL / DATABASE_URL shapes), signing/encryption key material
 *    (privateKey/encryptionKey/…), PRECISE COORDINATES (lat/lon/latitude/
 *    longitude/coords — an E2EE messenger that leaks positions in its logs has
 *    undone ADR-018 in ops), and MESSAGE CONTENT (message/body/text/content/
 *    payload/plaintext/ciphertext — content never belongs in logs, encrypted
 *    or not).
 *  - VALUES: any string containing a credentialed URL (`scheme://…@host`, the
 *    shape of REDIS_URL and DATABASE_URL) is scrubbed even when it hides
 *    inside an innocently-named field.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface StructuredLogger {
  readonly enabled: boolean;
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
}

const SENSITIVE_KEY =
  /(password|secret|token|jwt|bearer|credential|authorization|auth[_-]?header|api[_-]?key|dsn|cookie|session[_-]?id|redis[_-]?url|database[_-]?url|connection[_-]?string|private[_-]?key|public[_-]?key|encryption[_-]?key|signing[_-]?key|shared[_-]?secret|prekey)/i;

const COORDINATE_KEY = /(^|[^a-z])(lat|lon|lng|latitude|longitude|coords?|position|geo[_-]?point)([^a-z]|$)/i;

const CONTENT_KEY = /^(message|body|text|content|payload|plaintext|ciphertext|attachment)s?$/i;

/** Credentialed URL — the shape of REDIS_URL / DATABASE_URL. */
const CREDENTIALED_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]*@[^\s'"]*/gi;

const REDACTED = '[redacted]';
const MAX_DEPTH = 6;

function redactValue(v: unknown, depth: number): unknown {
  if (typeof v === 'string') {
    return CREDENTIALED_URL.test(v) ? v.replace(CREDENTIALED_URL, '[redacted-url]') : v;
  }
  if (Array.isArray(v)) {
    return depth >= MAX_DEPTH ? '[depth-limit]' : v.map((x) => redactValue(x, depth + 1));
  }
  if (v && typeof v === 'object') {
    return depth >= MAX_DEPTH ? '[depth-limit]' : redactObject(v as Record<string, unknown>, depth + 1);
  }
  return v;
}

function redactObject(fields: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(k) || COORDINATE_KEY.test(k) || CONTENT_KEY.test(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = redactValue(v, depth);
    }
  }
  return out;
}

/** Exported for tests — the exact redaction the logger applies. */
export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  return redactObject(fields);
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
          // The log LINE is the operator's own words; embedded credentialed
          // URLs are still scrubbed (errors love to interpolate them).
          message: String(message).replace(CREDENTIALED_URL, '[redacted-url]'),
          ...redactFields(fields),
        }),
      );
    },
  };
}
