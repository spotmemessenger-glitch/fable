/**
 * ADR-032 — the Turnstile gate's three-rule posture, unit-tested against
 * fixture siteverify responses:
 *   1. absent key  → structural bypass (next(), no network, no header demand)
 *   2. outage      → FAIL-OPEN with one logged warning
 *   3. verdict     → fail-closed (missing token / success:false ⇒ 403)
 */
import {
  createTurnstileGate,
  TURNSTILE_HEADER,
  TURNSTILE_VERIFY_URL,
  TurnstileRequest,
  TurnstileResponse,
} from '../src/middleware/turnstile';

const ENV = 'TURNSTILE_TEST_SECRET';

function fakeRes() {
  const rec = { code: 0, body: undefined as unknown };
  const res: TurnstileResponse = {
    status(code: number) { rec.code = code; return res; },
    json(body: unknown) { rec.body = body; return body; },
  };
  return { res, rec };
}
const reqWith = (token?: string): TurnstileRequest => ({
  headers: token ? { [TURNSTILE_HEADER]: token } : {},
  ip: '198.51.100.7',
});
const okJson = (payload: unknown) =>
  ({ ok: true, status: 200, json: async () => payload }) as Response;

afterEach(() => { delete process.env[ENV]; });

describe('rule 1 — structural bypass without a key', () => {
  it('calls next() immediately: no fetch, no token demand, no response written', async () => {
    const fetchSpy = jest.fn();
    const gate = createTurnstileGate({ secretEnvName: ENV, fetchImpl: fetchSpy });
    const { res, rec } = fakeRes();
    const next = jest.fn();
    await gate(reqWith(), res, next); // no token sent either — must not matter
    expect(next).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rec.code).toBe(0);
  });
});

describe('rule 3 — verdicts fail closed when the key is present', () => {
  it('a valid token passes: siteverify is called with secret+response, then next()', async () => {
    process.env[ENV] = 'test-secret-value';
    const fetchSpy = jest.fn(async (url: unknown, init?: RequestInit) => {
      expect(url).toBe(TURNSTILE_VERIFY_URL);
      const body = init?.body as URLSearchParams;
      expect(body.get('secret')).toBe('test-secret-value');
      expect(body.get('response')).toBe('tok-live-1');
      expect(body.get('remoteip')).toBe('198.51.100.7');
      return okJson({ success: true });
    });
    const gate = createTurnstileGate({ secretEnvName: ENV, fetchImpl: fetchSpy as typeof fetch });
    const { res } = fakeRes();
    const next = jest.fn();
    await gate(reqWith('tok-live-1'), res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('success:false ⇒ 403 turnstile_failed, next() never runs', async () => {
    process.env[ENV] = 's';
    const gate = createTurnstileGate({
      secretEnvName: ENV,
      fetchImpl: (async () => okJson({ success: false, 'error-codes': ['invalid-input-response'] })) as typeof fetch,
    });
    const { res, rec } = fakeRes();
    const next = jest.fn();
    await gate(reqWith('bad-token'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(rec.code).toBe(403);
    expect(rec.body).toEqual({ error: 'turnstile_failed' });
  });

  it('missing token while active ⇒ 403 turnstile_required, no verify call', async () => {
    process.env[ENV] = 's';
    const fetchSpy = jest.fn();
    const gate = createTurnstileGate({ secretEnvName: ENV, fetchImpl: fetchSpy });
    const { res, rec } = fakeRes();
    const next = jest.fn();
    await gate(reqWith(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rec.code).toBe(403);
    expect(rec.body).toEqual({ error: 'turnstile_required' });
  });
});

describe('rule 2 — outages fail OPEN with a logged warning', () => {
  it('network failure ⇒ next() and one warning; no 5xx to the user', async () => {
    process.env[ENV] = 's';
    const warn = jest.fn();
    const gate = createTurnstileGate({
      secretEnvName: ENV,
      logger: { warn },
      fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch,
    });
    const { res, rec } = fakeRes();
    const next = jest.fn();
    await gate(reqWith('tok'), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(rec.code).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('failing OPEN');
  });

  it('siteverify 5xx ⇒ fail-open (an unwell answer is an outage, not a verdict)', async () => {
    process.env[ENV] = 's';
    const warn = jest.fn();
    const gate = createTurnstileGate({
      secretEnvName: ENV,
      logger: { warn },
      fetchImpl: (async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response) as typeof fetch,
    });
    const next = jest.fn();
    await gate(reqWith('tok'), fakeRes().res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('TIMEOUT-SAFE: a hung siteverify is aborted at the budget and fails open', async () => {
    process.env[ENV] = 's';
    const warn = jest.fn();
    const hangingFetch = ((url: unknown, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    const gate = createTurnstileGate({ secretEnvName: ENV, timeoutMs: 25, logger: { warn }, fetchImpl: hangingFetch });
    const next = jest.fn();
    const started = Date.now();
    await gate(reqWith('tok'), fakeRes().res, next);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(next).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never logs the secret or the token', async () => {
    process.env[ENV] = 'super-secret-value-abc';
    const warn = jest.fn();
    const gate = createTurnstileGate({
      secretEnvName: ENV,
      logger: { warn },
      fetchImpl: (async () => { throw new Error('boom'); }) as typeof fetch,
    });
    await gate(reqWith('token-value-xyz'), fakeRes().res, jest.fn());
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).not.toContain('super-secret-value-abc');
    expect(logged).not.toContain('token-value-xyz');
  });
});
