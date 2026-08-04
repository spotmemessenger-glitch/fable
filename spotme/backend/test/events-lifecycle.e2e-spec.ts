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
