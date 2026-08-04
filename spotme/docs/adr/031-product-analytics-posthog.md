# ADR-031 — Product analytics: PostHog behind a closed-vocabulary AnalyticsPort

**Status: Accepted — owner decision recorded by the 2026-08-04 launch-integrations
mission (tiles · analytics · bot protection).** · **Date:** 2026-08-04
**Relates to:** ADR-015 (compile-time flags), ADR-017 (provider-neutral
adapters), Roadmap V2 rule 7 (security-sensitive state never reaches
analytics), `docs/15-ANALYTICS-WAVE-1.md` (what Wave 1 answers).

> Ships dark: NOOP adapter is the default, the compile-time flag is false,
> nothing calls init, and the built bundle carries no PostHog SDK/host/key
> (artifact-fenced). Activation is a separate owner-authorised change (G8).

## Context

Launch needs D1/D7/D30 retention and an activation funnel, or the team flies
blind. But this product's core promise is privacy; a typical analytics rollout
(autocapture, session replay, raw properties bags) would silently hoover up
coordinates, search text, and message content. The owner selected PostHog
(US Cloud; key already obtained) with a free tier that comfortably covers
launch volume.

## Decision

- **PostHog is an adapter behind `AnalyticsPort`** (`@spotme/contracts/analytics`),
  never a direct import at a call site. The NOOP adapter is the default sink.
- **Events are a CLOSED vocabulary**: `screen_view`, `signup_step`,
  `session_start`, `feature_used{name}`, `error_shown` — names, property keys
  AND property values are finite unions in contracts, mirrored by a runtime
  guard that rejects everything else before any sink. Adding an event means
  editing the closed lists — visible in diff.
- **Privacy laws (compile-time negatives + runtime guard + fences):** no
  coordinates, no location cell ids, no message/Moment content, no search
  query text, no age/sex values; user id = the app's opaque id only (branded
  type). Adapter config: autocapture off, pageview/pageleave off, session
  recording off, memory-only persistence, person profiles for identified only.
- **Gate: compile-time `ANALYTICS_MASTER` AND `POSTHOG_KEY` presence.** Env
  names `POSTHOG_KEY` / `POSTHOG_HOST` (default `https://us.i.posthog.com`),
  build-time, names-only in the repo.

## Consequences

- Wave 1 gets retention + funnel + surface usage with a bounded, reviewable
  data surface; adding any richer telemetry forces a contract edit and review.
- PostHog is replaceable behind the port (rule 8); switching providers or
  self-hosting later touches one adapter file.
- The closed vocabulary will feel restrictive — that is the design. Free-form
  properties are the leak vector this ADR exists to prevent.

## Evidence

- `packages/contracts/src/analytics.ts` + `test/analytics-negative.test.ts`
  (compile-time: coordinates/query/content/age-sex/ad-hoc names unrepresentable).
- `web-next/src/analytics/` (`index.ts` seam + runtime guard, `posthog.ts`
  adapter, `init.ts` gate, `flags.ts` ADR-015-style flag).
- `web-next/test/analytics-{privacy,init,not-shipped}.test.ts`;
  `web-next/scripts/check-analytics-artifact.mjs` (post-build: no PostHog in dist).
- Baseline call sites through the seam in `web-next/src/App.tsx` (no-op dark).
- Env names in `backend/.env.example`; owner brief `docs/15-ANALYTICS-WAVE-1.md`.
