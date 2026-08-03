# 06 — Coding Standards

Grounded in `CLAUDE.md` (repo root) and the conventions observed in the merged
codebase. These are the rules a change is reviewed against.

## Universal rules (from `CLAUDE.md`)

- **Do what was asked; nothing more, nothing less.**
- **Prefer editing an existing file** to creating a new one; never create a file
  unless necessary. **Never** create documentation files unless explicitly
  requested.
- **Never** save working files or tests to the repo root — use `src/`, `test/`,
  `docs/`, `config/`, `scripts/`.
- **Always read a file before editing it.**
- **Never commit secrets, credentials, or `.env` files.**
- **Keep files under 500 lines.**
- **Validate input at system boundaries.**
- **Never add a `Co-Authored-By` trailer** to commits (unless the project's
  `.claude/settings.json` sets `attribution.commit`). No model identifiers in
  commits, PR text, code comments, or any pushed artifact.

## Frontend (`spotme/web`)

- **Vanilla JS ES modules. No UI framework, no TypeScript.** Views are built with
  a small `el()` helper and hash routing (`09-TECH-STACK.md §2`).
- **Match the surrounding code** — comment density, naming, idiom. The codebase
  favours explanatory comments that state *why*, not *what*.
- **Reference code as `path:line`.**
- The only automated gates are the **test suite** and **ESLint** — keep both
  green (see [07-TESTING-AND-CICD](07-TESTING-AND-CICD.md)).

## Backend (`spotme/backend`)

- **NestJS + TypeScript + Prisma.** Follow the existing module layout
  (`auth`, `chat`, `groups`, …). Schema changes go through Prisma migrations.
- Tests run against a **real Postgres** in CI; write them to fail loudly when a
  dependency (DB, S3) is absent, never to pass vacuously.

## Dark-shipping conventions (for platform foundations)

New platform foundations are built **dark** and must:

- Gate behind **compile-time** feature flags, all default `false`, with a hard
  **master gate** (ADR-015). Not localStorage / URL / env — so a dark build
  tree-shakes out of `dist`.
- Normalise providers through **provider-neutral contracts** (ADR-017); no vendor
  hard-coding, no credential leakage.
- Ship a **fence test** (`*-not-shipped.test.js`) proving: shipped-dark,
  not-wired-in, tree-shaken from `dist`, no secrets — while still exercising
  every module (ADR-016). Pattern reference: `web/test/signing-not-shipped.test.js`,
  `discovery-v2-not-shipped.test.js`, `live-events-not-shipped.test.js`.
- Be **deterministic and testable** — inject clocks and signals; no reliance on
  wall-clock or randomness inside pure logic.

## Git & PR discipline

- Develop on a feature/docs branch off the correct base; **never** push to a
  different branch without explicit permission.
- **Do not** create a PR unless asked; **never** merge, mark ready, or enable
  auto-merge without owner authorisation (G8).
- Draft PRs stop for owner review. Mirror any PR template the repo provides.
- If a designated branch's PR is already merged, restart from the latest default
  branch rather than stacking on merged history.
