# ADR-032 — Bot protection: Cloudflare Turnstile on the auth surfaces

**Status: Accepted — owner decision recorded by the 2026-08-04 launch-integrations
mission (tiles · analytics · bot protection).** · **Date:** 2026-08-04
**Relates to:** the auth surface (`backend/src/auth/`), the guest-auth gate
precedent (`backend/src/middleware/guestAuth.ts`), and the tech-stack known
gap "Rate limiting: none anywhere" (`docs/09-TECH-STACK.md` §11 — Turnstile
complements, does not replace, that missing layer).

> Ships dark by key-absence: the middleware is structurally bypassed until
> the owner creates a Turnstile site and sets keys. Activation = adding the
> keys (owner-only; G8).

## Context

Signup and OTP are the abuse funnel of any launch: bot-created accounts spam
Discovery, and unmetered OTP requests burn email quota (and later SMS money).
The product already runs on Cloudflare (TURN, R2), and Turnstile is free,
CAPTCHA-less for the overwhelming majority of humans, and verifiable
server-side with one HTTPS call — no vendor SDK on the server.

## Decision

- **Cloudflare Turnstile on the account-creation surface**: `auth/signup`,
  `auth/guest` (the live app's real signup), `auth/otp/request`,
  `auth/otp/verify`. Refresh/employee-login are not challenged (they already
  require a credential).
- **Three-rule posture** (`backend/src/middleware/turnstile.ts`):
  1. **Structurally bypassed** when `TURNSTILE_SECRET_KEY` is absent — next()
     before touching the request; nothing changes until the owner adds keys.
  2. **Timeout-safe and FAIL-OPEN on outage** — a 3 s verify budget; timeout,
     network failure, or 5xx logs one warning and admits the request. Existing
     rate limits continue to apply; Turnstile only ever adds bot friction,
     never a new outage mode for humans.
  3. **Fail-closed on verdicts** — missing token or `success:false` ⇒ 403.
- **Token travels in the `cf-turnstile-response` header** (Cloudflare's own
  field name) — the global ValidationPipe's `forbidNonWhitelisted` stays
  untouched, and no DTO changes.
- **Client: invisible mode with an a11y fallback** (`web/src/lib/turnstile.js`):
  `appearance: 'interaction-only'` renders nothing while Cloudflare clears the
  browser silently; when interaction is required, Cloudflare's standard
  checkbox (keyboard/ARIA/localised) appears inside the signup form. Token
  acquisition failure degrades to a server-answered 403, never a locked UI.
  The widget mounts only when `TURNSTILE_SITE_KEY` is present at build.
- **Env names** `TURNSTILE_SECRET_KEY` (server) and `TURNSTILE_SITE_KEY`
  (web build) — names only in the repo; values owner-set.

## Consequences

- Activation is deliberately two-sided: the server gate fails CLOSED for
  tokenless requests once the secret exists, so the owner must ship the web
  build with the site key **first** (or same deploy), then set the secret.
  The activation checklist in the PR records this ordering.
- A Turnstile outage degrades to "no bot check" (fail-open) rather than "no
  signups" — accepted trade, mitigated by the (future) rate-limit layer.
- Tokens are single-use; flows that retry (guest 409 rename) mint a fresh
  token per attempt — implemented client-side.

## Evidence

- `backend/src/middleware/turnstile.ts` + wiring in `auth.module.ts`.
- `backend/test/turnstile.spec.ts` (fixture-response units: bypass proven, no
  fetch without key; fail-open on outage/5xx/timeout with a logged warning
  that never contains the secret or token; 403 verdicts).
- `backend/test/turnstile-auth.e2e-spec.ts` (real HTTP through the real app:
  all five postures + ungated refresh).
- `web/src/lib/turnstile.js`, onboarding mount in `web/src/main.js`, header
  attach in `web/src/lib/socket-transport.js`;
  `web/test/turnstile-gate.test.js` (12 checks incl. node-context inertness
  and the no-secret-in-client fence).
- Env names in `backend/.env.example`.
