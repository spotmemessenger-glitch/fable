/**
 * Wave 0 — Dragonfly (Redis-protocol) leg. IN-NETWORK ONLY (REDIS_URL targets
 * Railway's private network).
 *
 * Uses the app's OWN queue abstraction — `createRedisConnection` (the same
 * helper BullMQ uses in production) — to prove the runtime is reachable and a
 * job can be enqueued, processed, and acked end to end.
 *
 * NAMESPACING NOTE: the smoke runs on a dedicated `wave0` BullMQ queue rather
 * than the live `{maintenance}` queue, deliberately — enqueueing onto the real
 * maintenance queue in-network would contend with the app's running maintenance
 * worker and make "process→ack" non-deterministic. Same abstraction, same Redis
 * helper, wave0-namespaced job IDs, obliterated on cleanup. Nothing on the live
 * queue is touched.
 */

import { Queue, Worker } from 'bullmq';
import { createRedisConnection } from '../../queue/redis.connection';
import { LegResult, round2, timed } from './guard';

/** Pull a single non-secret field out of a Redis INFO blob. */
function infoField(info: string, key: string): string | null {
  const line = info.split('\n').find((l) => l.startsWith(`${key}:`));
  return line ? line.slice(key.length + 1).trim() : null;
}

export async function runRedisLeg(): Promise<LegResult> {
  const notes: string[] = [];
  const detail: Record<string, unknown> = {};

  const conn = createRedisConnection();
  if (!conn) {
    notes.push('REDIS_URL absent/empty — createRedisConnection returned null (queue disabled).');
    return { leg: 'redis', status: 'FAIL', detail, notes };
  }

  const queueName = 'wave0';
  let queue: Queue | null = null;
  let worker: Worker | null = null;
  try {
    // --- ping + identity ---
    const ping = await timed(() => conn.ping());
    detail.pingMs = round2(ping.ms);
    if (ping.error) {
      notes.push(`ping failed: ${ping.error}`);
      return { leg: 'redis', status: 'FAIL', detail, notes };
    }
    const info = await conn.info('server').catch(() => '');
    detail.runtime = {
      // Dragonfly reports df_version; a real Redis reports redis_version.
      dragonflyVersion: infoField(info, 'df_version'),
      redisVersion: infoField(info, 'redis_version'),
      mode: infoField(info, 'redis_mode'),
    };

    // --- enqueue -> process -> ack, end to end, on the real abstraction ---
    queue = new Queue(queueName, { connection: conn });
    // BullMQ wants a separate connection for the worker.
    worker = new Worker(queueName, async (job) => ({ echoed: job.data?.token }), {
      connection: createRedisConnection() ?? conn,
    });
    const w = worker;
    const done = new Promise<void>((resolve, reject) => {
      w.on('completed', () => resolve());
      w.on('failed', (_j, err) => reject(err ?? new Error('job failed')));
    });

    const token = `wave0-${Date.now().toString(36)}`;
    const roundTrip = await timed(async () => {
      await queue!.add(token, { token }, { jobId: token, removeOnComplete: true, removeOnFail: true });
      await done;
    });
    detail.jobId = token;
    detail.jobRoundTripMs = round2(roundTrip.ms);
    if (roundTrip.error) {
      notes.push(`job round-trip failed: ${roundTrip.error}`);
      return { leg: 'redis', status: 'FAIL', detail, notes };
    }
    notes.push(`enqueue→process→ack OK on wave0 queue (${detail.jobRoundTripMs} ms).`);
    return { leg: 'redis', status: 'PASS', detail, notes };
  } catch (e) {
    notes.push(`redis leg error: ${(e as Error).message}`);
    return { leg: 'redis', status: 'FAIL', detail, notes };
  } finally {
    // cleanup: remove all wave0 job data, then close everything.
    await worker?.close().catch(() => undefined);
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close().catch(() => undefined);
    await conn.quit().catch(() => undefined);
  }
}
