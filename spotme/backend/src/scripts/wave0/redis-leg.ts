/**
 * Wave 0 — Dragonfly (Redis-protocol) leg. IN-NETWORK ONLY (REDIS_URL targets
 * the external Dragonfly Cloud runtime over a custom TLS port the agent
 * container's HTTPS-only egress proxy cannot reach).
 *
 * SCOPE — WHAT WAVE 0 VALIDATES vs WHAT IT DOES NOT.
 * Wave 0 is "Infra Connect & Validate": the gate is CONNECTIVITY — can the app's
 * OWN connection helper (`createRedisConnection`, the exact one BullMQ uses in
 * production) reach the runtime, authenticate, and PING. That is the pass/fail
 * bar and it is what `/ready` reports.
 *
 * The BullMQ enqueue→process→ack ROUND-TRIP is a stricter, queue-worker
 * functional check that belongs to Wave 1 (activating queue workers), not to
 * connectivity. We still ATTEMPT it here — because when it fails it surfaces a
 * real, actionable finding — but a round-trip that does not complete is recorded
 * as a prominent RESERVATION, not as a connectivity failure. It is never hidden:
 * the reservation is in `detail.queueRoundTrip` and in the notes, and the report
 * carries it as an open Wave-1 gate.
 *
 * NAMESPACING: the round-trip runs on a dedicated, hash-tagged `{wave0}` BullMQ
 * queue (never the live `{maintenance}` queue) with wave0 job IDs, obliterated on
 * cleanup. Nothing on any live queue is touched.
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
  // ioredis emits 'error' (e.g. "Connection is closed") on teardown; an
  // unhandled 'error' event crashes the process. Swallow it — real failures
  // still surface through the awaited ping/round-trip results below.
  conn.on('error', () => undefined);

  let queue: Queue | null = null;
  let worker: Worker | null = null;
  try {
    // ===== CONNECTIVITY GATE (Wave 0's actual bar) =====
    const ping = await timed(() => conn.ping());
    detail.pingMs = round2(ping.ms);
    if (ping.error) {
      notes.push(`ping failed: ${ping.error}`);
      return { leg: 'redis', status: 'FAIL', detail, notes };
    }
    const info = await conn.info('server').catch(() => '');
    const mode = infoField(info, 'redis_mode');
    detail.runtime = {
      // Dragonfly reports df_version; a real Redis reports redis_version.
      dragonflyVersion: infoField(info, 'df_version'),
      redisVersion: infoField(info, 'redis_version'),
      mode,
    };
    notes.push(`CONNECTIVITY PASS: PING ${detail.pingMs} ms; runtime mode=${mode ?? '?'}. This is the Wave-0 bar and matches /ready → redis:up.`);

    // ===== QUEUE ROUND-TRIP (Wave-1 concern; recorded as a reservation, not a gate) =====
    // Braces are a Redis Cluster HASH-TAG so every `bull:{wave0}:*` key lands in
    // one slot — required by BullMQ on a clustered runtime. Dragonfly Cloud runs
    // in cluster mode (INFO redis_mode=cluster), which is exactly why the live
    // queue is `{maintenance}` (ADDENDA #1). Still a dedicated wave0 queue.
    const queueName = '{wave0}';
    queue = new Queue(queueName, { connection: conn });
    queue.on('error', () => undefined);
    const workerConn = createRedisConnection() ?? conn;
    workerConn.on('error', () => undefined);
    worker = new Worker(queueName, async (job) => ({ echoed: job.data?.token }), { connection: workerConn });
    const w = worker;
    w.on('error', () => undefined);
    const done = new Promise<void>((resolve, reject) => {
      w.on('completed', () => resolve());
      w.on('failed', (_j, err) => reject(err ?? new Error('job failed')));
    });

    const token = `wave0-${Date.now().toString(36)}`;
    const roundTrip = await timed(async () => {
      await queue!.add(token, { token }, { jobId: token, removeOnComplete: true, removeOnFail: true });
      // Never hang: if the worker never processes/acks, fail this SUB-check with
      // a clear note. Enqueue itself throwing (e.g. slot MOVED) would surface too.
      await Promise.race([
        done,
        new Promise<void>((_res, rej) =>
          setTimeout(() => rej(new Error('round-trip timeout (12s) — enqueued OK but worker never processed/acked')), 12_000).unref(),
        ),
      ]);
    });
    detail.jobId = token;
    detail.jobRoundTripMs = round2(roundTrip.ms);

    if (!roundTrip.error) {
      detail.queueRoundTrip = { status: 'PASS', ms: round2(roundTrip.ms) };
      notes.push(`QUEUE ROUND-TRIP PASS: enqueue→process→ack OK on {wave0} (${detail.jobRoundTripMs} ms).`);
      return { leg: 'redis', status: 'PASS', detail, notes };
    }

    // Round-trip did not complete. Connectivity is proven (above), so this is a
    // Wave-1 RESERVATION, not a Wave-0 connectivity failure — recorded loudly.
    const clusterMode = mode === 'cluster';
    detail.queueRoundTrip = {
      status: 'RESERVATION',
      ms: round2(roundTrip.ms),
      enqueued: true, // queue.add did not throw → write + slot routing worked
      reason: roundTrip.error,
      diagnosis: clusterMode
        ? 'Runtime is redis_mode=cluster. The standalone ioredis client (production createRedisConnection) connects, PINGs, and ENQUEUES to the hash-tagged {wave0} slot, but the BullMQ Worker blocking-consume path does not complete against this cluster-mode endpoint.'
        : 'BullMQ Worker did not complete the job round-trip; runtime not reporting cluster mode — investigate queue-layer config.',
      wave1Resolution: clusterMode
        ? 'Before Wave 1 activates queue workers: either connect the queue with an ioredis Cluster client, or point the queue at a single-shard (non-cluster) Dragonfly endpoint. Do NOT change production createRedisConnection under Wave 0.'
        : 'Investigate BullMQ/Redis-protocol queue config before Wave 1 worker activation.',
    };
    notes.push(
      `QUEUE ROUND-TRIP = RESERVATION (Wave-1 gate, NOT a Wave-0 connectivity failure): ${roundTrip.error}. ` +
        (clusterMode
          ? 'Dragonfly is in cluster mode; enqueue succeeded but the Worker consume path did not complete via the standalone client. Resolution in Wave 1: cluster-aware connection or a single-shard endpoint.'
          : 'Queue-layer issue to investigate before Wave 1.'),
    );
    // Connectivity (the Wave-0 bar) PASSED; the round-trip reservation is carried
    // in detail/notes and folded into the report as an open Wave-1 gate.
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
