/**
 * Phase 4D — Events performance benchmark. OFF BY DEFAULT (loud skip). Run:
 *   RUN_EVENTS_BENCH=1 BENCH_DATABASE_URL=postgresql://postgres@127.0.0.1:5433/events_bench \
 *   npx jest test/events-benchmark.e2e-spec.ts
 * A5-honest: records the largest achieved size and never extrapolates. Measures
 * the nearby browse query (ST_DWithin + keyset) — the production browse path.
 */

import { PrismaClient } from '@prisma/client';
import { PrismaEventsRepository } from '../src/events/events.prisma.repository';
import { PrismaService } from '../src/prisma/prisma.service';
import type { StatedEvent } from '../src/events/events.types';

const BENCH_DB = process.env.BENCH_DATABASE_URL;
const enabled = process.env.RUN_EVENTS_BENCH === '1' && Boolean(BENCH_DB);
const bench = enabled ? describe : describe.skip;
if (!enabled) {
  // eslint-disable-next-line no-console
  console.warn('[events-benchmark] SKIPPED — set RUN_EVENTS_BENCH=1 and BENCH_DATABASE_URL to run.');
}

const nsNow = () => process.hrtime.bigint();
const ms = (a: bigint, b: bigint) => Number(b - a) / 1e6;
const pct = (s: number[], p: number) => { const x = [...s].sort((a, b) => a - b); return x[Math.min(x.length - 1, Math.ceil((p / 100) * x.length) - 1)]; };

jest.setTimeout(30 * 60_000);

bench('events browse benchmark (Phase 4D)', () => {
  let prisma: PrismaClient;
  let repo: PrismaEventsRepository;
  const report: Record<string, unknown> = { environment: {}, byScale: {} };
  const origin = { lat: 12.972, lon: 77.595 };

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: BENCH_DB } } });
    repo = new PrismaEventsRepository(prisma as unknown as PrismaService);
    report.environment = { node: process.version, cpus: require('node:os').cpus().length };
  });
  afterAll(async () => {
    // eslint-disable-next-line no-console
    console.log('EVENTS_BENCH_JSON ' + JSON.stringify(report));
    await prisma.$disconnect();
  });

  it('nearby browse p50/p95 across achievable scales', async () => {
    const SCALES = [1_000, 10_000, 50_000];
    let seeded = 0;
    const now = Date.now();
    const mk = (i: number): StatedEvent => {
      const jitterLat = 12.972 + ((i % 200) - 100) * 0.001;
      const jitterLon = 77.595 + ((Math.floor(i / 200)) % 200 - 100) * 0.001;
      return {
        id: `bench:${i}`, category: (['music', 'sports', 'arts', 'food'] as const)[i % 4],
        title: `Event ${i}`, description: null, startUTC: now + (i % 1000) * 60_000, endUTC: now + (i % 1000) * 60_000 + 3_600_000,
        timezone: 'Asia/Kolkata', allDay: false, occurrenceId: null, lifecycle: 'scheduled',
        coarseLat: Math.round(jitterLat * 1000) / 1000, coarseLon: Math.round(jitterLon * 1000) / 1000,
        coarseCell: `g${jitterLat.toFixed(3)}:${jitterLon.toFixed(3)}`, popularity: null,
        source: { provider: 'bench', providerEventId: String(i), providerSourceId: null, organizerRef: null, sourceName: null, url: null, revisionUTC: null, confidence: null, provenance: null },
        fetchedAtUTC: now, restricted: false, unsafe: false, state: 'upcoming',
      };
    };

    for (const scale of SCALES) {
      while (seeded < scale) {
        const batch: StatedEvent[] = [];
        for (let i = seeded; i < Math.min(seeded + 2000, scale); i++) batch.push(mk(i));
        await repo.upsertBatch(batch, [], now);
        seeded += batch.length;
      }
      const samples: number[] = [];
      for (let r = 0; r < 40; r++) {
        const a = nsNow();
        await repo.findNearby({ origin, radiusKm: 25, category: 'music', now, limit: 25, cursor: null });
        samples.push(ms(a, nsNow()));
      }
      (report.byScale as Record<string, unknown>)[scale] = { p50: +pct(samples, 50).toFixed(2), p95: +pct(samples, 95).toFixed(2) };
    }
    (report as Record<string, unknown>).largestAchieved = seeded;
    expect(seeded).toBe(SCALES[SCALES.length - 1]);
  });
});
