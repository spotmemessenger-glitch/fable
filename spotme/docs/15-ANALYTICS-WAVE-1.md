# Analytics — what Wave 1 will answer (owner brief, ADR-031)

**Status: foundation built DARK** (PR `feat/analytics-posthog`). The
AnalyticsPort + closed event vocabulary exist and live call sites already go
through the seam as no-ops. PostHog receives nothing until the owner's
activation change flips `ANALYTICS_MASTER` and the build gets `POSTHOG_KEY`
(the key is already obtained; owner is on PostHog US Cloud —
`POSTHOG_HOST` defaults to `https://us.i.posthog.com`).

## The questions Wave 1 answers, and the events that answer them

**1. Retention — do people come back?**
D1 / D7 / D30 retention out of the box, from `session_start` +
`screen_view` (PostHog's retention insight on the opaque user id). This is
the launch health number: of the users who first opened the app on day 0,
how many returned on day 1, day 7, day 30.

**2. Activation funnel — where does signup lose people?**
`signup_step` with its closed steps
`started → otp_requested → otp_verified → profile_completed`, rendered as a
funnel. The drop between `otp_requested` and `otp_verified` is the OTP
delivery/UX health check; the drop before `profile_completed` is onboarding
friction.

**3. Which surfaces get used at all?**
`screen_view` across the closed screen list (discovery, events, exchange,
moments, assistant, chat, signup, settings) — a first honest picture of
where time goes after the Discovery order ships.

**4. Do the flagship interactions land?**
`feature_used` (closed names: map marker selects, discovery searches,
visibility toggles, view-mode toggles, event saves, compose opens) — counts
and per-user frequency, no content.

**5. Is anything breaking in front of users?**
`error_shown` with machine categories only (offline, provider_unavailable,
permission_required, location_unavailable, validation, unknown) per surface —
an early-warning board, not a crash logger.

## What analytics will NEVER carry (fence-tested privacy laws)

- No coordinates and no location cell ids — in any event, ever.
- No message or Moment content; no search query text.
- No age or sex/gender values.
- User id = the app's opaque id only (branded type + runtime guard); no
  email, phone, or handle. Adapter runs autocapture OFF, session recording
  OFF, pageview capture OFF, memory-only persistence (no cookies).
- The event list is CLOSED — extending it means editing the vocabulary in
  `packages/contracts/src/analytics.ts` (and its runtime mirror), visible in
  diff and reviewed.

## What activation takes (owner, later — G8)

1. Set `POSTHOG_KEY` (and optionally `POSTHOG_HOST`) in the web build env.
2. One reviewed change: flip `ANALYTICS_MASTER` in
   `web-next/src/analytics/flags.ts` and call `initAnalytics()` from the
   app wiring layer.
3. The signup surface lives in legacy `spotme/web` today — `signup_step`
   instrumentation goes in with the signup/Turnstile work when that surface
   is wired, through this same port.
