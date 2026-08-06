/**
 * Queue naming and defaults.
 *
 * DRAGONFLY THREAD-AFFINITY: every queue name is wrapped in a `{…}` hash tag.
 * On Dragonfly Cloud (and Redis Cluster) all keys sharing a hash tag map to the
 * same slot/thread, so BullMQ's multi-key Lua scripts stay on one shard. The
 * dead-letter queue reuses the SAME tag as its source so a job and its grave
 * co-locate. Every future queue MUST follow this convention.
 */

/** The first queue: low-priority background maintenance work. */
export const MAINTENANCE_QUEUE = '{maintenance}';

/**
 * Dead-letter queue for maintenance jobs that exhaust their retries. Same
 * `{maintenance}` hash tag as the source (so grave and job co-locate), a hyphen
 * separator because BullMQ forbids `:` in queue names.
 *
 * WHAT LANDS HERE IS AN ENVELOPE, NEVER THE JOB'S PAYLOAD. BullMQ itself
 * retains the failed job (with its data) in the source queue's bounded failed
 * set — that is the forensic record, access-controlled like the rest of Redis.
 * The DLQ carries only a SANITIZED failure envelope (ids, counts, a scrubbed
 * reason) so a triage listing can never leak a secret or an unrestricted
 * payload. See `sanitizeFailureReason()` in maintenance.queue.ts.
 */
export const MAINTENANCE_DLQ = '{maintenance}-dead';

/**
 * The no-op smoke job. MANUALLY INVOKED ONLY — nothing schedules it, no
 * recurring worker rides production startup; it exists so an operator (or the
 * integration test) can prove the enqueue → process → acknowledge loop.
 */
export const SMOKE_JOB = 'smoke';

/**
 * Default job options — every bound explicit:
 * - bounded retries with exponential backoff;
 * - completed jobs kept as a bounded window, not forever;
 * - FAILED jobs retained in BullMQ's failed set — bounded by count, never
 *   auto-removed to zero (a failure that vanishes is a failure nobody
 *   triages) and never unbounded (that is a slow leak on a paid runtime).
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
} as const;
