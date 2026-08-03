# @spotme/web-next — React strangler beachhead

A **React + TypeScript** surface that will, over time, take over screens from the
current vanilla-JS `spotme/web` (the strangler-fig pattern). Right now it is a
**beachhead**: one inert, read-only screen rendered from the shared
`@spotme/contracts` types, proving the React surface consumes the same domain
contracts as the rest of the platform.

## Status — inert and isolated

- **Not deployed.** The Vercel project is rooted at `spotme/web` (see
  `spotme/web/vercel.json`, whose build is `vite build` in that directory).
  `web-next` is a sibling directory outside that root, so the Vercel build never
  sees it. It has no production host of its own.
- **Not referenced by `spotme/web`.** Nothing in the running app imports it; it
  is a standalone Vite app with its own `package.json`.
- **Inert.** The single screen (`src/App.tsx`) has no state, no handlers, no
  network, no routing. It renders a hardcoded `ExchangeItemPublic`.

## Develop

```bash
cd spotme/web-next
npm install
npm run typecheck   # tsc --noEmit — strict
npm run build       # vite build — proves it is self-contained
npm run dev         # local only
```

The `@spotme/contracts` import is aliased (tsconfig `paths` + Vite `resolve.alias`)
to `../packages/contracts/src/index.ts`. Those imports are type-only, so the
runtime bundle contains none of the contracts source.

## Isolation fence (`npm test`)

`scripts/check-boundaries.mjs` (6/6) proves the isolation instead of promising
it: no imports from legacy `spotme/web`/`spotme-core` · no backend calls or
network primitives · no routing integration · no authentication or credential
storage · imports limited to `react/*`, siblings, and **type-only**
`@spotme/contracts` · non-vacuous. Then `tsc --noEmit` and `vite build`.

## Vercel gate (verified read-only, 2026-08-03)

No repo-root or `spotme/`-level `vercel.json` exists; the only Vercel config is
`spotme/web/vercel.json`, whose build runs relative to `spotme/web`. The
project root is `spotme/web` (its vendored-core arrangement exists precisely
because siblings are not uploaded). `web-next` is a sibling → **not
discovered, not built by Vercel**. No Vercel configuration was changed.
