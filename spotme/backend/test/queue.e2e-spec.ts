import IORedis from 'ioredis';
import { QueueEvents } from 'bullmq';
import { MaintenanceQueue } from '../src/queue/maintenance.queue';
import { createRedisConnection } from '../src/queue/redis.connection';
import {
  MAINTENANCE_QUEUE,
  MAINTENANCE_DLQ,
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
  it('is DISABLED cleanly when no Redis runtime is configured', async () => {
    const q = new MaintenanceQueue({ connectionFactory: () => null });
    q.start();
    expect(q.enabled).toBe(false);
    expect(await q.enqueueHeartbeat()).toBeNull();
    await q.close(); // safe to close a disabled queue
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

    it('runs a heartbeat job through the enqueue → process loop', async () => {
      if (!available) return;
      const q = new MaintenanceQueue({ connectionFactory: testConn });
      q.start();
      expect(q.enabled).toBe(true);

      const events = new QueueEvents(MAINTENANCE_QUEUE, { connection: testConn()! });
      await events.waitUntilReady();

      const id = await q.enqueueHeartbeat();
      expect(id).toBeTruthy();

      const completed = await new Promise<{ jobId: string; returnvalue: string }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('heartbeat timed out')), 15000);
          events.on('completed', (ev) => {
            if (ev.jobId === id) {
              clearTimeout(timer);
              resolve(ev as { jobId: string; returnvalue: string });
            }
          });
        },
      );
      expect(completed.jobId).toBe(id);

      await events.close();
      await q.close();
    }, 20000);

    it('exhausts retries and routes the job to the DLQ', async () => {
      if (!available) return;
      const q = new MaintenanceQueue({
        connectionFactory: testConn,
        // fast retries so the test is quick
        jobOptions: { attempts: 2, backoff: { type: 'exponential', delay: 10 } },
        processor: async () => {
          throw new Error('boom — always fails');
        },
      });
      q.start();

      await q.enqueueHeartbeat();

      // Poll the DLQ until the exhausted job lands, or time out.
      const dlq = q.deadLetterQueue!;
      let deadCount = 0;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const counts = await dlq.getJobCounts('waiting', 'completed', 'failed');
        deadCount =
          (counts.waiting ?? 0) + (counts.completed ?? 0) + (counts.failed ?? 0);
        if (deadCount >= 1) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(deadCount).toBeGreaterThanOrEqual(1);

      // The dead letter carries triage context.
      const [dead] = await dlq.getJobs(['waiting', 'completed', 'failed'], 0, 5);
      expect(dead?.data?.sourceQueue).toBe(MAINTENANCE_QUEUE);
      expect(dead?.data?.failedReason).toContain('boom');
      expect(dead?.data?.attemptsMade).toBe(2);

      await q.close();
    }, 20000);

    it('uses the {maintenance} hash tag for Dragonfly thread-affinity', () => {
      // The tag is what co-locates every key of the queue on one slot/thread.
      expect(MAINTENANCE_QUEUE).toBe('{maintenance}');
      expect(MAINTENANCE_DLQ.startsWith('{maintenance}')).toBe(true);
    });
  });
});
