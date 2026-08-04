/**
 * Phase 3E — Exchange performance benchmark. OFF BY DEFAULT (loud skip). Run:
 *   RUN_EXCHANGE_BENCH=1 BENCH_DATABASE_URL=postgresql://postgres@127.0.0.1:5433/spotme_bench \
 *   npx jest test/exchange-benchmark.e2e-spec.ts
 * A5-honest: records the largest achieved size and the reason if larger sizes
 * were not reached; never extrapolates. Measures the discoverable keyset query
 * (the production browse path) via the real repository.
 */

import { PrismaClient } from '@prisma/client';
import { PrismaExchangeIntentRepository } from '../src/exchange/exchange.prisma.repository';
import { PrismaService } from '../src/prisma/prisma.service';

const BENCH_DB = process.env.BENCH_DATABASE_URL;
const enabled = process.env.RUN_EXCHANGE_BENCH === '1' && Boolean(BENCH_DB);
const bench = enabled ? describe : describe.skip;
if (!enabled) {
  // eslint-disable-next-line no-console
  console.warn('[exchange-benchmark] SKIPPED — set RUN_EXCHANGE_BENCH=1 and BENCH_DATABASE_URL to run.');
}

const nsNow = () => process.hrtime.bigint();
const ms = (a: bigint, b: bigint) => Number(b - a) / 1e6;
const pct = (s: number[], p: number) => { const x = [...s].sort((a, b) => a - b); return x[Math.min(x.length - 1, Math.ceil((p / 100) * x.length) - 1)]; };

jest.setTimeout(30 * 60_000);

bench('exchange browse benchmark (Phase 3E)', () => {
  let prisma: PrismaClient;
  let repo: PrismaExchangeIntentRepository;
  const NOW = new Date();
  const PRINCIPAL = 'bench-principal';
  const report: Record<string, unknown> = { environment: {}, byScale: {} };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: BENCH_DB } } });
    repo = new PrismaExchangeIntentRepository(prisma as unknown as PrismaService);
    await prisma.user.upsert({ where: { id: PRINCIPAL }, update: {}, create: { id: PRINCIPAL, username: 'bench_principal_ex' } });
    await prisma.user.upsert({ where: { id: 'bench-owner' }, update: {}, create: { id: 'bench-owner', username: 'bench_owner_ex' } });
    report.environment = { node: process.version, cpus: require('node:os').cpus().length };
  });
  afterAll(async () => {
    // eslint-disable-next-line no-console
    console.log('EXCHANGE_BENCH_JSON ' + JSON.stringify(report));
    await prisma.$disconnect();
  });

  it('discoverable keyset query p50/p95 across achievable scales', async () => {
    const SCALES = [1_000, 10_000, 100_000];
    let seeded = 0, largest = 0;
    const byScale: Record<string, unknown> = {};
    for (const scale of SCALES) {
      try {
        for (let from = seeded + 1; from <= scale; from += 50_000) {
          const to = Math.min(scale, from + 50_000 - 1);
          await prisma.$executeRawUnsafe(`
            INSERT INTO "ExchangeIntent"
              ("id","ownerId","ownerKind","kind","status","category","title","text","tags",
               "coarseLat","coarseLon","coarseCell","radiusKm","maxRadiusKm","visibility",
               "moderationState","versionSeq","idempotencyKey","createdAt","updatedAt")
            SELECT 'bx-'||i,'bench-owner','user','offer','active','bench/cat','t'||i,'body',ARRAY['x'],
                   12.972, 77.595, 'g12.972:77.595', 5, 25, 'discoverable','clear',1,'bkey-'||i, NOW(), NOW()
            FROM generate_series(${from}, ${to}) i
            ON CONFLICT ("ownerId","idempotencyKey") DO NOTHING`);
        }
        await prisma.$executeRawUnsafe(`UPDATE "ExchangeIntent" SET "geog" = ST_SetSRID(ST_MakePoint("coarseLon","coarseLat"),4326)::geography WHERE "geog" IS NULL AND "ownerId"='bench-owner'`);
        await prisma.$executeRawUnsafe('ANALYZE "ExchangeIntent"');
        seeded = scale; largest = scale;
        for (let w = 0; w < 3; w++) await repo.findDiscoverable({ principalId: PRINCIPAL, kind: 'offer', category: 'bench/cat', limit: 30, cursor: null, now: NOW });
        const samples: number[] = [];
        for (let r = 0; r < 30; r++) {
          const t0 = nsNow();
          await repo.findDiscoverable({ principalId: PRINCIPAL, kind: 'offer', category: 'bench/cat', limit: 30, cursor: null, now: NOW });
          samples.push(ms(t0, nsNow()));
        }
        byScale[`scale_${scale}`] = { p50: +pct(samples, 50).toFixed(2), p95: +pct(samples, 95).toFixed(2), runs: 30 };
      } catch (e) {
        byScale[`scale_${scale}`] = { skipped: true, reason: (e as Error).message };
        break; // A5: record the reason, do not extrapolate
      }
    }
    report.byScale = byScale;
    report.largestAchieved = largest;
    expect(largest).toBeGreaterThan(0);
  });
});
