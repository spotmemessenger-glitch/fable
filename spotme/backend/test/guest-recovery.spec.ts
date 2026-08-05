/**
 * Fix-the-Foundation F1 — signing back in after local state loss.
 *
 * THE BUG THIS PINS. A guest identity lived ONLY in device storage. Lose the
 * storage — an in-app browser that discards its webview data, "clear site
 * data", a reinstall — and the account was unreachable forever: the app showed
 * onboarding, the old @username stayed claimed by a row nobody could reach,
 * and the user registered again under a new name. Every time. That is the
 * "I have to sign up again on every reopen" report.
 *
 * The claim secret already proved device ownership on re-auth; this proves the
 * same thing from a device that kept the secret but lost everything else, and
 * hands back the ACCOUNT'S id so the new device adopts the identity rather
 * than minting a rival one.
 *
 * Runs against real Postgres through the real HTTP stack.
 */

import { INestApplication, ValidationPipe, RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { ACCOUNT_FROZEN_MINOR, AGE_POLICY_VERSION } from '../src/policy/age';

const prisma = new PrismaClient();
const RUN = `rec${Date.now().toString(36)}`;
const ADULT = `${new Date().getUTCFullYear() - 30}-01`;
let app: INestApplication;
let url: string;

const post = (path: string, body: unknown) =>
  fetch(`${url}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

let seq = 0;
/** A real guest signup, exactly as the web client performs it. */
async function signup(tag: string, secret: string) {
  const n = (seq++).toString(16);
  const id = `${n}${RUN}0000000000000`.replace(/[^a-f0-9]/gi, 'f').slice(0, 16);
  const username = `${RUN}${n}${tag}`.slice(0, 16);
  const r = await post('/auth/guest', { id, username, secret, birthYearMonth: ADULT });
  const j = (await r.json()) as { userId?: string };
  return { id: j.userId ?? id, username };
}

beforeAll(async () => {
  process.env.JWT_ACCESS_SECRET ||= 'f1-recovery-secret-0123456789abcdef';
  const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = m.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }, { path: 'ready', method: RequestMethod.GET }] });
  await app.listen(0);
  url = await app.getUrl();
}, 30_000);

afterAll(async () => {
  await prisma.refreshToken.deleteMany({ where: { user: { username: { startsWith: RUN } } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { username: { startsWith: RUN } } }).catch(() => {});
  await app.close();
  await prisma.$disconnect();
});

describe('F1 — guest account recovery', () => {
  it('THE POINT: username + recovery code returns the SAME account id, not a new one', async () => {
    const secret = 'recovery-secret-1';
    const me = await signup('a', secret);

    const r = await post('/auth/guest/recover', { username: me.username, secret });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { userId: string; username: string; accessToken: string };
    // The identity every room, key lookup and chat request is keyed on.
    expect(body.userId).toBe(me.id);
    expect(body.username).toBe(me.username);
    expect(body.accessToken).toBeTruthy();

    // Exactly one row still: recovery must never fork the account.
    expect(await prisma.user.count({ where: { username: me.username } })).toBe(1);
  });

  it('the returned token authenticates as that account', async () => {
    const secret = 'recovery-secret-2';
    const me = await signup('b', secret);
    const body = (await (await post('/auth/guest/recover', { username: me.username, secret })).json()) as { accessToken: string };
    const r = await fetch(`${url}/api/users/me`, { headers: { Authorization: `Bearer ${body.accessToken}` } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { id: string }).id).toBe(me.id);
  });

  it('a WRONG code is refused, and the refusal is not enumerable', async () => {
    const me = await signup('c', 'recovery-secret-3');
    const wrong = await post('/auth/guest/recover', { username: me.username, secret: 'not-the-secret-at-all' });
    const missing = await post('/auth/guest/recover', { username: `${RUN}nobody`.slice(0, 16), secret: 'not-the-secret-at-all' });
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    // Byte-identical bodies: a caller learns nothing about which part failed.
    expect(await wrong.text()).toBe(await missing.text());
  });

  it('a DELETED account cannot be recovered, with the same refusal shape', async () => {
    const secret = 'recovery-secret-4';
    const me = await signup('d', secret);
    await prisma.user.update({ where: { id: me.id }, data: { deletedAt: new Date() } });
    const r = await post('/auth/guest/recover', { username: me.username, secret });
    expect(r.status).toBe(401);
  });

  it('a FROZEN account recovers its read access AND is told why (D6 addendum)', async () => {
    const secret = 'recovery-secret-5';
    const me = await signup('e', secret);
    await prisma.user.update({
      where: { id: me.id },
      data: { accountStatus: ACCOUNT_FROZEN_MINOR, agePolicyVersion: AGE_POLICY_VERSION },
    });
    const r = await post('/auth/guest/recover', { username: me.username, secret });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { userId: string; accountFrozen?: boolean; notice?: string };
    expect(body.userId).toBe(me.id);
    expect(body.accountFrozen).toBe(true);
    expect(body.notice).toBeTruthy();
  });

  it('recovery does NOT hand back the age declaration or any credential hash', async () => {
    const secret = 'recovery-secret-6';
    const me = await signup('f', secret);
    const raw = await (await post('/auth/guest/recover', { username: me.username, secret })).text();
    expect(raw).not.toContain('birthYearMonth');
    expect(raw).not.toContain(ADULT);
    expect(raw).not.toContain('claimSecretHash');
    expect(raw).not.toContain('passwordHash');
  });

  it('a malformed username or a too-short code is rejected by validation', async () => {
    expect((await post('/auth/guest/recover', { username: 'NOT VALID', secret: '12345678' })).status).toBe(400);
    expect((await post('/auth/guest/recover', { username: 'someone', secret: 'short' })).status).toBe(400);
  });
});
