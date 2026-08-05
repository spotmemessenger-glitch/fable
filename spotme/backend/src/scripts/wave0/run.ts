/**
 * Wave 0 validation harness — entrypoint.
 *
 * Run locally (reachable legs only) via:
 *   railway run npx ts-node src/scripts/wave0/run.ts --legs=storage
 * Run in-network (all legs) from inside the deployed image:
 *   node dist/scripts/wave0/run.js --legs=all
 *
 * Refuses to run anywhere but the designated target (see guard.ts). Emits a
 * single JSON document to stdout: target descriptor, redacted endpoint
 * metadata, and one block per leg. NEVER prints a credential value.
 *
 * Exit code: 0 if no leg FAILED (BLOCKED/SKIPPED are not failures — a blocked
 * leg is an honest, reported outcome, e.g. PostGIS unavailable on the image);
 * 1 if any leg FAILED.
 */

import { assertDesignatedTarget, redactUrlMeta, LegResult, NotDesignatedTargetError } from './guard';
import { runStorageLeg } from './storage-leg';
import { runPostgresLeg } from './postgres-leg';
import { runRedisLeg } from './redis-leg';
import { runTypesenseLeg } from './typesense-leg';

type LegName = 'storage' | 'postgres' | 'redis' | 'typesense';
const ALL: LegName[] = ['postgres', 'redis', 'typesense', 'storage'];
const RUNNERS: Record<LegName, () => Promise<LegResult>> = {
  storage: runStorageLeg,
  postgres: runPostgresLeg,
  redis: runRedisLeg,
  typesense: runTypesenseLeg,
};

function selectedLegs(): LegName[] {
  const arg = process.argv.find((a) => a.startsWith('--legs='))?.split('=')[1] ?? 'all';
  if (arg === 'all') return ALL;
  return arg.split(',').map((s) => s.trim()).filter((s): s is LegName => (ALL as string[]).includes(s));
}

async function main(): Promise<void> {
  const report: Record<string, unknown> = { harness: 'wave0', at: new Date().toISOString() };
  try {
    report.target = assertDesignatedTarget();
  } catch (e) {
    if (e instanceof NotDesignatedTargetError) {
      report.refused = e.message;
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      process.exit(2);
    }
    throw e;
  }

  report.endpoints = ['DATABASE_URL', 'REDIS_URL', 'TYPESENSE_URL', 'S3_ENDPOINT'].map(redactUrlMeta);

  const legs = selectedLegs();
  const results: LegResult[] = [];
  for (const name of legs) {
    // Sequential: legs mutate shared infra and clean up after themselves; a
    // parallel run would interleave connections and muddy the latency numbers.
    results.push(await RUNNERS[name]());
  }
  report.legs = results;
  report.summary = results.map((r) => `${r.leg}=${r.status}`).join(' ');

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
}

void main();
