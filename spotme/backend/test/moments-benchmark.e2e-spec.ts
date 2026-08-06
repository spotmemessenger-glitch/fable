/**
 * Phase 5E — Moments feed benchmark. OFF BY DEFAULT (loud skip). Run:
 *   RUN_MOMENTS_BENCH=1 BENCH_DATABASE_URL=postgresql://postgres@127.0.0.1:5433/moments_bench \
 *   npx jest test/moments-benchmark.e2e-spec.ts
 * A5-honest: records the largest achieved size and never extrapolates.
 * Measures the nearby-feed query (ST_DWithin + tier/block filters + keyset).
 */

import { PrismaClient } from '@prisma/client';
import { PrismaMomentsRepository } from '../src/moments/moments.prisma.repository';
import { PrismaService } from '../src/prisma/prisma.service';

const BENCH_DB = process.env.BENCH_DATABASE_URL;
const enabled = process.env.RUN_MOMENTS_BENCH === '1' && Boolean(BENCH_DB);
const bench = enabled ? describe : describe.skip;
if (!enabled) {
  // eslint-disable-next-line no-console
  console.warn('[moments-benchmark] SKIPPED — set RUN_MOMENTS_BENCH=1 and BENCH_DATABASE_URL to run.');
}

const nsNow = () => process.hrtime.bigint();
const ms = (a: bigint, b: bigint) => Number(b - a) / 1e6;
const pct = (s: number[], p: number) => { const x = [...s].sort((a, b) => a - b); return x[Math.min(x.length - 1, Math.ceil((p / 100) * x.length) - 1)]; };

jest.setTimeout(30 * 60_000);

bench('moments nearby-feed benchmark (Phase 5E)', () => {
  let prisma: PrismaClient;
  let repo: PrismaMomentsRepository;
  const report: Record<string, unknown> = { environment: { node: process.version }, byScale: {} };
  const origin = { lat: 12.972, lon: 77.595 };
  const VIEWER = 'bench-viewer';

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: BENCH_DB } } });
    repo = new PrismaMomentsRepository(prisma as unknown as PrismaService);
    await prisma.user.upsert({ where: { id: 'bench-author' }, update: {}, create: { id: 'bench-author', username: 'bench_author_mo' } });
    await prisma.user.upsert({ where: { id: VIEWER }, update: {}, create: { id: VIEWER, username: 'bench_viewer_mo' } });
  });
  afterAll(async () => {
    // eslint-disable-next-line no-console
    console.log('MOMENTS_BENCH_JSON ' + JSON.stringify(report));
    await prisma.$disconnect();
  });

  it('nearby feed p50/p95 across achievable scales', async () => {
    const SCALES = [1_000, 10_000, 100_000];
    let seeded = 0;
    const now = Date.now();
    for (const scale of SCALES) {
      while (seeded < scale) {
        const n = Math.min(5000, scale - seeded);
        const rows = Array.from({ length: n }, (_, k) => {
          const i = seeded + k;
          const lat = 12.972 + ((i % 200) - 100) * 0.001;
          const lon = 77.595 + ((Math.floor(i / 200)) % 200 - 100) * 0.001;
          return {
            id: `bm-${i}`, authorId: 'bench-author', kind: 'text', text: `post ${i}`, mediaIds: [] as string[],
            visibility: i % 4 === 0 ? 'public' : 'nearby',
            coarseLat: Math.round(lat * 1000) / 1000, coarseLon: Math.round(lon * 1000) / 1000,
            coarseCell: `g${lat.toFixed(3)}:${lon.toFixed(3)}`, cityCell: `c${(Math.round(lat * 10) / 10).toFixed(1)}:${(Math.round(lon * 10) / 10).toFixed(1)}`,
            createdAt: new Date(now - i * 1000), updatedAt: new Date(now - i * 1000),
          };
        });
        await prisma.moment.createMany({ data: rows, skipDuplicates: true });
        seeded += n;
      }
      // Bulk geog fill for the new rows.
      await prisma.$executeRawUnsafe(`UPDATE "Moment" SET "geog" = ST_SetSRID(ST_MakePoint("coarseLon", "coarseLat"), 4326)::geography WHERE "geog" IS NULL AND "id" LIKE 'bm-%'`);
      const samples: number[] = [];
      for (let r = 0; r < 40; r++) {
        const a = nsNow();
        await repo.feed({ viewerId: VIEWER, mode: 'nearby', origin, radiusKm: 25, limit: 25, cursor: null, now });
        samples.push(ms(a, nsNow()));
      }
      (report.byScale as Record<string, unknown>)[scale] = { p50: +pct(samples, 50).toFixed(2), p95: +pct(samples, 95).toFixed(2) };
    }
    (report as Record<string, unknown>).largestAchieved = seeded;
    expect(seeded).toBe(SCALES[SCALES.length - 1]);
  });
});
