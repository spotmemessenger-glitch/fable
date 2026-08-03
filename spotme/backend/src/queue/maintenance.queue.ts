import { Queue, Worker, type Job, type Processor, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { createRedisConnection } from './redis.connection';
import {
  MAINTENANCE_QUEUE,
  MAINTENANCE_DLQ,
  SMOKE_JOB,
  DEFAULT_JOB_OPTIONS,
} from './queue.constants';

/** Result of the smoke job — a no-op that proves the loop works. */
export interface SmokeResult {
  ok: true;
  ranAt: number;
}

/**
 * Enqueue outcome — DISCRIMINATED, so a disabled or closing queue can never be
 * mistaken for a successful enqueue. "No silent loss when disabled": the caller
 * always learns whether the job was accepted, and why not when it wasn't.
 */
export type EnqueueResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: 'disabled' | 'closing' };

/** The default processor: the no-op smoke job. Real jobs are added later. */
export const smokeProcessor: Processor = async (job: Job) => {
  if (job.name === SMOKE_JOB) {
    return { ok: true, ranAt: Date.now() } satisfies SmokeResult;
  }
  // Unknown job names are a programming error; fail loudly so they retry then
  // land in the DLQ rather than being silently dropped.
  throw new Error(`unknown maintenance job: ${job.name}`);
};

/**
 * Scrub a failure reason before it enters the dead-letter envelope. Two rules:
 * credentialed URLs (any `scheme://…@host` — the shape of REDIS_URL and
 * DATABASE_URL) are replaced wholesale, and the reason is truncated — an error
 * message that interpolated a payload must not carry it into the DLQ.
 */
export function sanitizeFailureReason(reason: string, maxLen = 300): string {
  const scrubbed = String(reason).replace(
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]*@[^\s'"]*/gi,
    '[redacted-url]',
  );
  return scrubbed.length > maxLen ? `${scrubbed.slice(0, maxLen)}…[truncated]` : scrubbed;
}

/**
 * The sanitized failure envelope — the ONLY shape the DLQ ever stores. It
 * deliberately has no field for the job's payload: BullMQ's bounded failed set
 * on the source queue keeps the full job for forensics; the DLQ is the triage
 * index, and a triage index must be safe to list, log, and screen-share.
 */
export interface DeadLetterEnvelope {
  sourceQueue: string;
  jobId: string | null;
  jobName: string;
  attemptsMade: number;
  failedAt: string;
  failedReason: string;
}

export interface MaintenanceQueueOptions {
  /** Override default job options (used by tests for fast retries). */
  jobOptions?: JobsOptions;
  /** Override the processor (used by tests to force failures). */
  processor?: Processor;
  /** Inject a connection factory (tests); defaults to REDIS_URL (env). */
  connectionFactory?: () => Redis | null;
}

/**
 * The `{maintenance}` queue: a Queue, a Worker, and a dead-letter queue, wired
 * on ioredis. DISABLED cleanly when no Redis-protocol runtime is configured —
 * `start()` is a no-op, enqueues return `{ok:false, reason:'disabled'}`,
 * `enabled` is false. Once `close()` begins, further enqueues return
 * `{ok:false, reason:'closing'}` — a shutting-down queue accepts nothing.
 *
 * Additive and dark: nothing in the request path constructs or depends on this,
 * and nothing schedules recurring work — the smoke job is manual-only.
 */
export class MaintenanceQueue {
  private queue: Queue | null = null;
  private dlq: Queue | null = null;
  private worker: Worker | null = null;
  private connections: Redis[] = [];
  private _enabled = false;
  private _closing = false;

  constructor(private readonly opts: MaintenanceQueueOptions = {}) {}

  get enabled(): boolean {
    return this._enabled;
  }

  private makeConnection(): Redis | null {
    return (this.opts.connectionFactory ?? createRedisConnection)();
  }

  /** Idempotent. Starts the queue/worker if a Redis runtime is configured. */
  start(): void {
    if (this._enabled || this._closing) return;
    const queueConn = this.makeConnection();
    if (!queueConn) {
      // No REDIS_URL — stay disabled. Deliberately no URL in this message.
      return;
    }
    const workerConn = this.makeConnection();
    const dlqConn = this.makeConnection();
    if (!workerConn || !dlqConn) {
      queueConn.disconnect();
      workerConn?.disconnect();
      return;
    }
    this.connections.push(queueConn, workerConn, dlqConn);

    const defaultJobOptions: JobsOptions = {
      ...DEFAULT_JOB_OPTIONS,
      ...this.opts.jobOptions,
    };

    this.queue = new Queue(MAINTENANCE_QUEUE, {
      connection: queueConn,
      defaultJobOptions,
    });
    this.dlq = new Queue(MAINTENANCE_DLQ, { connection: dlqConn });
    this.worker = new Worker(
      MAINTENANCE_QUEUE,
      this.opts.processor ?? smokeProcessor,
      { connection: workerConn },
    );

    // DLQ routing: only when retries are exhausted does a job go to its grave,
    // as a SANITIZED envelope. Earlier failures are just retries.
    this.worker.on('failed', (job, err) => {
      void this.routeToDlq(job, err);
    });

    this._enabled = true;
  }

  private async routeToDlq(job: Job | undefined, err: Error): Promise<void> {
    if (!job || !this.dlq) return;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return; // still has retries left
    const envelope: DeadLetterEnvelope = {
      sourceQueue: MAINTENANCE_QUEUE,
      jobId: job.id ?? null,
      jobName: job.name,
      attemptsMade: job.attemptsMade,
      failedAt: new Date().toISOString(),
      // NEVER job.data — see DeadLetterEnvelope. Reason is scrubbed+truncated.
      failedReason: sanitizeFailureReason(err?.message ?? String(err)),
    };
    await this.dlq.add(job.name, envelope, {
      removeOnComplete: false,
      removeOnFail: { count: 1000 },
    });
  }

  /**
   * Enqueue the no-op smoke job — MANUAL-ONLY, never scheduled. `jobId` is an
   * explicit idempotency key: enqueueing the same id twice while the first is
   * still pending dedupes to one job (BullMQ keeps the first), so an operator
   * retrying a smoke test cannot double-run it.
   */
  async enqueueSmoke(jobId = 'manual-smoke'): Promise<EnqueueResult> {
    if (this._closing) return { ok: false, reason: 'closing' };
    if (!this.queue) return { ok: false, reason: 'disabled' };
    const job = await this.queue.add(SMOKE_JOB, { ping: true }, { jobId });
    return { ok: true, jobId: job.id ?? jobId };
  }

  /** Access the DLQ (for admin/inspection). Null when disabled. */
  get deadLetterQueue(): Queue | null {
    return this.dlq;
  }

  get maintenanceQueue(): Queue | null {
    return this.queue;
  }

  /**
   * Graceful shutdown: refuse new work first, then let the worker finish its
   * active job (`Worker.close()` waits), then close queues and connections.
   */
  async close(): Promise<void> {
    this._closing = true;
    await this.worker?.close();
    await this.queue?.close();
    await this.dlq?.close();
    for (const c of this.connections) {
      try {
        c.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.worker = null;
    this.queue = null;
    this.dlq = null;
    this.connections = [];
    this._enabled = false;
    this._closing = false;
  }
}
