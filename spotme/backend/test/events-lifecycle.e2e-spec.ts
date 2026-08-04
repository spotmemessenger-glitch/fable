/**
 * Phase 4B — Events ingest + browse against REAL PostGIS.
 *
 * Proves on the live database: fixture-provider ingest → normalize/dedup/persist,
 * geography written from the coarse venue, browse with ST_DWithin + keyset +
 * coarse distance band, dedup decisions persisted, retention sweep, and the
 * honest `unavailable` when no provider is configured. No production provider.
 */

import { PrismaClient } from '@prisma/client';
import { PrismaEventsRepository } from '../src/events/events.prisma.repository';
import { PrismaService } from '../src/prisma/prisma.service';
import { EventsService } from '../src/events/events.service';
import { FixtureEventProvider } from '../src/events/events.provider';
import type { EventProviderCandidate } from '../src/events/events.types';

const prisma = new PrismaClient();
const svcPrisma = prisma as unknown as PrismaService;
const RUN = `ev${Date.now().toString(36)}`;

const cand = (over: Partial<EventProviderCandidate> = {}): EventProviderCandidate => ({
  providerEventId: `${RUN}-${Math.random().toString(36).slice(2)}`,
  title: 'Rooftop set', lat: 12.9716, lon: 77.5946, category: 'music',
  startUTC: Date.now() + 3_600_000, endUTC: Date.now() + 7_200_000, timezone: 'Asia/Kolkata',
  source: 'Acme', confidence: 0.9, ...over,
});

const service = (provs: FixtureEventProvider[]) =>
  new EventsService(new PrismaEventsRepository(svcPrisma), provs);

describe('events lifecycle (real PostGIS)', () => {
  const origin = { lat: 12.9716, lon: 77.5946 };
  const ids: string[] = [];

  afterAll(async () => {
    await prisma.eventDedupDecision.deleteMany({ where: { canonicalId: { startsWith: 'fixture:' + RUN } } }).catch(() => {});
    await prisma.eventSearchProjection.deleteMany({ where: { id: { startsWith: 'fixture:' + RUN } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { providerEventId: { startsWith: RUN } } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('ingest writes the geography from the coarse venue and persists a projection', async () => {
    const c = cand();
    const svc = service([new FixtureEventProvider([c])]);
    const summary = await svc.ingestNearby({ origin }, { now: Date.now() });
    expect(summary.state).toBe('ok');
    expect(summary.written).toBe(1);
    const id = `fixture:${c.providerEventId}`;
    ids.push(id);
    const geo = await prisma.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT ("geog" IS NOT NULL) AS ok FROM "Event" WHERE id = $1`, id);
    expect(geo[0].ok).toBe(true);
    const proj = await prisma.eventSearchProjection.findUnique({ where: { id } });
    expect(proj).not.toBeNull();
    // The stored venue is coarse, never the precise input.
    const row = await prisma.event.findUnique({ where: { id }, select: { coarseLat: true, coarseLon: true } });
    expect(row!.coarseLat).toBe(12.972);
    expect(row!.coarseLon).toBe(77.595);
  });

  it('no provider configured → honest `unavailable`, nothing written', async () => {
    const svc = service([]);
    const summary = await svc.ingestNearby({ origin }, { now: Date.now() });
    expect(summary.state).toBe('unavailable');
    expect(summary.written).toBe(0);
  });

  it('browse returns nearby canonical events with a coarse distance band and a signed cursor', async () => {
    const near = cand({ lat: 12.9716, lon: 77.5946, providerEventId: `${RUN}-near` });
    const svc = service([new FixtureEventProvider([near])]);
    await svc.ingestNearby({ origin }, { now: Date.now() });
    const page = await svc.browse({ origin, radiusKm: 25, category: 'music' }, Date.now());
    expect(page.state).toBe('ok');
    const hit = page.results.find((r) => r.id === `fixture:${RUN}-near`);
    expect(hit).toBeTruthy();
    expect(hit!.distanceBand).toBe('under500m'); // same coarse cell as origin
    // No origin field leaks onto a row.
    expect(JSON.stringify(page.results)).not.toMatch(/originLat|userLat/i);
  });

  it('a far event outside the radius is excluded in SQL', async () => {
    const far = cand({ lat: 40.0, lon: -70.0, providerEventId: `${RUN}-far`, category: 'sports' });
    const svc = service([new FixtureEventProvider([far])]);
    await svc.ingestNearby({ origin }, { now: Date.now() });
    const page = await svc.browse({ origin, radiusKm: 10, category: 'sports' }, Date.now());
    expect(page.results.map((r) => r.id)).not.toContain(`fixture:${RUN}-far`);
  });

  it('cross-provider duplicates fold to one canonical, with an explainable decision persisted', async () => {
    const t = Date.now() + 3_600_000;
    const a = cand({ providerEventId: `${RUN}-dupA`, title: 'Same Night', startUTC: t, endUTC: t + 3_600_000, confidence: 0.9 });
    const b = { ...cand({ providerEventId: `${RUN}-dupB`, title: 'same  night', startUTC: t, endUTC: t + 3_600_000, confidence: 0.4 }) };
    const svc = service([new FixtureEventProvider([a], 'p1'), new FixtureEventProvider([b], 'p2')]);
    const summary = await svc.ingestNearby({ origin, category: 'music' }, { now: Date.now() });
    expect(summary.canonical).toBe(1); // one survived
    const decision = await prisma.eventDedupDecision.findUnique({ where: { mergedId: `p2:${RUN}-dupB` } });
    expect(decision).toMatchObject({ canonicalId: `p1:${RUN}-dupA`, basis: 'cross-provider-match', titleMatch: true, venueMatch: true, timeOverlap: true, areaMatch: true });
    // The folded row never surfaces on browse.
    const page = await svc.browse({ origin, radiusKm: 25, category: 'music' }, Date.now());
    expect(page.results.map((r) => r.id)).not.toContain(`p2:${RUN}-dupB`);
  });

  it('an already-expired event is pruned at ingest and never stored', async () => {
    const past = cand({ providerEventId: `${RUN}-old`, category: 'film', startUTC: 1000, endUTC: 2000 });
    const svc = service([new FixtureEventProvider([past])]);
    const summary = await svc.ingestNearby({ origin, category: 'film' }, { now: Date.now() });
    expect(summary.written).toBe(0); // pruned before persistence
    expect(await prisma.event.findUnique({ where: { id: `fixture:${RUN}-old` } })).toBeNull();
  });

  it('keyset pagination reaches NULL-start (tbd/postponed) events across page boundaries (KEYSET-NULL)', async () => {
    const now = Date.now();
    // Two dated + two NULL-start (postponed) events in the same coarse area.
    // Distinct titles so none dedup-merge — this test is about pagination.
    const cands = [
      cand({ providerEventId: `${RUN}-pg-d1`, title: 'Dated One', category: 'education', startUTC: now + 3_600_000, endUTC: now + 7_200_000 }),
      cand({ providerEventId: `${RUN}-pg-d2`, title: 'Dated Two', category: 'education', startUTC: now + 1_800_000, endUTC: now + 5_400_000 }),
      cand({ providerEventId: `${RUN}-pg-n1`, title: 'Tbd One', category: 'education', lifecycle: 'postponed', startUTC: undefined, endUTC: undefined }),
      cand({ providerEventId: `${RUN}-pg-n2`, title: 'Tbd Two', category: 'education', lifecycle: 'postponed', startUTC: undefined, endUTC: undefined }),
    ];
    const svc = service([new FixtureEventProvider(cands)]);
    await svc.ingestNearby({ origin, category: 'education' }, { now });
    // Page with limit 1 so a boundary falls between a dated and a NULL-start row.
    const repo = new PrismaEventsRepository(svcPrisma);
    const seen = new Set<string>();
    let cursor: string | null = null;
    const { decodeCursor } = await import('../src/events/events.cursor');
    for (let p = 0; p < 20; p++) {
      const rows = await repo.findNearby({ origin, radiusKm: 25, category: 'education', now, limit: 1, cursor: cursor ? decodeCursor(cursor) : null });
      if (rows.length === 0) break;
      for (const r of rows) { expect(seen.has(r.id)).toBe(false); seen.add(r.id); }
      // Rebuild the signed cursor exactly as the service does.
      const { encodeCursor } = await import('../src/events/events.cursor');
      const last = rows[rows.length - 1];
      cursor = encodeCursor({ t: last.startUTC ?? 0, i: last.id, depth: p + 1 });
    }
    // All four — including both NULL-start events — are reachable.
    for (const c of cands) expect(seen.has(`fixture:${c.providerEventId}`)).toBe(true);
  });

  it('retention sweep deletes a stored event once its retention window passes', async () => {
    const now = Date.now();
    // A just-ended event is within retention → stored with a future expiresAt.
    const recent = cand({ providerEventId: `${RUN}-recent`, category: 'theatre', startUTC: now - 2000, endUTC: now - 1000 });
    const svc = service([new FixtureEventProvider([recent])]);
    await svc.ingestNearby({ origin, category: 'theatre' }, { now });
    const id = `fixture:${RUN}-recent`;
    const stored = await prisma.event.findUnique({ where: { id }, select: { expiresAt: true } });
    expect(stored!.expiresAt!.getTime()).toBeGreaterThan(now); // not yet expired
    // A sweep at `now` removes nothing; a sweep past the expiry removes it.
    expect(await new PrismaEventsRepository(svcPrisma).sweepExpired(now)).toBe(0);
    const removed = await new PrismaEventsRepository(svcPrisma).sweepExpired(stored!.expiresAt!.getTime() + 1);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await prisma.event.findUnique({ where: { id } })).toBeNull();
  });
});
