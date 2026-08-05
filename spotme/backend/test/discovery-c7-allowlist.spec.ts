/**
 * Wave 1C, C7 — the Stage-A allowlist mechanism, fenced against the required
 * properties, at runtime (real HTTP + PG). The discovery RuntimeFlag has ZERO
 * rows here (the production posture); access is granted ONLY by the allowlist.
 */

import { INestApplication, ValidationPipe, RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { ACCOUNT_FROZEN_MINOR, AGE_POLICY_VERSION } from '../src/policy/age';

const prisma = new PrismaClient();
const RUN = `c7${Date.now().toString(36)}`;
const ADULT = `${new Date().getUTCFullYear() - 30}-01`;
let app: INestApplication;
let url: string;

let mkSeq = 0;
async function mk(tag: string, kind: 'adult' | 'unverified' | 'frozen' = 'adult'): Promise<string> {
  const n = (mkSeq++).toString(16);
  const id = `${n}${RUN}0000000000000`.replace(/[^a-f0-9]/gi, 'f').slice(0, 16);
  const username = `${RUN}${n}${tag}`.slice(0, 16);
  const secret = `sec-${id}-12345678`;
  SECRETS.set(id, secret);
  if (kind === 'adult') {
    const r = await fetch(`${url}/api/auth/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, username, secret, birthYearMonth: ADULT }) });
    return ((await r.json()) as { userId: string }).userId ?? id;
  }
  await prisma.user.create({ data: { id, username, claimSecretHash: createHash('sha256').update(secret).digest('hex'), ...(kind === 'frozen' ? { accountStatus: ACCOUNT_FROZEN_MINOR, birthYearMonth: `${new Date().getUTCFullYear() - 15}-01`, agePolicyVersion: AGE_POLICY_VERSION } : {}) } });
  return id;
}
const SECRETS = new Map<string, string>();
async function tokenFor(userId: string): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const r = await fetch(`${url}/api/auth/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: userId, username: u.username, secret: SECRETS.get(userId) }) });
  const j = (await r.json()) as { accessToken?: string };
  return j.accessToken ?? '';
}
const hit = (t: string) => fetch(`${url}/api/v2/discovery/visibility`, { headers: { Authorization: `Bearer ${t}` } });
async function hitUntilNot404(t: string): Promise<Response> {
  const dl = Date.now() + 8000; let r = await hit(t);
  while (r.status === 404 && Date.now() < dl) { await new Promise((x) => setTimeout(x, 200)); r = await hit(t); }
  return r;
}

let ownerId: string, ownerTok: string, otherTok: string;

beforeAll(async () => {
  process.env.JWT_ACCESS_SECRET ||= 'c7-allowlist-secret-0123456789abcdef';
  const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = m.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }, { path: 'ready', method: RequestMethod.GET }] });
  await app.listen(0); url = await app.getUrl();
  // PRODUCTION POSTURE: discovery RuntimeFlag ABSENT. Access is allowlist-only.
  await prisma.runtimeFlag.deleteMany({ where: { key: 'discovery' } });
  ownerId = await mk('own'); ownerTok = await tokenFor(ownerId); otherTok = await tokenFor(await mk('oth'));
}, 30_000);

afterAll(async () => {
  await prisma.domainAllowlist.deleteMany({ where: { userId: { startsWith: '' }, domain: 'discovery' } }).catch(() => {});
  await prisma.discoveryVisibility.deleteMany({ where: { userId: { startsWith: RUN } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { username: { startsWith: RUN } } }).catch(() => {});
  await app.close(); await prisma.$disconnect();
});
afterEach(async () => { await prisma.domainAllowlist.deleteMany({ where: { domain: 'discovery' } }).catch(() => {}); });

describe('C7 — Stage-A allowlist (flag absent; production posture)', () => {
  it('with NOBODY allowlisted, even a verified adult owner gets 404', async () => {
    expect((await hit(ownerTok)).status).toBe(404);
  });

  it('THE POINT: allowlisting the owner (exact userId) opens Discovery for THEM ONLY', async () => {
    await prisma.domainAllowlist.create({ data: { domain: 'discovery', userId: ownerId, note: 'stage-A owner' } });
    // owner: served
    expect((await hitUntilNot404(ownerTok)).status).not.toBe(404);
    // a second, non-allowlisted account: still 404
    expect((await hit(otherTok)).status).toBe(404);
  }, 15_000);

  it('INDEPENDENT OF RuntimeFlag: the allowlist grant works with the flag row ABSENT', async () => {
    const flag = await prisma.runtimeFlag.findUnique({ where: { key: 'discovery' } });
    expect(flag).toBeNull(); // no flag row exists
    await prisma.domainAllowlist.create({ data: { domain: 'discovery', userId: ownerId } });
    expect((await hitUntilNot404(ownerTok)).status).not.toBe(404); // served purely by the allowlist
  }, 15_000);

  it('NO WILDCARD: an allowlist entry for a DIFFERENT user does not admit this one', async () => {
    const freshTok = await tokenFor(await mk('w')); // never hit → no stale cache
    await prisma.domainAllowlist.create({ data: { domain: 'discovery', userId: 'someone-else-entirely' } });
    expect((await hit(freshTok)).status).toBe(404);
  });

  it('the age gate STILL applies to an allowlisted account: unverified/frozen → 403, not 200', async () => {
    const unv = await mk('u1', 'unverified'); const frz = await mk('z1', 'frozen');
    await prisma.domainAllowlist.createMany({ data: [{ domain: 'discovery', userId: unv }, { domain: 'discovery', userId: frz }] });
    expect((await hitUntilNot404(await tokenFor(unv))).status).toBe(403);
    expect((await hitUntilNot404(await tokenFor(frz))).status).toBe(403);
  });

  it('TRIVIALLY REMOVABLE: deleting the row returns the account to 404 within a cache window', async () => {
    const uid = await mk('r'); const tok = await tokenFor(uid);
    await prisma.domainAllowlist.create({ data: { domain: 'discovery', userId: uid } });
    expect((await hitUntilNot404(tok)).status).not.toBe(404);
    await prisma.domainAllowlist.deleteMany({ where: { domain: 'discovery', userId: uid } });
    // within one cache window (5s TTL + margin) it is dark again
    let dark = false; const dl = Date.now() + 9000;
    while (!dark && Date.now() < dl) { if ((await hit(tok)).status === 404) dark = true; else await new Promise((x) => setTimeout(x, 200)); }
    expect(dark).toBe(true);
  }, 15_000);

  it('AUDITABLE: list(domain) enumerates exactly who is on it, with note + timestamp', async () => {
    await prisma.domainAllowlist.create({ data: { domain: 'discovery', userId: ownerId, note: 'stage-A owner' } });
    const rows = await prisma.domainAllowlist.findMany({ where: { domain: 'discovery' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(ownerId);
    expect(rows[0].note).toBe('stage-A owner');
    expect(rows[0].addedAt).toBeInstanceOf(Date);
  });
});
