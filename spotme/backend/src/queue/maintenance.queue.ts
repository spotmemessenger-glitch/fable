import { Queue, Worker, type Job, type Processor, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { createRedisConnection } from './redis.connection';
import {
  MAINTENANCE_QUEUE,
  MAINTENANCE_DLQ,
  HEARTBEAT_JOB,
  DEFAULT_JOB_OPTIONS,
} from './queue.constants';

/** Result of a heartbeat job — a no-op that proves the loop works. */
export interface HeartbeatResult {
  ok: true;
  ranAt: number;
}

/** The default processor: a no-op heartbeat. Real jobs are added later. */
export const heartbeatProcessor: Processor = async (job: Job) => {
  if (job.name === HEARTBEAT_JOB) {
    return { ok: true, ranAt: Date.now() } satisfies HeartbeatResult;
  }
  // Unknown job names are a programming error; fail loudly so they retry then
  // land in the DLQ rather than being silently dropped.
  throw new Error(`unknown maintenance job: ${job.name}`);
};

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
 * `start()` is a no-op, `enqueueHeartbeat()` returns null, `enabled` is false.
 *
 * Additive and dark: nothing in the request path constructs or depends on this.
 */
export class MaintenanceQueue {
  private queue: Queue | null = null;
  private dlq: Queue | null = null;
  private worker: Worker | null = null;
  private connections: Redis[] = [];
  private _enabled = false;

  constructor(private readonly opts: MaintenanceQueueOptions = {}) {}

  get enabled(): boolean {
    return this._enabled;
  }

  private makeConnection(): Redis | null {
    return (this.opts.connectionFactory ?? createRedisConnection)();
  }

  /** Idempotent. Starts the queue/worker if a Redis runtime is configured. */
  start(): void {
    if (this._enabled) return;
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
      this.opts.processor ?? heartbeatProcessor,
      { connection: workerConn },
    );

    // DLQ routing: only when retries are exhausted does a job go to its grave,
    // with enough context to triage it. Earlier failures are just retries.
    this.worker.on('failed', (job, err) => {
      void this.routeToDlq(job, err);
    });

    this._enabled = true;
  }

  private async routeToDlq(job: Job | undefined, err: Error): Promise<void> {
    if (!job || !this.dlq) return;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return; // still has retries left
    await this.dlq.add(
      job.name,
      {
        original: job.data,
        failedReason: err?.message ?? String(err),
        attemptsMade: job.attemptsMade,
        sourceQueue: MAINTENANCE_QUEUE,
      },
      { removeOnComplete: false, removeOnFail: false },
    );
  }

  /** Enqueue the no-op heartbeat. Returns the job id, or null when disabled. */
  async enqueueHeartbeat(): Promise<string | null> {
    if (!this.queue) return null;
    const job = await this.queue.add(HEARTBEAT_JOB, { ping: true });
    return job.id ?? null;
  }

  /** Access the DLQ (for admin/inspection). Null when disabled. */
  get deadLetterQueue(): Queue | null {
    return this.dlq;
  }

  get maintenanceQueue(): Queue | null {
    return this.queue;
  }

  /** Graceful shutdown: close worker, queues, and every connection. */
  async close(): Promise<void> {
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
  }
}
