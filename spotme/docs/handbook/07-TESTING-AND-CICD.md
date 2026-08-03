# 07 — Testing & CI/CD

> Verified against `.github/workflows/ci.yml` and `spotme/web/package.json` on
> `master` `31e1894`, 2026-08-03. Detail: `spotme/docs/08-TESTING-STRATEGY.md`.

## Web suite (`spotme/web`)

- **Runner:** `node --test`-style suites under `web/test/`, chained in the
  `test` script of `web/package.json`. On `master` there are **45** wired
  suites; a custom `check()` harness + `process.exit` pattern is also used for
  privacy/fence suites.
- **Gates:** `npm test` (all suites green) · `npm run lint` (ESLint, added #21) ·
  `npm run build` (`vite build`).
- **Fence tests** are load-bearing for dark foundations: `signing-not-shipped`
  on master, plus `discovery-v2-not-shipped` / `live-events-not-shipped` on their
  draft branches. A fence proves a subsystem is dark, not wired in, tree-shaken
  from `dist`, and secret-free — while still exercising every module.
- When adding a suite, **wire it into `package.json`** or CI will not run it.

## Backend suite (`spotme/backend`)

- **Runs against a real Postgres** (service container in CI). Without a database
  the suite reports many identical `PrismaClientInitializationError`s — do not
  mistake that for a baseline. Tests fail **loudly** when DB/S3 are absent, never
  vacuously (the reason CI exists — see the `ci.yml` header).

## End-to-end (`spotme/e2e`)

- **Playwright** foundation (#32), runs in CI. Chromium is preinstalled in the
  managed environment (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`); do not run
  `playwright install`.

## CI (`.github/workflows/`)

| Workflow | What it does |
|---|---|
| `ci.yml` | On PR and push-to-master: **backend** tests (against Postgres) + typecheck + build; **web** suite; both builds. Concurrency-cancels superseded runs. |
| `r2-smoke.yml` | S3/R2 storage smoke (MinIO in CI; R2 on demand). |

**A green check is meant to mean something** — the workflow was written
specifically to replace a preview-only "build, run zero assertions" check
(`ci.yml` header). Keep it that way: never make a suite pass by weakening it.

## The bootstrap verification (every session)

Before trusting any status line, run the checks in
[00-BOOTSTRAP](00-BOOTSTRAP.md): `git log origin/master`, list open PRs, and
`npm test && npm run lint && npm run build` in `spotme/web`. Report mismatches
before coding.
