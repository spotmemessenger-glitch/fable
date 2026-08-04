# 16 — Environment-Name Matrix

**Names only — never values.** Every environment variable the product reads,
in one table: where it is consumed, at what time (server runtime vs. web
build), and what happens when it is unset. Values live exclusively in the
host's env panel (Railway / Vercel / build env) and are **owner-set**;
committing one is a governance violation (CLAUDE.md, roadmap V2 rule 7).
`backend/.env.example` mirrors the backend + build-time names with comments.

> Created by the 2026-08-04 launch-integrations mission. The five names it
> added are marked **(new)**. Verified against `master` `64c9334` plus the
> mission's three draft PRs (#117 map tiles, #118 analytics, #119 Turnstile).

## Backend — server runtime (`spotme/backend`)

| Name | Consumer | Unset ⇒ |
|---|---|---|
| `DATABASE_URL` | Prisma | backend cannot start |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | auth tokens | insecure defaults refused in prod paths |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | auth tokens | defaults `15m` / `30d` |
| `OTP_FROM_EMAIL`, `RESEND_API_KEY` | OTP email delivery | OTP delivery unwired (dev echoes code) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | R2 media | R2 media leg off |
| `STORAGE_PROVIDER`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | storage adapter | `local` adapter |
| `FCM_SERVICE_ACCOUNT_JSON`, `APNS_KEY_ID`, `APNS_TEAM_ID` | push | vendor push legs off |
| `AGE_VERIFY_PROVIDER`, `AGE_VERIFY_API_KEY` | age-verify seam | seam off |
| `LOG_FORMAT`, `METRICS_ENABLED`, `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` | observability | every leg no-op |
| `REDIS_URL` | BullMQ `{maintenance}` queue (dark) | queue module disabled |
| `WEB_API_DIR` | bridged `web/api` handlers | repo-relative default |
| `PORT`, `NODE_ENV` | bootstrap | `4000` / `development` |
| **`TURNSTILE_SECRET_KEY`** (new) | Turnstile gate on signup/guest/OTP (ADR-032, PR #119) | **gate structurally bypassed — no behavior change** |

## Web builds — build-time injection (values become part of the bundle)

| Name | Consumer | Unset ⇒ |
|---|---|---|
| `VITE_SPOTME_SERVER` | `web` (API/socket origin) | build warns; falls back to hosted backend |
| `VITE_GMAPS_KEY` | `web` Discovery AI-Map data (Places/reviews/directions ONLY — never tiles, ADR-030) | Google-data features off |
| `VITE_CENTRIFUGO_URL` | `web` Centrifugo adapter (dark seam) | adapter unconfigured |
| **`TURNSTILE_SITE_KEY`** (new) | `web` signup widget (ADR-032, PR #119) | widget code inert; no script tag |
| **`TILES_URL`** (new) | `web-next` self-hosted map (ADR-030, PR #117) | map structurally inert; no request leaves the page |
| **`POSTHOG_KEY`** (new) | `web-next` analytics gate (ADR-031, PR #118) | analytics NOOP (also requires the compile-time flag) |
| **`POSTHOG_HOST`** (new) | `web-next` analytics host (ADR-031, PR #118) | defaults to `https://us.i.posthog.com` (owner is on US Cloud) |

## Test/CI-only

| Name | Consumer |
|---|---|
| `TEST_REDIS_URL` | backend queue smoke tests |

## Rules

1. **Adding a variable = adding a row here + a name in `backend/.env.example`**
   in the same PR. Names only; a value in either file fails review.
2. Build-time web names ship their value inside the bundle — **publishable
   config only** (URLs, hosts, and client-side keys designed to be public:
   the PostHog project key, the Turnstile *site* key, a referrer-restricted
   Maps browser key). True secrets — `TURNSTILE_SECRET_KEY`,
   `RESEND_API_KEY`, S3/R2 secrets, JWT secrets — are server-runtime only
   and must never appear in a build-time table row.
3. Every dark foundation must degrade to a no-op when its names are unset —
   that unset-column behavior is fence-tested per foundation.
