/**
 * Cloudflare Turnstile verification gate for the signup/OTP surface (ADR-032).
 *
 * THE POSTURE IS THE POINT, in three rules:
 *
 *   1. STRUCTURALLY BYPASSED WITHOUT A KEY. When TURNSTILE_SECRET_KEY is
 *      absent (today: everywhere), the gate calls next() before touching the
 *      request — no header requirement, no network, no behavior change.
 *      Adding the key is the activation switch, and it is owner-only.
 *   2. FAIL-OPEN ON OUTAGE. Turnstile being down must never lock users out
 *      of signup: a timeout, network error, or 5xx from siteverify logs ONE
 *      warning and lets the request through. Whatever rate limiting protects
 *      these routes continues to apply — this gate only ever ADDS friction
 *      for bots, never a new outage mode for humans.
 *   3. FAIL-CLOSED ON A FAILED CHALLENGE. When the key is present and
 *      Cloudflare answers `success: false` — or the client sent no token at
 *      all — the request is refused with 403. A verdict is not an outage.
 *
 * The token travels in the `cf-turnstile-response` HEADER (Cloudflare's own
 * field name), never the body: the global ValidationPipe runs with
 * `forbidNonWhitelisted`, and a body field would bounce off every DTO.
 *
 * Secrets hygiene: the secret is read from the environment at REQUEST time
 * (so tests and rotation see changes) and never logged; neither is the token.
 *
 * Lives in src/ for the same reason guestAuth.ts does: `nest-cli.json` sets
 * `rootDir: src`, and a gate outside src never reaches dist — a gate that is
 * not invoked is worse than no gate.
 */

export const TURNSTILE_HEADER = 'cf-turnstile-response';
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** The slices of req/res this gate touches — nothing else is its business. */
export interface TurnstileRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}
export interface TurnstileResponse {
  status(code: number): TurnstileResponse;
  json(body: unknown): unknown;
}

export interface TurnstileGateOptions {
  /** Env NAME holding the secret (default TURNSTILE_SECRET_KEY). Name only —
   *  the value is owner-set in the host's env panel, never in the repo. */
  secretEnvName?: string;
  /** Verify-call budget. Past it the gate fails OPEN. */
  timeoutMs?: number;
  /** Test seams. fetchImpl defaults to global fetch, resolved per request. */
  fetchImpl?: typeof globalThis.fetch;
  logger?: { warn(message: string): void };
  verifyUrl?: string;
}

export function createTurnstileGate(opts: TurnstileGateOptions = {}) {
  const envName = opts.secretEnvName ?? 'TURNSTILE_SECRET_KEY';
  const timeoutMs = opts.timeoutMs ?? 3000;
  const verifyUrl = opts.verifyUrl ?? TURNSTILE_VERIFY_URL;
  const logger = opts.logger ?? console;

  return async function turnstileGate(
    req: TurnstileRequest,
    res: TurnstileResponse,
    next: () => void,
  ): Promise<void> {
    const secret = process.env[envName] || '';
    if (!secret) return next(); // structurally bypassed — nothing changes until the owner adds keys

    const raw = req.headers[TURNSTILE_HEADER];
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (!token) {
      res.status(403).json({ error: 'turnstile_required' });
      return;
    }

    const f = opts.fetchImpl ?? globalThis.fetch;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const body = new URLSearchParams({ secret, response: token });
      if (req.ip) body.set('remoteip', req.ip);
      const answer = await f(verifyUrl, { method: 'POST', body, signal: abort.signal });
      if (!answer.ok) {
        // Cloudflare responded but unwell — an outage shape, not a verdict.
        logger.warn(`turnstile: siteverify answered ${answer.status} — failing OPEN`);
        return next();
      }
      const verdict = (await answer.json()) as { success?: boolean };
      if (verdict.success === true) return next();
      res.status(403).json({ error: 'turnstile_failed' });
    } catch {
      // Timeout or network failure — Turnstile outage must not block signup.
      logger.warn('turnstile: verification unreachable or timed out — failing OPEN');
      return next();
    } finally {
      clearTimeout(timer);
    }
  };
}
