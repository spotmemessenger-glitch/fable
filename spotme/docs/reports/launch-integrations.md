# Launch Integrations — Final Report (2026-08-04)

**Mission:** tiles + analytics + bot protection — three light-tier parts, each
its own draft PR off `master` (`64c9334`), all **dark and additive**.
**Nothing merged; nothing activated; no flag flipped; no deploy; no Railway
variable touched; no credential value anywhere** (env NAMES only). The
isolation rule held: nothing belonging to Activation Wave 0 was created,
modified, or read-modified (no `feat/activation-wave-0`, no `docs/ops/*`, no
health/ready endpoints, no Railway config; backend source changes are limited
to the Turnstile middleware and its AuthModule wiring).

## The three draft PRs

| Part | PR | Head branch | Decision (ADR, in the PR) |
|---|---|---|---|
| 1 — Map tiles | **#117** | `feat/map-tiles-selfhosted` | **ADR-030** — MapLibre GL + Protomaps-schema PMTiles self-hosted on the existing R2 bucket; `TILES_URL`; the Google key stays licensed ONLY for AI-Map data (Places, reviews, directions), never tiles |
| 2 — Analytics | **#118** | `feat/analytics-posthog` | **ADR-031** — PostHog (owner on US Cloud) behind a closed-vocabulary `AnalyticsPort`; NOOP default; flag+key gate |
| 3 — Bot protection | **#119** | `feat/auth-turnstile` | **ADR-032** — Cloudflare Turnstile on signup/guest/OTP; structural bypass without key; timeout-safe fail-open on outage |

Decisions are recorded in `handbook/DECISIONS.md` (2026-08-04 section); ADR
index rows added (`adr/README.md`); status rows added
(`handbook/03-IMPLEMENTATION-STATUS.md`); env names added to
`backend/.env.example` per part and to the new matrix
(`16-ENV-NAME-MATRIX.md`): `POSTHOG_KEY`, `POSTHOG_HOST` (default
`https://us.i.posthog.com`), `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`,
`TILES_URL`.

## Evidence per part

Baseline before any change (fresh clone + local PostGIS via the hand-written
migrations): backend jest **52 suites / 517 tests green** (5 suites skipped —
they need Redis/MinIO, the CI-only legs), web full chain + lint + build green,
web-next 6/6 fence + typecheck + 105→ unit tests + build green, contracts
green.

**Part 1 — #117 (map tiles).**
- `web-next/src/map/`: `TileMapView` prop-compatible with `discovery/MapView`
  (the activation-time swap point); light+dark base styles (muted,
  teal-accent-compatible) over the Protomaps schema; `tiles-config.ts`
  resolving build-time `TILES_URL`; glyphs under the same R2 base — one host.
- Structural darkness: unset `TILES_URL` ⇒ no maplibre Map constructed, no
  pmtiles protocol registered, no request; and nothing mounts the component
  (App/DiscoveryShell untouched).
- Fixture: `test/fixtures/sample.pmtiles`, a **344-byte deterministic PMTiles
  v3 archive** (generator committed) parsed by the real pmtiles reader in
  tests — no multi-GB extract in repo or CI. Owner runbook:
  `web-next/scripts/build-tiles.md` (extract, fonts, R2 upload, CORS,
  size/cost ≈ $0.02–0.05/mo storage, zero egress).
- Fences: `map-not-shipped` (not mounted; no third-party tile host —
  mapbox/google/maptiler/… — in source; maplibre/pmtiles confined to
  `src/map/`) + post-build `check-map-artifact.mjs` (no renderer, no tile
  host in `dist/`). **Production bundle byte-identical to baseline**
  (`index-DJxd67la.js`, 161.10 kB) — fully tree-shaken while dark.
- Green: web-next fence 6/6 · typecheck · 130 tests · build · artifact fence;
  backend dark fences 63/63.

**Part 2 — #118 (analytics).**
- `@spotme/contracts/analytics`: `AnalyticsPort` + CLOSED vocabulary
  (`screen_view`, `signup_step`, `session_start`, `feature_used{name}`,
  `error_shown`) — names, keys AND values are finite unions; branded
  `OpaqueAnalyticsUserId`.
- Privacy laws three ways: compile-time negatives (coordinates/cell ids/query
  text/content/age-sex/free bags/raw ids **unrepresentable**), a runtime
  guard in front of every sink (`AnalyticsPrivacyError`), and adapter
  hardening (autocapture off, pageview off, session recording off,
  memory-only persistence, identified-only profiles).
- Gate: compile-time `ANALYTICS_MASTER=false` AND `POSTHOG_KEY` presence —
  both absent; `initAnalytics` called by nothing live. Baseline
  instrumentation runs through the seam in `App.tsx` as no-ops (assistant
  surface deliberately skipped — its fence pins an import allow-list).
- Fences: `analytics-not-shipped` + post-build `check-analytics-artifact.mjs`
  — **no PostHog SDK/host/key in `dist/`**.
- Owner brief `docs/15-ANALYTICS-WAVE-1.md`: D1/D7/D30 retention, the
  signup funnel, surface usage, feature adoption, error board.
- Green: web-next fence 6/6 · typecheck · 132 tests · build · artifact fence;
  contracts suite; backend dark fences 63/63.

**Part 3 — #119 (Turnstile).**
- Backend `src/middleware/turnstile.ts` + `AuthModule` wiring on
  `auth/signup`, `auth/guest` (the live signup), `auth/otp/request`,
  `auth/otp/verify`: (1) **structural bypass** when `TURNSTILE_SECRET_KEY`
  absent — proven with zero fetch calls; (2) **timeout-safe (3 s) + FAIL-OPEN**
  on outage/5xx/hung-verify with one logged warning that never contains the
  secret or token; (3) fail-closed on verdicts (missing token /
  `success:false` ⇒ 403). Token in the `cf-turnstile-response` header — DTOs
  and the `forbidNonWhitelisted` pipe untouched.
- Web: presence-gated invisible widget (`appearance: 'interaction-only'`) in
  the onboarding signup form; token attach in `guestAuth` (fresh single-use
  token for the 409 retry); **a11y fallback documented** (Cloudflare's
  accessible checkbox appears in-form when interaction is required; failure
  degrades to a server 403, never a locked UI).
- Green: unit + real-HTTP e2e 14/14 (bypass, fail-open, verdicts, ungated
  refresh control); **backend full suite 54 suites / 531 tests**; backend
  build; web full chain (ends `turnstile-gate` 12/12) · eslint · build.

## Validation summary (per part, at its branch head)

- Full suites green: backend jest, web ~50-suite chain + eslint + build,
  web-next chain (boundaries → typecheck → unit → build → artifact fence),
  contracts. All pre-existing dark fences green (backend 63/63 across the
  five platform fence suites; web `*-not-shipped` in the chain).
- Typechecks + builds green in every touched workspace.
- Artifact scans: no tile/analytics code in the production web-next build
  while dark; no Turnstile activation without keys; no third-party tile host
  anywhere; no secret literals (fence-scanned).
- Env-name matrix created (`16-ENV-NAME-MATRIX.md`); names in
  `backend/.env.example`; values nowhere.

## Merge-sequencing note for the owner

#117 and #118 both touch `web-next/package.json` (deps + test chain) and
`scripts/check-boundaries.mjs` rule 5. Whichever merges second has a trivial
mechanical conflict: **keep both** allow-list sets and **keep both** artifact
fence steps. #119 is independent of both.

## Exact owner follow-ups (activation is separate, G8)

1. **Turnstile:** create a Turnstile site in the Cloudflare dashboard (same
   account as TURN/R2) → obtain the **2 keys** → at activation set
   `TURNSTILE_SITE_KEY` in the web build **first** (or same deploy), then
   `TURNSTILE_SECRET_KEY` on the server (the gate fails closed for tokenless
   clients once the secret exists).
2. **PostHog:** key already obtained (US Cloud). At activation set
   `POSTHOG_KEY` in the web-next build env (host defaults to
   `https://us.i.posthog.com`) and flip `ANALYTICS_MASTER` + call
   `initAnalytics()` in one reviewed change.
3. **Tiles:** produce the India PMTiles extract per the runbook
   (`web-next/scripts/build-tiles.md`: `pmtiles extract` from the Protomaps
   daily build, or Planetiler) → upload archive + fonts to the R2 bucket →
   set `TILES_URL` → a later G8 change swaps `TileMapView` into
   `DiscoveryShell`.

**Mission complete. Three draft PRs open (#117, #118, #119). Nothing merges.**
