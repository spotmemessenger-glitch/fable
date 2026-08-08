# Frontend migration — slices 0–2

**Date:** 2026-08-07 · **Branch:** `feat/slice-0-frontend-migration` · **Base:** `master` `fb2c7e0`
**Commits:** `8292e84` (0a) · `a732077` (0a report) · `6537e84` (0b)

| Slice | Verdict |
|---|---|
| **0a** — dark fences | **PASS** |
| **0b** — move, dissolve, React 19 | **PASS** (island host deferred, §0b) |
| **1** — Discovery behind flag | **SKIP — not started** |
| **2** — next screen | **SKIP — not started** |

Stopped on budget, not on a blocker. Slice 0 is complete and green; nothing is
half-applied.

---

## Slice 0a — dark fences · PASS

Five suites rewritten against a new `backend/test/helpers/fence-paths.ts`.

**Test counts:** 65/65 green, 5 suites (before: 55 passed / **10 failed**).

Two structural problems fixed:

- **Vacuity.** Every suite hardcoded `spotme/web-next` and walked it. A walk
  over a missing directory returns `[]`, so after the dissolution every
  `expect(offenders).toEqual([])` would have gone **green because it stopped
  looking**. Resolution is dynamic; `requireNonEmpty()` makes an empty scan a
  failure.
- **Windows.** 10 of 65 assertions were red before any change —
  `f.includes('/events/')` against `...\src\events\...`. Two further instances
  in `moments`: the one file *authorised* to import `bullmq` tripped its own
  `endsWith('moment-media/transcode.worker.ts')` exemption, and the positive
  control's `split('/')` returned an absolute path.

Also: deploy-config check narrowed to **git-tracked** files (a gitignored
`.vercel/project.json` from any local `vercel build` was firing); artifact scan
warns loudly instead of `return`ing silently; `appEntries()` split from
`liveEntryDarkPackageImports()` because `main.js` legitimately imports the
**legacy** `views/moments.js`.

**Tamper-check: 8/8 caught, restored-green true.** AppModule mounting
AssistantModule · outside module reaching assistant · live web module importing
a dark surface · committed root `vercel.json` · AppModule importing
EventsModule · outside module reaching exchange · a second `bullmq` importer ·
**the client surface vanishing** (the move itself, unhandled).

---

## Slice 0b — move, dissolve, React 19 · PASS

**Files moved:** 382 tracked `spotme/web` → `spotme/apps/web`; 405 renames
detected across the commit; 472 files changed.

**web-next dissolved** into `packages/ui` (`@spotme/ui`): five domain surfaces
+ 16 test files. `App.tsx`, `main.tsx`, `index.html`, `vite.config.ts` removed
— the harness that made a component library look like an app.

**React 19.** `packages/ui` 18.3.1 → 19; `react`/`react-dom` as peers. One real
break: React 19 removed the global `JSX` namespace →
`moments/components.tsx` uses `React.JSX.Element`.

### Test counts

| Surface | Before | After |
|---|---|---|
| `apps/web` | 1,085 assertions / 57 suites | **1,085 / 57**, exit 0 |
| `apps/web` lint · build | — | **0** · **0** |
| `packages/ui` | 105 passed / 4 skipped | **105 / 4** |
| ui boundary fence | 6/6 | **6/6** |
| backend dark fences | 65/65 | **65/65** |

### Four silent breaks the move caused

1. **API bridge.** `main.ts` defaulted to `join(cwd,'..','web','api')` →
   resolves to nothing after the move. Its own comment: *"the handlers simply
   never mount"* — every `/api/*` route would 404 with no error. Now
   `../apps/web/api`; `WEB_API_DIR` still overrides.
2. **The translit trap, worse than predicted.** `prebuild` tested
   `existsSync('../core')`; from `apps/web` that is `apps/core`, absent, so it
   took its **silent fallback** and built against the frozen vendored copy —
   a stale Indic transliteration engine on the composer's critical path,
   shipping quietly. Path now `../../core` **and the fallback is fatal**.
   **Proof:** `node_modules/spotme-core/core/translit.js` resolves ·
   `translit.test.js` passes · `vite build` exits 0.
3. **Conformance vectors.** Two suites read `../../docs/adr/*.md`; one more
   level of depth made those ENOENT.
4. **`clientAllRoots()` returned the package root**, which now contains
   `test/` — the discovery privacy fence began firing on the privacy tests'
   own assertions. Scoped to domain directories.

`eslint` gained `ignores: android/**, dist/**, vendor/**` — `eslint .` was
walking local Gradle output and reporting undeclared rules: red locally, green
in CI's fresh clone.

### Deferred within 0b: the island host

**Not built.** With `packages/ui` still dark there is nothing to mount, and an
unused mount point would be dead code that *trips the dark fence*
(`liveEntryDarkPackageImports()` fails the moment `apps/web/src/main.js`
imports `@spotme/ui`). The host arrives with slice 1's first real mount, behind
`spotme.ui.discovery`. Building it in 0b would have meant weakening a fence
this same PR strengthened.

### Deviation: `packages/core` not created

ADR §(c) puts controllers/ports in `packages/core` and components in
`packages/ui`. Domains are kept cohesive in `packages/ui` for now. Splitting
them would force cross-package imports that the ui boundary fence forbids
("imports limited to react/*, siblings, and type-only `@spotme/contracts`"),
so it would mean relaxing that fence for no slice-0 benefit. `packages/core`
should be created when the **app-side** framework-free extraction happens
(ADR §A.3, ~5,572 lines) — that is when it earns its existence. An empty
package now is scaffolding for later.

---

## Slices 1 and 2 — SKIP

Not started. No partial work exists on the branch: no flag, no island host, no
React Discovery, no second screen.

**Flag name reserved, unused:** `spotme.ui.discovery` (default OFF).

Slice 1 remains as ADR-035 §(e) specifies: Discovery scope-pinned to today's
live endpoints, legacy Discovery intact and rendering with the flag off,
`discovery-coarse-broadcast` (ADR-024 P0) running against **both**
implementations in one CI job. Phase 2 backend and Typesense stay unwired
(P7 = no).

---

## What a reader must do to see this

Nothing is user-visible and nothing is deployed. To verify locally:

```bash
cd spotme/apps/web && npm ci && npm test && npm run lint && npm run build
cd ../../packages/ui && npm install && npm test
cd ../../backend && npx jest test/assistant-dark-fences test/discovery-dark-fences test/events-dark-fences test/exchange-dark-fences test/moments-dark-fences
```

---

## Blockers and carried risk

**One blocker hit at push time**, plus two carried items.

### BLOCKER — `.github/workflows/ci.yml` could not be pushed

```
! [remote rejected] refusing to allow an OAuth App to create or update
  workflow .github/workflows/ci.yml without `workflow` scope
```

The CI change is **required** -- without it CI runs `working-directory:
spotme/web`, which no longer exists, and every web job fails. It is reverted on
this branch so the rest could push. **Someone with `workflow` scope must apply
these four lines before this PR can go green:**

| Line | From | To |
|---|---|---|
| `working-directory` (x2) | `spotme/web` | `spotme/apps/web` |
| `cache-dependency-path` | `spotme/web/package-lock.json` | `spotme/apps/web/package-lock.json` |
| comment | `spotme/web/eslint.config.mjs` | `spotme/apps/web/eslint.config.mjs` |

### Carried

Two items the next session must not trip over:

1. **Vercel Root Directory is still `spotme/web` on both projects and this PR
   does not change it** (hard stop: no Vercel settings change). **Merging this
   branch without repointing both projects breaks the build on both**,
   including the live production promotion on `spotme-messenger`. Root
   Directory is project-level, not per-branch, so it cannot be pre-set either —
   doing so now breaks `master`, which still holds `spotme/web`. **It must
   happen at merge, in the same window.**
2. **Pre-existing, not introduced:** `backend/src/moment-media/media.service.ts:167`
   fails `tsc` (a Prisma row type vs `MediaEdits`). The file is untouched here.

**Hard stops honoured:** no Railway or Vercel deploy · no Vercel settings
change · no merge · `spotme/app` and `spotme/mobile` untouched (P5/P6 pending)
· no Tailwind (P4) · no persisted-shape change · translit proven to resolve ·
env **names** only.
