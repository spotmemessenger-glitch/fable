import IORedis from 'ioredis';
import { QueueEvents } from 'bullmq';
import {
  MaintenanceQueue,
  sanitizeFailureReason,
} from '../src/queue/maintenance.queue';
import { createRedisConnection } from '../src/queue/redis.connection';
import {
  MAINTENANCE_QUEUE,
  MAINTENANCE_DLQ,
  DEFAULT_JOB_OPTIONS,
} from '../src/queue/queue.constants';

// A LOCAL, throwaway address — not a secret, not the production Dragonfly URL.
// CI provides it via TEST_REDIS_URL pointing at the Valkey service container.
const TEST_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6380';

async function redisReachable(): Promise<boolean> {
  const c = new IORedis(TEST_URL, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    retryStrategy: () => null,
  });
  try {
    await c.connect();
    await c.ping();
    return true;
  } catch {
    return false;
  } finally {
    c.disconnect();
  }
}

const testConn = () =>
  createRedisConnection(TEST_URL, { retryStrategy: () => null });

describe('maintenance queue (BullMQ on ioredis)', () => {
  it('is DISABLED cleanly when no Redis runtime is configured — and says so', async () => {
    const q = new MaintenanceQueue({ connectionFactory: () => null });
    q.start();
    expect(q.enabled).toBe(false);
    // No silent loss: the refusal is an explicit, discriminated outcome.
    await expect(q.enqueueSmoke()).resolves.toEqual({ ok: false, reason: 'disabled' });
    await q.close(); // safe to close a disabled queue
  });

  it('retention bounds are explicit — completed and failed sets are both capped', () => {
    expect(DEFAULT_JOB_OPTIONS.removeOnComplete).toEqual({ count: 1000 });
    expect(DEFAULT_JOB_OPTIONS.removeOnFail).toEqual({ count: 5000 });
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(3);
  });

  it('sanitizeFailureReason scrubs credentialed URLs and truncates', () => {
    const leak = 'connect failed: rediss://default:s3cr3t@some-host.dfly.example:6385 refused';
    const clean = sanitizeFailureReason(leak);
    expect(clean).not.toContain('s3cr3t');
    expect(clean).not.toContain('dfly.example');
    expect(clean).toContain('[redacted-url]');
    const long = 'x'.repeat(1000);
    expect(sanitizeFailureReason(long).length).toBeLessThan(350);
    expect(sanitizeFailureReason(long)).toContain('[truncated]');
  });

  describe('against a live Redis-protocol server', () => {
    let available = false;

    beforeAll(async () => {
      available = await redisReachable();
      if (!available) {
        // Skip LOUDLY rather than passing vacuously.
        // eslint-disable-next-line no-console
        console.warn(
          `[queue.e2e] no Redis at ${TEST_URL} — live queue tests skipped`,
        );
      } else {
        const c = new IORedis(TEST_URL);
        await c.flushdb();
        c.disconnect();
      }
    });

    afterEach(async () => {
      if (!available) return;
      const c = new IORedis(TEST_URL);
      await c.flushdb();
      c.disconnect();
    });

    it('runs the manual smoke job through the enqueue → process → acknowledge loop', async () => {
      if (!available) return;
      const q = new MaintenanceQueue({ connectionFactory: testConn });
      q.start();
      expect(q.enabled).toBe(true);

      const events = new QueueEvents(MAINTENANCE_QUEUE, { connection: testConn()! });
      await events.waitUntilReady();

      const res = await q.enqueueSmoke('smoke-test-1');
      expect(res.ok).toBe(true);
      const id = res.ok ? res.jobId : '';

      const completed = await new Promise<{ jobId: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('smoke job timed out')), 15000);
        events.on('completed', (ev) => {
          if (ev.jobId === id) {
            clearTimeout(timer);
            resolve(ev as { jobId: string });
          }
        });
      });
      expect(completed.jobId).toBe(id);

      await events.close();
      await q.close();
    }, 20000);

    it('explicit job ids are idempotent — the same id cannot double-run', async () => {
      if (!available) return;
      const q = new MaintenanceQueue({ connectionFactory: testConn });
      q.start();

      const first = await q.enqueueSmoke('idempotency-key-1');
      const second = await q.enqueueSmoke('idempotency-key-1');
      expect(first).toEqual({ ok: true, jobId: 'idempotency-key-1' });
      expect(second).toEqual({ ok: true, jobId: 'idempotency-key-1' });

      // BullMQ dedupes on jobId: only ONE job exists for the key.
      const counts = await q.maintenanceQueue!.getJobCounts(
        'waiting', 'active', 'completed', 'failed', 'delayed',
      );
      const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
      expect(total).toBe(1);

      await q.close();
    }, 20000);

    it('exhausted retries land in the DLQ as a SANITIZED envelope — never the payload', async () => {
      if (!available) return;
      const SECRET = 'super-secret-payload-value-abc123';
      const q = new MaintenanceQueue({
        connectionFactory: testConn,
        // fast retries so the test is quick
        jobOptions: { attempts: 2, backoff: { type: 'exponential', delay: 10 } },
        processor: async () => {
          // The reason interpolates a credentialed URL — the envelope must scrub it.
          throw new Error('boom: rediss://user:hunter2@dragonfly.internal:6385 unreachable');
        },
      });
      q.start();

      // Enqueue with a secret-bearing payload directly on the underlying queue,
      // proving the DLQ never copies job.data no matter what a caller put there.
      await q.maintenanceQueue!.add('smoke', { token: SECRET, ping: true }, { jobId: 'dlq-test-1' });

      const dlq = q.deadLetterQueue!;
      let dead: unknown[] = [];
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        dead = await dlq.getJobs(['waiting', 'completed', 'failed'], 0, 5);
        if (dead.length >= 1) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(dead.length).toBeGreaterThanOrEqual(1);

      const envelope = (dead[0] as { data: Record<string, unknown> }).data;
      // The envelope carries triage context…
      expect(envelope.sourceQueue).toBe(MAINTENANCE_QUEUE);
      expect(envelope.jobId).toBe('dlq-test-1');
      expect(envelope.jobName).toBe('smoke');
      expect(envelope.attemptsMade).toBe(2);
      expect(typeof envelope.failedAt).toBe('string');
      // …the reason is scrubbed…
      expect(String(envelope.failedReason)).toContain('boom');
      expect(String(envelope.failedReason)).not.toContain('hunter2');
      expect(String(envelope.failedReason)).toContain('[redacted-url]');
      // …and the PAYLOAD IS NOT THERE. Not as `original`, not anywhere.
      const serialized = JSON.stringify(envelope);
      expect(serialized).not.toContain(SECRET);
      expect(envelope).not.toHaveProperty('original');

      // The full job (with payload) remains in BullMQ's own bounded failed set —
      // the forensic record lives in Redis, not in the triage index.
      const failed = await q.maintenanceQueue!.getJobs(['failed'], 0, 5);
      expect(failed.some((j) => j?.data?.token === SECRET)).toBe(true);

      await q.close();
    }, 20000);

    it('a closing queue refuses new work explicitly', async () => {
      if (!available) return;
      const q = new MaintenanceQueue({ connectionFactory: testConn });
      q.start();
      const closing = q.close();
      await expect(q.enqueueSmoke()).resolves.toEqual({ ok: false, reason: 'closing' });
      await closing;
      // After close completes the queue is disabled, still explicit.
      await expect(q.enqueueSmoke()).resolves.toEqual({ ok: false, reason: 'disabled' });
    }, 20000);

    it('uses the {maintenance} hash tag for Dragonfly thread-affinity', () => {
      // The tag is what co-locates every key of the queue on one slot/thread.
      expect(MAINTENANCE_QUEUE).toBe('{maintenance}');
      expect(MAINTENANCE_DLQ.startsWith('{maintenance}')).toBe(true);
    });
  });
});
