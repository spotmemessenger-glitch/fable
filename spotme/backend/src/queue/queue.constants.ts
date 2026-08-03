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
 */
export const MAINTENANCE_DLQ = '{maintenance}-dead';

/** The no-op heartbeat job name — proves the enqueue→process loop works. */
export const HEARTBEAT_JOB = 'heartbeat';

/**
 * Default job options: retry with exponential backoff, keep a bounded window of
 * completed jobs, and NEVER auto-remove failures (a failure that vanishes is a
 * failure nobody triages — the DLQ is where they go instead).
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: 1000,
  removeOnFail: false,
} as const;
