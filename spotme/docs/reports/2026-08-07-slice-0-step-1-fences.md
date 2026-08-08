# Slice 0, step 1 — the dark fences now survive the move, and run at all

**Date:** 2026-08-07 · **Branch:** `feat/slice-0-frontend-migration` · **Base:** `master` `fb2c7e0`
**Commit:** `8292e84` · **Governs:** [ADR-035](../adr/035-frontend-migration-plan.md) (ACCEPTED)

**Status: step 1 COMPLETE and verified. Steps 2–6 NOT done.** The mission gates
everything behind step 1 ("if this step doesn't land clean, stop and report").
It landed clean. This report says what that cost, what it found, and two things
the owner needs before step 2 runs — one of which is a production hazard in the
mission's own step 4.

---

## 1. What landed

One new helper (`backend/test/helpers/fence-paths.ts`, 226 lines) and the five
suites rewritten against it. **65/65 green across 5 suites.** Tamper-checked
8/8. Web suite unchanged at **1,085 assertions, exit 0**.

### The vacuity hazard — the reason this step existed

Every suite hardcoded `spotme/web-next` and walked it. ADR-035 dissolves
web-next into `packages/{ui,core}`, and **a walk over a missing directory
returns `[]`** — so every `expect(offenders).toEqual([])` would have gone
**green precisely because it had stopped looking.** The five suites that are the
only thing keeping Phase 2–6 dark would have disarmed themselves during the
move and reported success.

Fixed two ways: resolution is dynamic (web-next today, `packages/` tomorrow),
and `requireNonEmpty()` makes an empty scan a **failure**. Tamper case 8 proves
it — hiding the client surface turns the fence red, not silently clean.

### The fences could not run on Windows at all

**10 of 65 assertions failed before I touched anything**, none for a real
reason. Filters were written `f.includes('/events/')` against
`...\src\events\...`, so a domain's own files were never excluded from "no
module OUTSIDE this domain reaches in" — and then matched it trivially.

The same bug appeared twice more in `moments`, both in places designed to make
the fence *precise*:

- `endsWith('moment-media/transcode.worker.ts')` — the **one file authorised**
  to own the bullmq queue tripped its own exemption.
- `f.split('/').slice(-2)` in the positive control returned a full absolute
  path.

This is worth more than a convenience fix. **A permanently-red fence is one
people learn to scroll past**, and it cannot be tamper-checked at all — you
cannot demonstrate that a test fails when violated if it already fails when it
isn't. The rewrite was unverifiable until this was fixed.

### Three further weakenings, each fixed

| Was | Why it was weak | Now |
|---|---|---|
| Deploy-config check used `existsSync` | Fired on a **gitignored** `.vercel/project.json` left by any local `vercel build` — false red on a dev machine, absent in CI | **Tracked files only** — only a committed config can reach a deployment. Widened to bar `packages/ui`/`packages/core` and to scan `rootDirectory` |
| Artifact scan `return`ed silently with no build | Reads identically to a clean scan in the output | Warns **loudly**, resolves any client `dist` |
| `appEntries()` folded the live app entry in with the React harness | `web/src/main.js` legitimately imports `./views/moments.js`, the **legacy** Moments view shipped in PR #126. "MomentsShell is not mounted" ≠ "the word moments appears nowhere" | Split: harness entries vs `liveEntryDarkPackageImports()`, which matches **package specifiers** |

That last one was my own error, caught by the tamper run rather than by review.

### Tamper-check — 8/8 caught, all restored green

| Violation introduced | Fence |
|---|---|
| `AppModule` mounts `AssistantModule` | assistant |
| An outside backend module reaches the assistant subtree | assistant |
| A live web module imports a dark client surface | discovery |
| A **committed** `vercel.json` appears at the repo root | discovery |
| `AppModule` imports `EventsModule` | events |
| An outside module reaches the exchange subtree | exchange |
| A **second** file imports `bullmq` | moments |
| **The client surface vanishes** (the ADR-035 move, unhandled) | moments |

Harness was a throwaway in the session scratchpad, never committed. Every case
restores in a `finally`, and the run ends by re-proving all five suites green —
`restored-green: true`.

---

## 2. STOP before step 4 — it would break production

**The mission's step 4 (set Vercel Root Directory to `apps/web` on both
projects) must NOT run while this PR is unmerged.** I did not do it.

Vercel's Root Directory is **project-level, not per-branch.** Setting it to
`apps/web` now, with `master` still holding `spotme/web`, makes the next
`master` build fail on both projects — including the **live production
promotion** on `spotme-messenger`.

That also contradicts the mission's own step 5, which asks me to verify that
promotion still shows `githubDeployment: 1` and `githubCommitRef: master`.
Doing step 4 now is what would break the thing step 5 checks.

**Correct sequencing:** the Root Directory change happens **at merge**, as
close to it as possible, on both projects. It is the one irreversible-feeling
step and it belongs with the merge, not with the branch. Between the two there
is an unavoidable window; keeping it short is the whole mitigation.

Note this is *not* the P10 question. Repointing **both** projects — as the
mission specifies — neutralises P10 rather than betting on it, which is the
right call and worth keeping.

---

## 3. Step 2 scope, measured

Enumerated so the next session executes rather than explores.

- **`spotme/web` → `apps/web`: 382 tracked files.** Includes `android/` (a full
  Gradle project), `api/` (8 serverless functions), `vendor/spotme-core/`.
- **27 tracked non-doc files reference `spotme/web` paths** and must move with
  it: `.github/workflows/ci.yml`, `backend/.env.example`,
  `backend/package.json`, 6 backend `src/` files, 4 of the fence suites + the
  new helper, `packages/contracts` (3 files), `server/deploy.sh`, `web-next`
  (5 files), and 3 `web/test` harnesses.
- **4 CI workflows**; `ci.yml` alone has 2 `working-directory: spotme/web`
  plus a `cache-dependency-path`.
- **9 text fences** in the web suite pin `spotme/web/src/...` as strings.

### The translit trap is real and the mission is right to call it out

`web/package.json`'s `prebuild` does `existsSync('../core')` — from
`spotme/web` that resolves to `spotme/core`. **From `apps/web` it resolves to
`apps/core`, which will not exist**, so the script takes its silent fallback
("`../core` absent — using committed vendor copy") and the build proceeds
against a **stale vendored copy** rather than failing.

`web/src/app.js:10` and `views/chat.js:20` import
`spotme-core/core/translit.js` — the Indic engine on the composer's critical
path. The failure mode is not a broken build; it is transliteration silently
served from a frozen copy. **The fallback must become loud, or the path must
be made explicit, and a test must prove which copy resolved.**

---

## 4. Not done, stated plainly

Steps 2, 3 (as executable work), 4, 5 and 6's PR body cover work that is not in
this branch. Nothing was half-moved: `spotme/web` and `spotme/web-next` are
untouched, so the tree is in its pre-move state with strictly better fences.

**Hard stops honoured:** `spotme/app` and `spotme/mobile` untouched (P5/P6
pending); no Tailwind (P4 deferred); no persisted-shape change; no UI behaviour
change; env **names** only; nothing merged; no Vercel configuration altered.

**Why stop here rather than start the move:** a monorepo move of 382 files with
27 dependent references, 4 CI workflows and a live deploy path is not something
to leave half-applied. A partially-moved tree builds neither way. Step 1 was
built as the gate precisely so this call could be made at a clean boundary, and
it is a better handoff than a stalled move.

---

## 5. Verification

| Check | Result |
|---|---|
| 5 fence suites | **65/65 green** — first clean Windows run |
| Tamper-check | **8/8 caught**, `restored-green: true` |
| `tsc --noEmit` (backend) | clean |
| Web suite | **1,085 assertions, exit 0** — unchanged |
| Backend full suite | 45 passed / 23 failed — **all 216 failure messages are `Can't reach database server`** (no local Postgres). All five fence suites are in the passing set. |
| Working tree | no tamper residue; `spotme/web-next/src/moments` restored; no stray `vercel.json` |

The backend red is environmental and pre-existing, not introduced here — the
changes touch six test files, five of which pass, and a helper nothing else
imports.

---

## 6. Open for the owner

| # | Item |
|---|---|
| **Step 4 timing** | Confirm the Root Directory change moves to **merge time** on both projects, per §2. |
| P10 | Still open. Step 4 repointing **both** projects neutralises it for slice 0, but it still governs P9 (which project to retire). |
| P5 / P6 | Still **PENDING** — untouched here. |
| P11 | Characterization tests before each rewrite: still unanswered, and it sets step 2's cost. |
