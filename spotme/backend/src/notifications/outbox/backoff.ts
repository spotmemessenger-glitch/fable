/**
 * Retry policy: exponential backoff with FULL jitter, plus the transient/
 * permanent error taxonomy (design §8.2).
 *
 * Full jitter (not equal jitter) is deliberate: a provider outage that recovers
 * must not produce a synchronised retry stampede from every backend replica.
 *   delay = rand(0, min(cap, base · 2^attempts))
 */

export interface BackoffConfig {
  /** First-retry ceiling, doubled each attempt. */
  readonly baseMs: number;
  /** Hard cap on any single delay. */
  readonly capMs: number;
  /** After this many attempts a row is abandoned → dead-letter. */
  readonly maxAttempts: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 2_000, // 2s
  capMs: 5 * 60_000, // 5m
  maxAttempts: 6, // ≈ up to ~10 min of attempts, then DLQ
};

/**
 * The exponential ceiling for a given attempt (before jitter). Exposed so tests
 * and the worker can reason about the envelope without pulling in randomness.
 */
export function backoffCeilingMs(
  attempts: number,
  cfg: BackoffConfig = DEFAULT_BACKOFF,
): number {
  const n = Math.max(0, Math.floor(attempts));
  // Guard the shift against overflow for large n.
  const exp = n > 30 ? Infinity : cfg.baseMs * 2 ** n;
  return Math.min(cfg.capMs, exp);
}

/**
 * The actual delay to wait before the next attempt, with full jitter.
 * `rng` is injectable for deterministic tests; defaults to Math.random.
 */
export function nextBackoffMs(
  attempts: number,
  cfg: BackoffConfig = DEFAULT_BACKOFF,
  rng: () => number = Math.random,
): number {
  const ceiling = backoffCeilingMs(attempts, cfg);
  return Math.floor(rng() * ceiling);
}

/** Should the worker give up (dead-letter) after this many attempts? */
export function isExhausted(
  attempts: number,
  cfg: BackoffConfig = DEFAULT_BACKOFF,
): boolean {
  return attempts >= cfg.maxAttempts;
}

export type FailureKind = 'transient' | 'permanent';

/**
 * A minimal, provider-agnostic shape describing a failed send. FCM and web-push
 * report differently; the transports normalise to this before classification.
 */
export interface ProviderFailure {
  /** HTTP-ish status if the provider gave one (503, 429, 410 …). */
  statusCode?: number;
  /** Provider error code string (e.g. 'messaging/registration-token-not-registered'). */
  code?: string;
}

// Codes/statuses that mean "this endpoint is gone for good — prune, never retry".
const PERMANENT_STATUS = new Set([400, 403, 404, 410, 413]);
const PERMANENT_CODE = /(not-registered|invalid-argument|invalid-registration|mismatched-credential|unregistered|not-found|invalid_?token)/i;

// Statuses that mean "try again later".
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_CODE = /(unavailable|internal|timeout|quota|exhausted|throttl|network)/i;

/**
 * Classify a failure. Default is TRANSIENT — an unknown error is retried a
 * bounded number of times rather than silently dropped, and the max-attempt cap
 * stops an unknown-but-permanent error from retrying forever.
 */
export function classifyFailure(f: ProviderFailure): FailureKind {
  if (f.statusCode !== undefined) {
    if (PERMANENT_STATUS.has(f.statusCode)) return 'permanent';
    if (TRANSIENT_STATUS.has(f.statusCode)) return 'transient';
  }
  if (f.code) {
    if (PERMANENT_CODE.test(f.code)) return 'permanent';
    if (TRANSIENT_CODE.test(f.code)) return 'transient';
  }
  return 'transient';
}

/** Does this failure mean the token/subscription should be pruned? */
export function isDeadRegistration(f: ProviderFailure): boolean {
  return classifyFailure(f) === 'permanent';
}
