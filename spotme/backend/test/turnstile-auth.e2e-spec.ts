/**
 * ADR-032 — Turnstile wiring proven through the REAL app over real HTTP:
 * the gate sits in front of auth/signup, auth/guest and both OTP legs, and
 * each posture rule holds end-to-end:
 *
 *   - no TURNSTILE_SECRET_KEY (the repo's permanent state today) ⇒ requests
 *     flow exactly as before — the absent-key bypass, proven on the wire
 *   - key present + no token           ⇒ 403 turnstile_required
 *   - key present + rejected token     ⇒ 403 turnstile_failed
 *   - key present + accepted token     ⇒ normal handler response
 *   - key present + siteverify outage  ⇒ FAIL-OPEN, normal handler response
 *
 * Cloudflare is fixture-faked by intercepting ONLY the siteverify URL on the
 * global fetch; every other fetch (the test's own HTTP calls) passes through.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { TURNSTILE_HEADER, TURNSTILE_VERIFY_URL } from '../src/middleware/turnstile';

jest.setTimeout(60_000);

const hex = (n: number) =>
  Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

type SiteverifyMode = { kind: 'pass' } | { kind: 'fail' } | { kind: 'outage' };
let siteverify: SiteverifyMode = { kind: 'pass' };
let siteverifyCalls = 0;

const realFetch = globalThis.fetch;

describe('Turnstile on the auth surface (e2e)', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === TURNSTILE_VERIFY_URL) {
        siteverifyCalls += 1;
        if (siteverify.kind === 'outage') throw new Error('fixture outage');
        return new Response(JSON.stringify({ success: siteverify.kind === 'pass' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0);
    url = await app.getUrl();
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    delete process.env.TURNSTILE_SECRET_KEY;
    await app.close();
  });

  /** An adult declaration: the 18+ gate (ADR-029) refuses account creation
   *  without one, so every create fixture below carries it. */
  const ADULT = '2000-01';

  /** OTP request needs an account behind the email — sign one up first
   *  (the signup POST itself passes through the gate under test). */
  const signupEmail = async (headers: Record<string, string> = {}) => {
    const email = `t_${hex(8)}@example.test`;
    const res = await fetch(`${url}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ username: 'tu_' + hex(6), email, name: 'TS', birthYearMonth: ADULT }),
    });
    return { email, status: res.status };
  };

  const otpRequest = (email: string, headers: Record<string, string> = {}) =>
    fetch(`${url}/api/auth/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ email }),
    });

  const guest = (headers: Record<string, string> = {}) =>
    fetch(`${url}/api/auth/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ id: hex(16), username: 'ts_' + hex(6), name: 'TS', secret: 'tssecret123', birthYearMonth: ADULT }),
    });

  it('ABSENT KEY (today): signup, OTP request and guest signup answer normally, siteverify never called', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const before = siteverifyCalls;
    const { email, status } = await signupEmail();
    expect(status).toBe(201);
    expect((await otpRequest(email)).status).toBe(201);
    expect((await guest()).status).toBe(201);
    expect(siteverifyCalls).toBe(before);
  });

  it('KEY PRESENT + no token: 403 turnstile_required on every gated route', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const { email } = await signupEmail(); // account minted while bypassed
    process.env.TURNSTILE_SECRET_KEY = 'e2e-secret';
    expect((await signupEmail()).status).toBe(403);
    for (const res of [await otpRequest(email), await guest()]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'turnstile_required' });
    }
    delete process.env.TURNSTILE_SECRET_KEY;
  });

  it('KEY PRESENT + rejected token: 403 turnstile_failed', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const { email } = await signupEmail();
    process.env.TURNSTILE_SECRET_KEY = 'e2e-secret';
    siteverify = { kind: 'fail' };
    const res = await otpRequest(email, { [TURNSTILE_HEADER]: 'bad-token' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'turnstile_failed' });
    delete process.env.TURNSTILE_SECRET_KEY;
  });

  it('KEY PRESENT + accepted token: the handler answers as normal', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'e2e-secret';
    siteverify = { kind: 'pass' };
    const res = await guest({ [TURNSTILE_HEADER]: 'good-token' });
    expect(res.status).toBe(201);
    delete process.env.TURNSTILE_SECRET_KEY;
  });

  it('KEY PRESENT + siteverify OUTAGE: fail-open — signup still works', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const { email } = await signupEmail();
    process.env.TURNSTILE_SECRET_KEY = 'e2e-secret';
    siteverify = { kind: 'outage' };
    const res = await otpRequest(email, { [TURNSTILE_HEADER]: 'any-token' });
    expect(res.status).toBe(201);
    delete process.env.TURNSTILE_SECRET_KEY;
  });

  it('guest RECOVERY is gated: it grinds codes against a public @username', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'e2e-secret';
    const res = await fetch(`${url}/api/auth/guest/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'someone', secret: 'guess-attempt-1' }),
    });
    // 403 turnstile_required, NOT the 401/404 the recover handler would give —
    // proof the gate runs BEFORE any code comparison happens.
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'turnstile_required' });
    delete process.env.TURNSTILE_SECRET_KEY;
  });

  it('UNGATED routes stay unchallenged even with the key present (refresh)', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'e2e-secret';
    const res = await fetch(`${url}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'not-a-real-token' }),
    });
    // 401 (bad token), NOT 403 turnstile_required — the gate is not in its path.
    expect(res.status).toBe(401);
    delete process.env.TURNSTILE_SECRET_KEY;
  });
});
