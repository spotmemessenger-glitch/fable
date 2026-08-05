/**
 * Wave 1C, C3 — Discovery is MOUNTED but DARK, proven at RUNTIME against the
 * real HTTP stack (real Postgres). The dark posture is now enforced by the gate
 * + RuntimeFlag, not by non-import, so this asserts the live behaviour:
 *
 *   · flag ABSENT (production posture)      → 404 for everyone, even an adult
 *   · flag ON + unverified/frozen account   → 403 age_requirement
 *   · flag ON + verified adult              → route runs (not 404/403)
 *   · unauthenticated                        → 401 (JwtAuthGuard, before the gate)
 *
 * The RuntimeFlag row is written to the TEST database only; production stays at
 * zero rows (C7 uses the allowlist, not this flag, for Stage A).
 */

import { INestApplication, ValidationPipe, RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { ACCOUNT_FROZEN_MINOR, AGE_POLICY_VERSION } from '../src/policy/age';

const prisma = new PrismaClient();
const RUN = `dg${Date.now().toString(36)}`;
const ym = (yearsAgo: number) => {
  const d = new Date(Date.UTC(new Date().getUTCFullYear() - yearsAgo, new Date().getUTCMonth(), 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

let app: INestApplication;
let url: string;

let seq = 0;
/** Mint a real access token via the guest path (the app's own signer). */
async function tokenFor(kind: 'adult' | 'unverified' | 'frozen'): Promise<string> {
  const tag = { adult: 'a', unverified: 'v', frozen: 'z' }[kind];
  const id = `${tag}${(seq++).toString(16)}${RUN}0000000000000`.replace(/[^a-f0-9]/gi, 'f').slice(0, 16);
  const username = `${RUN}${tag}${seq}`.slice(0, 16);
  if (kind === 'adult') {
    const res = await fetch(`${url}/api/auth/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, username, secret: 'discsecret123', birthYearMonth: ym(30) }),
    });
    const body = (await res.json()) as { accessToken?: string };
    if (!body.accessToken) throw new Error(`adult token mint failed: ${res.status} ${JSON.stringify(body)}`);
    return body.accessToken;
  }
  // unverified / frozen: create a pre-gate row (with a known claim secret so the
  // guest reauth accepts it), then mint a token by re-auth.
  const secret = 'discsecret123';
  const claimSecretHash = createHash('sha256').update(secret).digest('hex');
  await prisma.user.create({
    data: { id, username, claimSecretHash, ...(kind === 'frozen' ? { accountStatus: ACCOUNT_FROZEN_MINOR, birthYearMonth: ym(15), agePolicyVersion: AGE_POLICY_VERSION } : {}) },
  });
  const res = await fetch(`${url}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, username, secret }),
  });
  const body = (await res.json()) as { accessToken?: string };
  if (!body.accessToken) throw new Error(`${kind} token mint failed: ${res.status} ${JSON.stringify(body)}`);
  return body.accessToken;
}

const hit = (token?: string) =>
  fetch(`${url}/api/v2/discovery/visibility`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

/** The gate reads the flag through a 5s cache (the R7 propagation window), so
 *  after writing the row we poll until it stops answering 404 — which also
 *  proves the flip propagates within the TTL. */
async function hitAfterFlagPropagates(token: string): Promise<Response> {
  const deadline = Date.now() + 8_000;
  let res = await hit(token);
  while (res.status === 404 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    res = await hit(token);
  }
  return res;
}

beforeAll(async () => {
  process.env.JWT_ACCESS_SECRET ||= 'discovery-gate-runtime-secret-0123456789';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }, { path: 'ready', method: RequestMethod.GET }] });
  await app.listen(0);
  url = await app.getUrl();
});

afterAll(async () => {
  await prisma.runtimeFlag.deleteMany({ where: { key: 'discovery' } }).catch(() => {});
  await prisma.user.deleteMany({ where: { username: { startsWith: RUN } } }).catch(() => {});
  await app.close();
  await prisma.$disconnect();
});

afterEach(async () => {
  await prisma.runtimeFlag.deleteMany({ where: { key: 'discovery' } }).catch(() => {});
});

describe('Discovery mounted-but-dark (runtime)', () => {
  it('PRODUCTION POSTURE: with NO discovery flag row, a verified adult still gets 404', async () => {
    const adult = await tokenFor('adult');
    expect((await hit(adult)).status).toBe(404);
  });

  it('unauthenticated → 401 (auth guard runs before the gate)', async () => {
    expect((await hit(undefined)).status).toBe(401);
  });

  it('flag ON + unverified account → 403 age_requirement', async () => {
    await prisma.runtimeFlag.create({ data: { key: 'discovery', enabled: true } });
    const unverified = await tokenFor('unverified');
    const res = await hitAfterFlagPropagates(unverified);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toBe('age_requirement');
    }, 15_000);

  it('flag ON + FROZEN account → 403 (frozen is refused even though it is an existing account)', async () => {
    await prisma.runtimeFlag.create({ data: { key: 'discovery', enabled: true } });
    const frozen = await tokenFor('frozen');
    expect((await hitAfterFlagPropagates(frozen)).status).toBe(403);
    }, 15_000);

  it('flag ON + verified adult → the route RUNS (not 404, not 403)', async () => {
    await prisma.runtimeFlag.create({ data: { key: 'discovery', enabled: true } });
    const adult = await tokenFor('adult');
    const res = await hitAfterFlagPropagates(adult);
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(403);
    expect(res.status).toBeLessThan(500);
    }, 15_000);
});
