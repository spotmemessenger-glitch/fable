# @spotme/contracts

Shared TypeScript domain types for Spot Me — the single source of truth for
cross-surface contracts. **Types only:** no runtime code, no dependencies,
nothing imported by the running product yet. New TypeScript surfaces
(`packages/*`, `spotme/web-next`, and — over time — the backend) consume these
instead of redefining shapes.

## Contents

- **`src/location.ts`** — location/privacy contracts mirroring the on-device
  coarsening boundary (ADR-018/024): `PreciseLocation` never leaves the device;
  only `CoarseLocation` is shareable. The coarsening *algorithm* is owned by
  `spotme/web/src/lib/discovery.js` and deliberately not duplicated here.
- **`src/exchange.ts`** — Exchange intent shapes mirroring the PRD (§8.3 /
  DB schema): items, structured intents, matches, search envelopes. No shape
  exposes a precise location, by construction.

## Guarantees (fenced, not promised)

`npm test` runs three gates, and CI runs them on every PR
(`.github/workflows/platform-contracts.yml`):

1. **`check:boundaries`** — no browser globals; no NestJS/Prisma/generated-client
   imports; no imports from `spotme/web`, `spotme/backend`, or `spotme-core`;
   every import is `import type` from a sibling; zero runtime dependencies.
2. **`typecheck`** — strict `tsc --noEmit` over src + usage examples
   (`test/types.test.ts`).
3. **`build:types`** — declaration output (`.d.ts` + maps) emits cleanly to
   `dist/` (gitignored), so downstream tooling can consume typed declarations.
