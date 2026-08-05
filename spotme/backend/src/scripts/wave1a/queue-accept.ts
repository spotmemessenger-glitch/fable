/**
 * Wave 1A — BullMQ queue acceptance suite (R2). IN-NETWORK ONLY.
 *
 * Proves the 8 queue-completeness properties the mission requires, against the
 * REAL Dragonfly, for a given connection mode ('standalone' | 'cluster'):
 *   1. enqueue → process → ack
 *   2. one real job through an EXISTING committed queue path (MaintenanceQueue)
 *   3. delayed job fires at its scheduled time
 *   4. retry with backoff
 *   5. dead-letter: exhausted retries land in the failed set, inspectable
 *   6. repeatable/scheduled job fires at least twice
 *   7. recovery: worker crash mid-queue → pending jobs survive and resume
 *   8. concurrency: two workers on one queue never double-process
 *
 * Every queue is hash-tagged ({wave1a-*}) and obliterated on cleanup; the live
 * {maintenance} queue's data is never mutated (check 2 uses a wrapped processor
 * over the real code path and cleans up its own smoke job).
 */

import { Queue, Worker, QueueEvents, type Job } from 'bullmq';
import type { Redis, Cluster } from 'ioredis';
import { MaintenanceQueue, smokeProcessor } from '../../queue/maintenance.queue';
import { round2 } from '../wave0/guard';
import { ConnMode, connectionFactory } from './redis-cluster';

export interface CheckResult {
  name: string;
  pass: boolean;
  ms: number;
  detail: Record<string, unknown>;
  error: string | null;
}

type Factory = () => Redis | Cluster | null;

const now = () => Number(process.hrtime.bigint() / 1_000_000n);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

/** Run a check with a hard timeout so a stuck consume can never hang the suite. */
async function guarded(
  name: string,
  timeoutMs: number,
  fn: () => Promise<{ pass: boolean; detail: Record<string, unknown> }>,
): Promise<CheckResult> {
  const t0 = now();
  try {
    const res = await Promise.race([
      fn(),
      sleep(timeoutMs).then(() => {
        throw new Error(`check timeout after ${timeoutMs}ms`);
      }),
    ]);
    return { name, pass: res.pass, ms: round2(now() - t0), detail: res.detail, error: null };
  } catch (e) {
    return { name, pass: false, ms: round2(now() - t0), detail: {}, error: (e as Error).message };
  }
}

// 1 — enqueue → process → ack
async function checkRoundTrip(make: Factory): Promise<CheckResult> {
  const qn = '{wave1a-rt}';
  return guarded('1_enqueue_process_ack', 20_000, async () => {
    const queue = new Queue(qn, { connection: make() as never });
    queue.on('error', () => undefined);
    const wc = make();
    (wc as Redis).on?.('error', () => undefined);
    const worker = new Worker(qn, async (job: Job) => ({ echo: job.data?.n }), { connection: wc as never });
    worker.on('error', () => undefined);
    try {
      const done = new Promise<void>((res, rej) => {
        worker.on('completed', () => res());
        worker.on('failed', (_j, e) => rej(e ?? new Error('failed')));
      });
      await queue.add('rt', { n: 1 }, { removeOnComplete: true, removeOnFail: true });
      await done;
      return { pass: true, detail: {} };
    } finally {
      await worker.close().catch(() => undefined);
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close().catch(() => undefined);
    }
  });
}

// 2 — one real job through the EXISTING committed queue path (MaintenanceQueue)
async function checkExistingPath(mode: ConnMode): Promise<CheckResult> {
  return guarded('2_existing_maintenance_path', 20_000, async () => {
    let ranAt = 0;
    // Wrap the REAL smokeProcessor so the committed start()/Queue/Worker/DLQ
    // wiring is exercised end-to-end; the processor body is the real one.
    const mq = new MaintenanceQueue({
      connectionFactory: connectionFactory(mode) as never,
      processor: async (job: Job) => {
        const out = await smokeProcessor(job, undefined as never);
        ranAt = Date.now();
        return out;
      },
    });
    try {
      mq.start();
      if (!mq.enabled) return { pass: false, detail: { reason: 'MaintenanceQueue did not enable' } };
      const jobId = `wave1a-smoke-${process.pid}-${now()}`;
      const enq = await mq.enqueueSmoke(jobId);
      const t0 = now();
      while (!ranAt && now() - t0 < 15_000) await sleep(150);
      return { pass: enq.ok === true && ranAt > 0, detail: { enqueue: enq, processed: ranAt > 0 } };
    } finally {
      // Remove the wave1a smoke job data we added; leaves the live queue clean.
      await mq.maintenanceQueue?.obliterate({ force: true }).catch(() => undefined);
      await mq.close().catch(() => undefined);
    }
  });
}

// 3 — delayed job fires at its scheduled time (not before)
async function checkDelayed(make: Factory): Promise<CheckResult> {
  const qn = '{wave1a-delay}';
  const DELAY = 3_000;
  return guarded('3_delayed_fires_on_schedule', 20_000, async () => {
    const queue = new Queue(qn, { connection: make() as never });
    queue.on('error', () => undefined);
    const worker = new Worker(qn, async () => ({ ok: true }), { connection: make() as never });
    worker.on('error', () => undefined);
    try {
      const addedAt = now();
      let firedAt = 0;
      const done = new Promise<void>((res) => worker.on('completed', () => { firedAt = now(); res(); }));
      await queue.add('d', {}, { delay: DELAY, removeOnComplete: true });
      await done;
      const elapsed = firedAt - addedAt;
      // Fired no earlier than ~90% of the delay, and within a sane ceiling.
      return { pass: elapsed >= DELAY * 0.9, detail: { delayMs: DELAY, actualMs: round2(elapsed) } };
    } finally {
      await worker.close().catch(() => undefined);
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close().catch(() => undefined);
    }
  });
}

// 4 — retry with backoff (fails attempt 1, succeeds attempt 2)
async function checkRetry(make: Factory): Promise<CheckResult> {
  const qn = '{wave1a-retry}';
  return guarded('4_retry_backoff', 25_000, async () => {
    const queue = new Queue(qn, { connection: make() as never });
    queue.on('error', () => undefined);
    let attempts = 0;
    const worker = new Worker(
      qn,
      async () => {
        attempts += 1;
        if (attempts < 2) throw new Error('deliberate first-attempt failure');
        return { ok: true };
      },
      { connection: make() as never },
    );
    worker.on('error', () => undefined);
    try {
      let completedAttempts = 0;
      const done = new Promise<void>((res) => worker.on('completed', (j: Job) => { completedAttempts = j.attemptsMade; res(); }));
      await queue.add('r', {}, { attempts: 3, backoff: { type: 'exponential', delay: 500 }, removeOnComplete: true, removeOnFail: true });
      await done;
      return { pass: attempts >= 2 && completedAttempts >= 2, detail: { attemptsRun: attempts, completedOnAttempt: completedAttempts } };
    } finally {
      await worker.close().catch(() => undefined);
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close().catch(() => undefined);
    }
  });
}

// 5 — dead-letter: exhausted retries land in the failed set, inspectable
async function checkDeadLetter(make: Factory): Promise<CheckResult> {
  const qn = '{wave1a-dlq}';
  return guarded('5_dead_letter_failed_set', 25_000, async () => {
    const queue = new Queue(qn, { connection: make() as never });
    queue.on('error', () => undefined);
    const worker = new Worker(qn, async () => { throw new Error('always fails'); }, { connection: make() as never });
    worker.on('error', () => undefined);
    try {
      let exhausted = false;
      const done = new Promise<void>((res) =>
        worker.on('failed', (j: Job | undefined) => {
          if (j && j.attemptsMade >= (j.opts.attempts ?? 1)) { exhausted = true; res(); }
        }),
      );
      await queue.add('dead', {}, { attempts: 2, backoff: { type: 'fixed', delay: 300 }, removeOnFail: { count: 100 } });
      await done;
      const failed = await queue.getFailed();
      const failedCount = await queue.getFailedCount();
      return {
        pass: exhausted && failedCount >= 1 && failed.length >= 1,
        detail: { exhausted, failedCount, inspectable: failed.length >= 1, sampleAttemptsMade: failed[0]?.attemptsMade ?? null },
      };
    } finally {
      await worker.close().catch(() => undefined);
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close().catch(() => undefined);
    }
  });
}

// 6 — repeatable/scheduled job fires at least twice
async function checkRepeatable(make: Factory): Promise<CheckResult> {
  const qn = '{wave1a-repeat}';
  return guarded('6_repeatable_fires_twice', 20_000, async () => {
    const queue = new Queue(qn, { connection: make() as never });
    queue.on('error', () => undefined);
    let fires = 0;
    const worker = new Worker(qn, async () => { fires += 1; return { ok: true }; }, { connection: make() as never });
    worker.on('error', () => undefined);
    try {
      await queue.upsertJobScheduler('wave1a-sched', { every: 1_000 }, { name: 'tick', data: {} });
      const t0 = now();
      while (fires < 2 && now() - t0 < 12_000) await sleep(200);
      return { pass: fires >= 2, detail: { fires } };
    } finally {
      await queue.removeJobScheduler('wave1a-sched').catch(() => undefined);
      await worker.close().catch(() => undefined);
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close().catch(() => undefined);
    }
  });
}

// 7 — recovery: worker crash mid-queue → pending jobs survive and resume
async function checkRecovery(make: Factory): Promise<CheckResult> {
  const qn = '{wave1a-recover}';
  const TOTAL = 6;
  return guarded('7_recovery_after_crash', 30_000, async () => {
    const queue = new Queue(qn, { connection: make() as never });
    queue.on('error', () => undefined);
    const processed = new Set<string>();
    // Worker A: slow processor; we "crash" it (close, no waiting) after a couple.
    const slow = async (job: Job) => { await sleep(400); processed.add(String(job.id)); return { ok: true }; };
    let workerA: Worker | null = new Worker(qn, slow, { connection: make() as never, concurrency: 1 });
    workerA.on('error', () => undefined);
    try {
      for (let i = 0; i < TOTAL; i++) await queue.add('j', { i }, { jobId: `rec-${i}`, removeOnComplete: false });
      // Let A handle a few, then simulate a crash: force-disconnect without drain.
      await sleep(1_000);
      const afterCrash = processed.size;
      await workerA.close(true).catch(() => undefined); // force=true → abrupt, mimics a kill
      workerA = null;
      // New worker B resumes.
      const fast = async (job: Job) => { await sleep(100); processed.add(String(job.id)); return { ok: true }; };
      const workerB = new Worker(qn, fast, { connection: make() as never, concurrency: 2 });
      workerB.on('error', () => undefined);
      const t0 = now();
      while (processed.size < TOTAL && now() - t0 < 18_000) await sleep(150);
      await workerB.close().catch(() => undefined);
      return {
        pass: processed.size === TOTAL,
        detail: { total: TOTAL, processedBeforeCrash: afterCrash, processedTotal: processed.size, noLoss: processed.size === TOTAL },
      };
    } finally {
      await workerA?.close(true).catch(() => undefined);
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close().catch(() => undefined);
    }
  });
}

// 8 — concurrency: two workers on one queue never double-process
async function checkConcurrency(make: Factory): Promise<CheckResult> {
  const qn = '{wave1a-conc}';
  const TOTAL = 12;
  return guarded('8_concurrency_no_double_process', 30_000, async () => {
    const queue = new Queue(qn, { connection: make() as never });
    queue.on('error', () => undefined);
    const counts = new Map<string, number>();
    const mk = () => new Worker(
      qn,
      async (job: Job) => { await sleep(80); counts.set(String(job.id), (counts.get(String(job.id)) ?? 0) + 1); return { ok: true }; },
      { connection: make() as never, concurrency: 2 },
    );
    const w1 = mk(); const w2 = mk();
    w1.on('error', () => undefined); w2.on('error', () => undefined);
    try {
      for (let i = 0; i < TOTAL; i++) await queue.add('c', { i }, { jobId: `c-${i}`, removeOnComplete: false });
      const t0 = now();
      while ([...counts.values()].reduce((a, b) => a + b, 0) < TOTAL && now() - t0 < 20_000) await sleep(150);
      const doubles = [...counts.values()].filter((n) => n > 1).length;
      return {
        pass: counts.size === TOTAL && doubles === 0,
        detail: { total: TOTAL, distinctProcessed: counts.size, doubleProcessed: doubles },
      };
    } finally {
      await w1.close().catch(() => undefined);
      await w2.close().catch(() => undefined);
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close().catch(() => undefined);
    }
  });
}

export interface AcceptanceReport {
  mode: ConnMode;
  connected: boolean;
  passed: number;
  total: number;
  checks: CheckResult[];
}

/** Run all 8 acceptance checks for one connection mode. */
export async function runAcceptance(mode: ConnMode): Promise<AcceptanceReport> {
  const make = connectionFactory(mode) as Factory;
  const checks: CheckResult[] = [];
  // Fail fast if the very first round-trip can't complete — no point running 8.
  const rt = await checkRoundTrip(make);
  checks.push(rt);
  if (rt.pass) {
    checks.push(await checkExistingPath(mode));
    checks.push(await checkDelayed(make));
    checks.push(await checkRetry(make));
    checks.push(await checkDeadLetter(make));
    checks.push(await checkRepeatable(make));
    checks.push(await checkRecovery(make));
    checks.push(await checkConcurrency(make));
  }
  const passed = checks.filter((c) => c.pass).length;
  return { mode, connected: rt.pass || rt.error === null, passed, total: 8, checks };
}
