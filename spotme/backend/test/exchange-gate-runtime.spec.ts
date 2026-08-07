/**
 * E1 — Exchange is MOUNTED, and DARK, proven at runtime.
 *
 * The static fence asserts the guard is written on the controller. This
 * asserts what a caller actually RECEIVES: with the `exchange` RuntimeFlag row
 * absent (the production posture) every route answers 404 — byte-identical to
 * a module that was never mounted — and turning the flag on serves the same
 * routes to a verified adult. Nothing here is inferred from source text, which
 * is the point: E1's whole claim is "production still 404s", and only a real
 * request can settle that.
 *
 * The allowlist leg is asserted too, because it is how @yuv2 gets in without
 * a flag flip: a single (domain, userId) row opens the surface for exactly one
 * account while every other caller keeps getting 404.
 */

import { INestApplication, ValidationPipe, RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { ACCOUNT_FROZEN_MINOR, AGE_POLICY_VERSION } from '../src/policy/age';

const prisma = new PrismaClient();
const RUN = `xg${Date.now().toString(36)}`;
const ADULT = `${new Date().getUTCFullYear() - 30}-01`;
let app: INestApplication;
let url: string;
const SECRETS = new Map<string, string>();
let seq = 0;

async function mk(tag: string, kind: 'adult' | 'unverified' | 'frozen' = 'adult'): Promise<string> {
  const n = (seq++).toString(16);
  const id = `${n}${RUN}0000000000000`.replace(/[^a-f0-9]/gi, 'f').slice(0, 16);
  const username = `${RUN}${n}${tag}`.slice(0, 16);
  const secret = `sec-${id}-12345678`;
  SECRETS.set(id, secret);
  if (kind === 'adult') {
    const r = await fetch(`${url}/api/auth/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, username, secret, birthYearMonth: ADULT }),
    });
    return ((await r.json()) as { userId: string }).userId ?? id;
  }
  await prisma.user.create({
    data: {
      id,
      username,
      claimSecretHash: createHash('sha256').update(secret).digest('hex'),
      ...(kind === 'frozen'
        ? {
            accountStatus: ACCOUNT_FROZEN_MINOR,
            birthYearMonth: `${new Date().getUTCFullYear() - 15}-01`,
            agePolicyVersion: AGE_POLICY_VERSION,
          }
        : {}),
    },
  });
  return id;
}

async function tokenFor(userId: string): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const r = await fetch(`${url}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: userId, username: u.username, secret: SECRETS.get(userId) }),
  });
  return ((await r.json()) as { accessToken?: string }).accessToken ?? '';
}

const browse = (t: string) =>
  fetch(`${url}/api/v1/exchange/browse`, { headers: { Authorization: `Bearer ${t}` } });
const mine = (t: string) =>
  fetch(`${url}/api/v1/exchange/intents/mine`, { headers: { Authorization: `Bearer ${t}` } });

async function until(fn: () => Promise<number>, want: number, ms = 9000): Promise<number> {
  const dl = Date.now() + ms;
  let got = await fn();
  while (got !== want && Date.now() < dl) {
    await new Promise((r) => setTimeout(r, 200));
    got = await fn();
  }
  return got;
}

let adultTok: string;
let adultId: string;

beforeAll(async () => {
  process.env.JWT_ACCESS_SECRET ||= 'exchange-gate-runtime-0123456789abcdef';
  const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = m.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'ready', method: RequestMethod.GET },
    ],
  });
  await app.listen(0);
  url = await app.getUrl();
  await prisma.runtimeFlag.deleteMany({ where: { key: 'exchange' } }); // production posture
  await prisma.domainAllowlist.deleteMany({ where: { domain: 'exchange' } });
  adultId = await mk('ad');
  adultTok = await tokenFor(adultId);
}, 40_000);

afterAll(async () => {
  await prisma.runtimeFlag.deleteMany({ where: { key: 'exchange' } }).catch(() => {});
  await prisma.domainAllowlist.deleteMany({ where: { domain: 'exchange' } }).catch(() => {});
  await prisma.user.deleteMany({ where: { username: { startsWith: RUN } } }).catch(() => {});
  await app.close();
  await prisma.$disconnect();
});

describe('Exchange — mounted, and dark at runtime', () => {
  it('THE DARK POSTURE: with no flag row, a verified adult gets 404 on every route', async () => {
    expect((await browse(adultTok)).status).toBe(404);
    expect((await mine(adultTok)).status).toBe(404);
    const one = await fetch(`${url}/api/v1/exchange/intents/xx-nope`, {
      headers: { Authorization: `Bearer ${adultTok}` },
    });
    expect(one.status).toBe(404);
    const create = await fetch(`${url}/api/v1/exchange/intents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adultTok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'need', title: 'a charger' }),
    });
    expect(create.status).toBe(404);
  });

  it('404 is indistinguishable from an unmounted module — no body leaks the domain', async () => {
    const body = await (await browse(adultTok)).text();
    expect(body).not.toMatch(/exchange/i);
    expect(body).not.toMatch(/flag|disabled|gate|allowlist/i);
  });

  it('unauthenticated is 401 BEFORE the gate — the surface never leaks to anonymous callers', async () => {
    expect((await fetch(`${url}/api/v1/exchange/browse`)).status).toBe(401);
  });

  it('ALLOWLIST: one exact (domain,userId) row opens it for that account only', async () => {
    const other = await mk('ot');
    const otherTok = await tokenFor(other);
    await prisma.domainAllowlist.create({
      data: { domain: 'exchange', userId: adultId, note: 'E1 runtime proof' },
    });
    expect(await until(async () => (await browse(adultTok)).status, 200)).toBe(200);
    // Everyone else is still dark — no wildcard, no leakage.
    expect((await browse(otherTok)).status).toBe(404);
    await prisma.domainAllowlist.deleteMany({ where: { domain: 'exchange' } });
    expect(await until(async () => (await browse(adultTok)).status, 404)).toBe(404);
  }, 30_000);

  it('ACTIVATION: with the flag on, the same routes serve a verified adult', async () => {
    await prisma.runtimeFlag.upsert({
      where: { key: 'exchange' },
      update: { enabled: true },
      create: { key: 'exchange', enabled: true },
    });
    expect(await until(async () => (await browse(adultTok)).status, 200)).toBe(200);
    expect((await mine(adultTok)).status).toBe(200);
  }, 20_000);

  it('the age gate still applies with the flag ON: unverified and frozen get 403', async () => {
    for (const kind of ['unverified', 'frozen'] as const) {
      const tok = await tokenFor(await mk(kind === 'frozen' ? 'fz' : 'uv', kind));
      const res = await browse(tok);
      expect(res.status).toBe(403);
      expect((await res.json()) as { error?: string }).toMatchObject({ error: 'age_requirement' });
    }
  }, 30_000);

  it('ROLLBACK: deleting the flag row returns every route to 404 within a cache window', async () => {
    await prisma.runtimeFlag.deleteMany({ where: { key: 'exchange' } });
    expect(await until(async () => (await browse(adultTok)).status, 404)).toBe(404);
  }, 20_000);
});
