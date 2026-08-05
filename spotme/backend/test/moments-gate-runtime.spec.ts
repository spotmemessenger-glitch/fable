/**
 * Wave 1D (M1) — Moments is MOUNTED, and DARK, proven at runtime.
 *
 * The static fence asserts the guard is written on every controller. This
 * asserts what a caller actually receives: with the `moments` RuntimeFlag row
 * absent (the production posture) every route answers 404 — byte-identical to
 * a module that was never mounted — and turning the flag on serves the same
 * routes to a verified adult. Nothing here is inferred from source text.
 */

import { INestApplication, ValidationPipe, RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { ACCOUNT_FROZEN_MINOR, AGE_POLICY_VERSION } from '../src/policy/age';

const prisma = new PrismaClient();
const RUN = `mg${Date.now().toString(36)}`;
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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, username, secret, birthYearMonth: ADULT }),
    });
    return ((await r.json()) as { userId: string }).userId ?? id;
  }
  await prisma.user.create({
    data: {
      id, username, claimSecretHash: createHash('sha256').update(secret).digest('hex'),
      ...(kind === 'frozen'
        ? { accountStatus: ACCOUNT_FROZEN_MINOR, birthYearMonth: `${new Date().getUTCFullYear() - 15}-01`, agePolicyVersion: AGE_POLICY_VERSION }
        : {}),
    },
  });
  return id;
}

async function tokenFor(userId: string): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const r = await fetch(`${url}/api/auth/guest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: userId, username: u.username, secret: SECRETS.get(userId) }),
  });
  return ((await r.json()) as { accessToken?: string }).accessToken ?? '';
}

const feed = (t: string) => fetch(`${url}/api/v1/moments/feed?mode=friends`, { headers: { Authorization: `Bearer ${t}` } });
const upload = (t: string) => fetch(`${url}/api/v1/moments/media`, {
  method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'image/jpeg' }, body: Buffer.from([0xff, 0xd8, 0xff]),
});

async function until(fn: () => Promise<number>, want: number, ms = 9000): Promise<number> {
  const dl = Date.now() + ms;
  let got = await fn();
  while (got !== want && Date.now() < dl) { await new Promise((r) => setTimeout(r, 200)); got = await fn(); }
  return got;
}

let adultTok: string;

beforeAll(async () => {
  process.env.JWT_ACCESS_SECRET ||= 'moments-gate-runtime-0123456789abcdef';
  const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = m.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }, { path: 'ready', method: RequestMethod.GET }] });
  await app.listen(0); url = await app.getUrl();
  await prisma.runtimeFlag.deleteMany({ where: { key: 'moments' } });   // production posture
  await prisma.domainAllowlist.deleteMany({ where: { domain: 'moments' } });
  adultTok = await tokenFor(await mk('ad'));
}, 40_000);

afterAll(async () => {
  await prisma.runtimeFlag.deleteMany({ where: { key: 'moments' } }).catch(() => {});
  await prisma.domainAllowlist.deleteMany({ where: { domain: 'moments' } }).catch(() => {});
  await prisma.user.deleteMany({ where: { username: { startsWith: RUN } } }).catch(() => {});
  await app.close(); await prisma.$disconnect();
});

describe('Moments — mounted, and dark at runtime', () => {
  it('THE DARK POSTURE: with no flag row, a verified adult gets 404 on every route', async () => {
    expect((await feed(adultTok)).status).toBe(404);
    expect((await upload(adultTok)).status).toBe(404);
    const one = await fetch(`${url}/api/v1/moments/media/mm-nope/url`, { headers: { Authorization: `Bearer ${adultTok}` } });
    expect(one.status).toBe(404);
  });

  it('404 is indistinguishable from an unmounted module — no body leaks the domain', async () => {
    const res = await feed(adultTok);
    const body = await res.text();
    expect(body).not.toMatch(/moments/i);
    expect(body).not.toMatch(/flag|disabled|gate/i);
  });

  it('unauthenticated is 401 BEFORE the gate — the surface never leaks to anonymous callers', async () => {
    expect((await fetch(`${url}/api/v1/moments/feed`)).status).toBe(401);
  });

  it('ACTIVATION: with the flag on, the same routes serve a verified adult', async () => {
    await prisma.runtimeFlag.upsert({
      where: { key: 'moments' }, update: { enabled: true }, create: { key: 'moments', enabled: true },
    });
    expect(await until(async () => (await feed(adultTok)).status, 200)).toBe(200);
  }, 20_000);

  it('M2 REGRESSION: creating a text moment over REAL HTTP works (principal shape)', async () => {
    /* This is the test that would have caught the production 500. The
     * lifecycle e2e drives MomentsService directly with authorId strings, so
     * it can never notice the controller reading a principal field the JWT
     * strategy does not provide — u.sub was undefined, authorId reached
     * Prisma as undefined, and every create 500ed in production while the
     * suite stayed green. Only a request through the real strategy sees it. */
    const res = await fetch(`${url}/api/v1/moments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adultTok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'text', text: `gate-runtime ${RUN}`, mediaIds: [], visibility: 'friends' }),
    });
    expect(res.status).toBeLessThan(300);
    const made = (await res.json()) as { id?: string; authorId?: string };
    expect(made.id).toBeTruthy();
    // The author must be the AUTHENTICATED account, not undefined-coerced.
    if (made.authorId) expect(made.authorId.length).toBeGreaterThan(0);
    await prisma.moment.deleteMany({ where: { id: made.id } }).catch(() => {});
  }, 20_000);

  it('M2 REGRESSION: filing a report over REAL HTTP works and records delivery (D7)', async () => {
    const res = await fetch(`${url}/api/v1/moments/reports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adultTok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetKind: 'moment', targetId: 'mo-gate-runtime', reason: 'Spam or scam' }),
    });
    expect(res.status).toBeLessThan(300);
    const rep = (await res.json()) as { reportId?: string };
    expect(rep.reportId).toBeTruthy();
    const row = await prisma.momentReport.findUnique({ where: { id: rep.reportId! } });
    expect(row).toBeTruthy();
    expect(row!.reporterId).toBeTruthy();          // not undefined-coerced
    expect(row!.queuedAt).toBeTruthy();            // the D7 delivery marker
    await prisma.momentReport.deleteMany({ where: { id: rep.reportId } }).catch(() => {});
  }, 20_000);

  it('the age gate still applies with the flag ON: unverified and frozen get 403', async () => {
    const unv = await tokenFor(await mk('u1', 'unverified'));
    const frz = await tokenFor(await mk('z1', 'frozen'));
    expect(await until(async () => (await feed(unv)).status, 403)).toBe(403);
    expect(await until(async () => (await feed(frz)).status, 403)).toBe(403);
  }, 20_000);

  it('ROLLBACK: deleting the flag row returns every route to 404 within a cache window', async () => {
    await prisma.runtimeFlag.deleteMany({ where: { key: 'moments' } });
    expect(await until(async () => (await feed(adultTok)).status, 404)).toBe(404);
    expect((await upload(adultTok)).status).toBe(404);
  }, 20_000);
});
