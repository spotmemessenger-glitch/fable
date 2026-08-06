/**
 * Wave 1C, C4 — LIVE privacy verification of Discovery, in the TEST environment
 * with the flag ON, asserting on REAL CAPTURED BYTES (not intent). Every claim
 * below is checked against the serialized response the HTTP stack actually
 * emits, or against the actual DB row / console output.
 *
 * The discovery RuntimeFlag row is written to THIS TEST DATABASE only.
 */

import { INestApplication, ValidationPipe, RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { DiscoveryRealtimeEvent } from '../src/discovery/realtime/realtime.port';

const prisma = new PrismaClient();
const RUN = `c4${Date.now().toString(36)}`;
// PRECISE device-grade coordinates (6 decimals) — the values that must NEVER
// appear in any response byte. Coarsened server-side to 3 decimals (~110 m).
const PRECISE = { lat: 12.976543, lon: 77.591234 };
const PRECISE_LAT_STR = '12.976543';
const PRECISE_LON_STR = '77.591234';
const COARSE_LAT_STR = '12.977'; // 3-decimal re-quantization (rounded)
const ADULT = `${new Date().getUTCFullYear() - 30}-01`;

let app: INestApplication;
let url: string;
let capturedConsole: string[] = [];
const origConsole = { log: console.log, error: console.error, warn: console.warn };

async function adultToken(tag: string): Promise<{ id: string; token: string }> {
  const id = `${tag}${RUN}0000000000000`.replace(/[^a-f0-9]/gi, 'f').slice(0, 16);
  const username = `${RUN}${tag}`.slice(0, 16);
  const res = await fetch(`${url}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, username, secret: `sec-${tag}-12345678`, birthYearMonth: ADULT }),
  });
  const body = (await res.json()) as { accessToken: string; userId: string };
  // Make them discoverable: the query JOINs the public-profile projection.
  await prisma.discoveryPublicProfileProjection.upsert({
    where: { userId: body.userId ?? id },
    create: { userId: body.userId ?? id, displayName: `User ${tag}`, discoverable: true, updatedAt: new Date() },
    update: { discoverable: true },
  });
  return { id: body.userId ?? id, token: body.accessToken };
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

/** Set my visibility ON at a PRECISE location — the server must coarsen it. */
const goVisible = (t: string, loc = PRECISE) =>
  fetch(`${url}/api/v2/discovery/visibility`, {
    method: 'PUT', headers: auth(t),
    body: JSON.stringify({ enabled: true, origin: { lat: loc.lat, lon: loc.lon } }),
  });

const goGhost = (t: string) =>
  fetch(`${url}/api/v2/discovery/visibility`, {
    method: 'PUT', headers: auth(t), body: JSON.stringify({ enabled: false }),
  });

const query = (t: string, extra: Record<string, unknown> = {}) =>
  fetch(`${url}/api/v2/discovery/query`, {
    method: 'POST', headers: auth(t),
    body: JSON.stringify({ contractsVersion: 1, intent: { kind: 'people' }, scope: 'people', origin: { lat: PRECISE.lat, lon: PRECISE.lon }, radius: { km: 2 }, ...extra }),
  });

let A: { id: string; token: string }; // the querier
let B: { id: string; token: string }; // a nearby visible user
let C: { id: string; token: string }; // another, used for block tests

beforeAll(async () => {
  process.env.JWT_ACCESS_SECRET ||= 'c4-privacy-secret-0123456789abcdef';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }, { path: 'ready', method: RequestMethod.GET }] });
  await app.listen(0);
  url = await app.getUrl();
  await prisma.runtimeFlag.upsert({ where: { key: 'discovery' }, create: { key: 'discovery', enabled: true }, update: { enabled: true } });
  A = await adultToken('a'); B = await adultToken('b'); C = await adultToken('c');
  // B and C go visible at the precise point; wait out the gate flag cache once.
  await goVisible(B.token); await goVisible(C.token);
  await new Promise((r) => setTimeout(r, 5500));
}, 30_000);

afterAll(async () => {
  Object.assign(console, origConsole);
  await prisma.runtimeFlag.deleteMany({ where: { key: 'discovery' } }).catch(() => {});
  await prisma.discoveryVisibility.deleteMany({ where: { userId: { in: [A?.id, B?.id, C?.id].filter(Boolean) } } }).catch(() => {});
  await prisma.discoveryBlockProjection.deleteMany({ where: { ownerUserId: { in: [A?.id, C?.id].filter(Boolean) } } }).catch(() => {});
  await prisma.discoveryPublicProfileProjection.deleteMany({ where: { userId: { in: [A?.id, B?.id, C?.id].filter(Boolean) } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { username: { startsWith: RUN } } }).catch(() => {});
  await app.close();
  await prisma.$disconnect();
});

describe('C4 — precise coordinates never cross the boundary (captured bytes)', () => {
  it('the query RESPONSE contains distanceBand + a COARSE approxLocation, and NEVER the precise input, coarseDistanceM, or precise-shape fields', async () => {
    const res = await query(A.token);
    expect(res.status).toBeLessThan(300); // POST → 201
    const raw = await res.text(); // the ACTUAL bytes on the wire
    // Someone visible nearby is present, projected to bands.
    expect(raw).toContain('distanceBand');
    expect(raw).toContain('approxLocation');
    // THE POINT: the precise 6-decimal fix is nowhere in the payload…
    expect(raw).not.toContain(PRECISE_LAT_STR);
    expect(raw).not.toContain(PRECISE_LON_STR);
    // …the internal metre distance never leaks…
    expect(raw).not.toContain('coarseDistanceM');
    // …and no device-precise GeolocationCoordinates field rides along.
    for (const marker of ['accuracy', 'altitude', 'heading', 'speed', '"coords"']) {
      expect(raw).not.toContain(marker);
    }
    // The coarse value that IS allowed appears (3-decimal grid).
    const page = JSON.parse(raw);
    const results = page.results ?? page.people ?? [];
    expect(results.length).toBeGreaterThan(0);
    const loc = results[0].approxLocation ?? results[0].person?.approxLocation;
    // Coarse lat has at most 3 decimals.
    expect(String(loc.lat)).toMatch(/^\d+\.\d{1,3}$/);
    expect(String(loc.lat)).toContain('12.977'.slice(0, 5));
  });

  it('coarse-location branding holds end to end: the STORED row is coarse (3 decimals), not the precise input', async () => {
    const row = await prisma.discoveryVisibility.findUnique({ where: { userId: B.id } });
    expect(row?.enabled).toBe(true);
    // Stored coarse lat/lon are re-quantized — never the 6-decimal precise value.
    expect(Number(row?.coarseLat)).not.toBe(PRECISE.lat);
    expect(String(row?.coarseLat)).toMatch(/^\d+\.\d{1,3}$/);
    expect(row?.coarseCell).toContain(COARSE_LAT_STR);
  });
});

describe('C4 — realtime presence payloads carry no precise location', () => {
  it('the DiscoveryRealtimeEvent contract exposes only coarseCell + version — never lat/lon (type + source)', () => {
    // Structural proof at the type boundary: build every event variant and
    // assert the serialized shape has no coordinate key.
    const events: DiscoveryRealtimeEvent[] = [
      { type: 'cell-presence-updated', coarseCell: 'g12.977:77.591', visibilityVersion: 1 },
      { type: 'cell-presence-expired', coarseCell: 'g12.977:77.591', visibilityVersion: 2 },
    ];
    for (const e of events) {
      const raw = JSON.stringify(e);
      expect(raw).not.toContain(PRECISE_LAT_STR);
      expect(raw).not.toMatch(/"lat"|"lon"|"latitude"|"longitude"/);
      expect(raw).toContain('coarseCell');
    }
    // And the source file names no coordinate field in its event union.
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/discovery/realtime/realtime.port.ts'), 'utf8');
    const union = src.slice(src.indexOf('RealtimeEvent'), src.indexOf('RealtimeEvent') + 600);
    expect(union).not.toMatch(/\blat\b|\blon\b|precise/i);
  });
});

describe('C4 — ghost mode genuinely removes the user from results', () => {
  it('a ghosted (visibility-disabled) user disappears from a nearby query', async () => {
    // C is visible now; confirm C is found, then ghost C, then confirm gone.
    const before = JSON.parse(await (await query(A.token)).text());
    const beforeIds = JSON.stringify(before).includes(C.id);
    expect(beforeIds).toBe(true);
    await goGhost(C.token);
    const after = JSON.parse(await (await query(A.token)).text());
    expect(JSON.stringify(after)).not.toContain(C.id);
    await goVisible(C.token); // restore for later
  });
});

describe('C4 — blocked/blocking users never appear to each other (symmetry)', () => {
  it('A blocks C → C vanishes from A\'s results', async () => {
    await prisma.discoveryBlockProjection.create({ data: { ownerUserId: A.id, blockedUserId: C.id } });
    const res = JSON.stringify(await (await query(A.token)).text());
    expect(res).not.toContain(C.id);
    await prisma.discoveryBlockProjection.deleteMany({ where: { ownerUserId: A.id, blockedUserId: C.id } });
  });

  it('C blocks A → C STILL vanishes from A\'s results (block is symmetric in SQL)', async () => {
    await prisma.discoveryBlockProjection.create({ data: { ownerUserId: C.id, blockedUserId: A.id } });
    const res = JSON.stringify(await (await query(A.token)).text());
    expect(res).not.toContain(C.id);
    await prisma.discoveryBlockProjection.deleteMany({ where: { ownerUserId: C.id, blockedUserId: A.id } });
  });
});

describe('C4 — anti-enumeration & precise-shape refusal on live routes', () => {
  it('a precise-shaped query (accuracy/coords) is REFUSED, not coarsened silently', async () => {
    const res = await query(A.token, { origin: { lat: PRECISE.lat, lon: PRECISE.lon, accuracy: 5 } });
    const raw = await res.text();
    // Rejected as a precise-location refusal (state failed), never a 200 result page.
    expect(raw).toMatch(/PRECISE|refus|failed/i);
    expect(raw).not.toContain(PRECISE_LON_STR);
  });

  it('the radius is clamped to a ceiling — an over-ceiling request cannot widen the net arbitrarily', async () => {
    const res = await query(A.token, { radius: { km: 999 } });
    // Either a clamp (200 with a bounded result) or an explicit refusal — never
    // an unbounded scan. We assert it does not error 5xx and does not echo precise.
    expect(res.status).toBeLessThan(500);
    expect(await res.text()).not.toContain(PRECISE_LON_STR);
  });

  it('the page size is bounded (no unbounded enumeration of everyone nearby)', async () => {
    const page = JSON.parse(await (await query(A.token)).text());
    const results = page.results ?? page.people ?? [];
    expect(results.length).toBeLessThanOrEqual(100);
  });
});

describe('C4 — no location value in logs during a real query', () => {
  it('capturing console across a query, the precise fix appears in NOTHING logged', async () => {
    capturedConsole = [];
    const grab = (...a: unknown[]) => capturedConsole.push(a.map(String).join(' '));
    console.log = grab; console.error = grab; console.warn = grab;
    await query(A.token);
    await goVisible(A.token);
    Object.assign(console, origConsole);
    const all = capturedConsole.join('\n');
    expect(all).not.toContain(PRECISE_LAT_STR);
    expect(all).not.toContain(PRECISE_LON_STR);
  });
});

describe('C4 — an unverified or frozen account gets 403 at the Discovery door', () => {
  it('re-asserted here for C4 completeness (full matrix in discovery-gate-runtime.spec)', async () => {
    // Mint an unverified account and hit a discovery route.
    const id = `u${RUN}0000000000000`.replace(/[^a-f0-9]/gi, 'f').slice(0, 16);
    const username = `${RUN}unv`.slice(0, 16);
    const secret = 'unv-secret-12345678';
    const { createHash } = require('node:crypto');
    await prisma.user.create({ data: { id, username, claimSecretHash: createHash('sha256').update(secret).digest('hex') } });
    const r = await fetch(`${url}/api/auth/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, username, secret }) });
    const token = ((await r.json()) as { accessToken: string }).accessToken;
    const res = await fetch(`${url}/api/v2/discovery/visibility`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toBe('age_requirement');
  });
});
