# Migration Phase 0 — what I read, what I found, what I recommend

**Date:** 2026-08-07 · **Branch:** `master` · **Verified at:** `772a92a`
**Deliverable:** [ADR-035 — Frontend migration to React + TypeScript](../adr/035-frontend-migration-plan.md) (Status: **PROPOSED**)
**Mission constraints honoured:** no application code, no `package.json`
changes, no new dependencies, no merges, `claude/vercel-token-connection-bj4d21`
untouched, environment variables referenced by **name only**.

---

## 0. The first finding: the tree was 48 commits stale

Before anything else — the working tree started this mission at `43d7dea`,
**48 commits behind `origin/master`**. The inventory I began taking was of a
repository state that has not existed since 2026-08-06.

Missing locally were PR #131 (the LiveKit calls stack), #132 (design tokens,
self-hosted fonts, Indic coverage), #133 (ADR-034), #134 and #135 (push env
names). Concretely, the stale tree still showed `trystero` and
`@trystero-p2p/torrent` as live dependencies of `spotme/web` — the P2P stack
that **ADR-033 removed**. Any inventory taken from it would have been wrong
about the transport layer, wrong about the design system, and wrong about the
next free ADR number.

Per CLAUDE.md bootstrap step 8 I stopped, reported, and fast-forwarded
(`git merge --ff-only`, no merge commit, tracked tree was clean) to `772a92a`.
**Everything below is measured at `772a92a`.**

Second, smaller mismatch: `docs/adr/README.md` is **stale**. Its index table
ends at ADR-028 and does not list ADR-029 (18+ age gate), ADR-033 (server-only
transport) or ADR-034 (orange accent contrast), all of which exist on disk.
Numbers 030–032 were never used. The new ADR therefore takes **035**, and the
index needs a separate repair PR.

---

## 1. What I read

| Source | Why it mattered |
|---|---|
| `CLAUDE.md` (root + `spotme/`) | Bootstrap protocol; the "repository is truth" rule that caught the stale tree |
| `docs/adr/027-mobile-native-boundary.md` | The Capacitor question in the mission brief — resolved in §3 below |
| `docs/handbook/PLATFORM-PHASE-1..6-PROGRAMME.md` | Where every React artifact came from and why each is dark |
| `docs/handbook/DECISIONS.md` | Owner-retained vs delegated authority; D6/D7/A3/A5 constraints |
| `docs/adr/033-server-only-transport-migration.md` | Made `spotme/app` legible as dead code |
| `spotme/web-next/` — README, `package.json`, `App.tsx`, `src/discovery/*`, `scripts/check-boundaries.mjs` | What the beachhead actually is (and is not) |
| `spotme/web/src/` — all 80 non-empty files | The inventory |
| `spotme/web/test/` — all 56 suites | Coverage mapping, test-kind classification |
| `spotme/packages/contracts/`, `spotme/web/vercel.json`, `spotme/app/`, `spotme/mobile/` | Layout, deployment, the mobile question |
| PR #132 (via `gh pr view`) | The design-token contract the migration must carry |

Verification run, not assumed: `npm test --prefix spotme/web` → **1,077
assertions, exit 0**, 56 suites.

---

## 2. What I found

### 2.1 The framework-free layer is bigger and cleaner than expected

**~5,518 lines move to a shared package with no edit at all.** I verified this
two ways rather than by inspection: a DOM-reference grep, and an import-graph
trace proving these modules reach only `../api.js`, `../auth-headers.js`,
`../socket-transport.js` and their own siblings — never `lib/ui.js`, never
`views/`.

| Group | Files | Lines |
|---|---:|---:|
| `lib/crypto/*` (x3dh, ratchet, safety-number, signing-*, identity-*, e2e-v2) | 13 | ~3,767 |
| `lib/transport/*` (ITransportAdapter, socketio, centrifugo, index, room) | 5 | 597 |
| API clients (`api`, `auth-headers`, `moments-api`, `discovery-api`, `groups-api`, `group-perms`) | 6 | 482 |
| `lib/calls/livekit-media.js` | 1 | 327 |
| `lib/ai/*` | 4 | 162 |
| Pure logic (`english`, `photos`, `voice`) | 3 | 183 |

Three crypto modules matched the DOM grep once each — all three hits are prose
inside comments explaining *why IndexedDB and not localStorage*. They are clean.

This is the migration's best news: **the highest-risk code in the product is
the code the migration does not have to touch.** It is also the most heavily
tested code in the repository.

### 2.2 There is no view-level test coverage anywhere

All 14 views build DOM imperatively through `el()` from `lib/ui.js` — **950
call sites**, 10,751 lines of view JS. Not one has a direct unit test. Every
one of the 1,077 assertions sits either below the view layer or in a text
fence.

This is the dominant risk in the whole programme, and it is not visible from
the test count. A React rewrite of any screen has **no behavioural safety net
at the layer being rewritten**. It is why ADR-035's definition of done has nine
items rather than three.

### 2.3 Nine text fences pin source paths as strings

`signing-not-shipped`, `e2e-v3-not-shipped`, `ai-gateway-not-shipped`,
`moments-nav-fence`, `moments-home`, `design-tokens-fence`,
`discovery-coarse-broadcast`, plus the backend's five `*-dark-fences.spec.ts`,
read source files **as text** and assert structure.

Any file move breaks all of them simultaneously — and worse, a careless repair
makes one pass *vacuously*. This repository has already been bitten by exactly
that: #132 records that the token fence's first draft skipped codepoints below
U+2000 "to step over ASCII", which silently skipped Devanagari and Tamil too —
every script it existed for — and passed green.

The five backend dark-fence suites are the sharper problem: they assert
web-next's **isolation and non-deployment**. Dissolving web-next into
`packages/` invalidates their premise. If they are not rewritten first, Phase
2–6 darkness stops being enforced at the moment the migration starts.

### 2.4 `spotme/web-next` is a component library, not an application

React 18.3.1, 34 source files, 105 tests, five domain shells, one consistent
architecture (pure components ← framework-free controller ← injected ports).
`App.tsx` mounts **Discovery only**; the other four are deliberately
unreferenced.

No router, no auth, no backend, no deployment. Calling it "the React app" would
be a category error, and promoting it to `apps/web-next` would create a second
production surface — with, decisively, a **second origin and therefore a second
IndexedDB**, which would give one person two different cryptographic
identities depending on which screen they opened.

### 2.5 There are three mobile surfaces; only one is real

| Path | Tracked | Reality |
|---|---|---|
| `spotme/web` + `android/` + `capacitor.config.json` | yes | The shipping Capacitor shell |
| `spotme/app` | **yes, 21 files** | Expo 57 / RN 0.86 / **React 19.2.3** — a **P2P/DHT prototype** on `react-native-bare-kit`. Its own header: "do two phones find each other over the DHT". **ADR-033 deleted the P2P transport family.** |
| `spotme/mobile` | **no, 0 files** | Untracked Expo directory. Not in the repo, not gitignored. Not evidence of anything. |

`spotme/app` is the trap: it is React 19 + React Native, so at a glance it
looks like the ADR-027 native target. It is not — it is dead code from a
superseded transport decision.

### 2.6 The Capacitor "contradiction" is not one

The mission brief flagged that ADR-027 names Capacitor transitional while
Capacitor sits in `spotme/web` deps. Reading ADR-027 §Decision settles it:
"Capacitor stays the shipping shell now **and during migration**." The deps
are that clause being honoured.

What is in `spotme/web` today: `@capacitor/push-notifications` as a runtime
dependency (dynamically imported at `lib/push.js:90` and `:161`),
`@capacitor/{android,cli,core}` as devDeps, a `capacitor.config.json`, and a
committed `web/android/` Gradle project. All consistent with ADR-027 as
written. **ADR-035 reaffirms ADR-027 unchanged rather than superseding it.**

### 2.7 Working-tree hygiene (not blocking, worth recording)

`git status` carries a large number of untracked files with shell-fragment
names — `spotme/web/src/0)`, `src/views/{,-`, `src/a.name.localeCompare(b.name))`,
`spotme/handlers.onFetch`, and similar. They are zero-byte artifacts of
mistyped redirects, and several sit *inside* `spotme/web/src/`. None is tracked
and none affects the build, but they pollute every `find`, `git status` and
audit of the source tree. A one-line cleanup PR would pay for itself.

---

## 3. How the mission's questions were answered

Full rationale and rejected alternatives are in ADR-035; the short form:

| Question | Answer |
|---|---|
| **(a) React 18.3 or 19** | **19.** Nothing shipped depends on React 18 — web-next is inert, so the upgrade cost is at its permanent minimum. `spotme/app` already pins 19.2.3, and RN 0.86 requires 19; choosing 18.3 forks the React major across surfaces, defeating ADR-027's own reason for choosing React. |
| **(b) Mobile boundary** | **ADR-027 stands, unchanged.** Capacitor is the shipping shell for the whole migration; no React Native app is created. Separately: **[PROPOSED]** retire `spotme/app` (dead under ADR-033), and commit-or-remove the untracked `spotme/mobile`. |
| **(c) Monorepo layout** | `apps/web` + `packages/{contracts,core,ui,search-bench}`. **web-next is dissolved, not promoted** — components → `packages/ui`, controllers/ports → `packages/core`, its harness deleted. No `apps/mobile` placeholder. |
| **(d) Tailwind + #132 tokens** | **[PROPOSED]** Tailwind v4, tokens-first, `packages/ui` only. v4's `@theme` reads CSS custom properties natively, so `tokens.css` stays the single source; `--onfill`/`--surface`, `--ink-press`, the 15 vendored fonts and the discrete-weight decision all move verbatim, and the 29-assertion `design-tokens-fence` moves with them and keeps running. |
| **(e) Slice order** | **Default kept: slice 1 = Discovery** — but scope-pinned to the *legacy live* surface. Chat and crypto last. A smaller pathfinder slice was considered and rejected (§4). |
| **(f) Per-slice DoD** | Nine items: dark flag `spotme.ui.<slice>` (default off) · legacy view stays live and unmodified · 1,077-assertion floor holds · new package tests · **fence parity against the React build** · a flag-off/flag-on parity test · a11y parity · bundle budget recorded · docs updated in place (G9). |
| **(g) Rollback** | Tier 1 flag-off (seconds, no deploy) · tier 2 revert the merge (slices are additive by construction) · tier 3 **prevented, not recovered**: a slice may not change any persisted shape — new data goes under a new key legacy ignores. Legacy deletion is a separate PR one release after 100% rollout. |

---

## 4. Recommended slice-1 scope

**Slice 1 = Discovery, legacy live surface only.**

**In scope**
- Rewrite `views/discovery.js` (750 lines, 66 `el()` calls) as React, in
  `packages/ui/discovery` + `packages/core/discovery`.
- Reuse web-next Discovery as **architecture and components**: the controller
  shape, the five injected ports, `coarsen.ts`, the privacy-mutation battery,
  the accessibility bar.
- Point those ports at **the endpoints `views/discovery.js` calls today** —
  `lib/discovery.js`, the existing lobby broadcast, the existing transport.
- Ship behind `spotme.ui.discovery`, default off.

**Explicitly out of scope**
- Phase 2 backend activation. `DiscoveryModule` is **not imported by
  `AppModule`**; it is dark, has no live route, and Typesense is neither
  provisioned nor re-benchmarked on production hardware. Shipping web-next's
  Discovery *as it is wired today* is a Phase 2 activation with new spend, not
  a frontend migration. **[PROPOSED] / owner-retained.**
- Any change to what Discovery *does* — same behaviour, different renderer.

**Hard gate.** `test/discovery-coarse-broadcast.test.js` — the ADR-024 P0
fence proving precise GPS never reaches the broadcast — must pass **against the
React implementation**, not merely keep passing against the legacy one.

**Why this and not a gentler first slice.** `views/notifications.js` (175
lines) or `views/stories.js` (107) would be a softer landing. I rejected that:
every screen small enough to be a pathfinder is also small enough to prove
nothing — none exercises ports, realtime, or a privacy fence, so slice 1's real
risks would be deferred to slice 2 at the cost of an extra release. Discovery
is the right first slice. Pinning its scope, not picking a different screen, is
what makes it safe.

**Prerequisite: slice 0 must land first and alone.** Monorepo move + React 19 +
`packages/core` extraction + island host + tokens + **all nine fences repaired
and tamper-checked**. It changes the Vercel Root Directory, which has produced
a total outage before, so it ships in its own PR with nothing else in it.

---

## 5. Open questions for the owner

Everything touching spend, activation or product scope is **PROPOSED**:

| # | Question |
|---|---|
| P1 | Adopt ADR-035's migration plan at all? |
| P2 | React 19 for web-next? |
| P3 | Monorepo move + Vercel Root Directory change (slice 0)? |
| P4 | Tailwind v4 — a **new dependency**? |
| P5 | Retire `spotme/app`? It is dead under ADR-033, but **deletion is owner-retained**. |
| P6 | Commit or remove the untracked `spotme/mobile`? |
| P7 | Any Phase 2 Discovery activation — Typesense provisioning, provider credentials, the mandatory production-hardware re-benchmark? **Spend + activation.** |
| P8 | Any flag flip to real users? |

Engineering questions I could not settle from the repository:

1. **Is there an appetite for characterization tests before the rewrite?**
   §2.2 means each slice either writes tests against legacy behaviour first
   (slower, safer) or rewrites from the source and accepts the risk. ADR-035
   assumes the former; that assumption costs time and should be confirmed.
2. **Who owns the five backend dark-fence rewrites?** They are backend files
   enforcing a frontend property. If they are not rewritten before slice 1,
   Phase 2–6 darkness stops being enforced.
3. **Does `spotme/web/api/*` (8 serverless functions) move under `apps/web`?**
   The Vercel Root Directory change implies yes, but it is a deployment
   question, not a frontend one, and it is the part of slice 0 most likely to
   cause the outage it is designed to avoid.

---

## 6. Out of scope — LATER phases

Recorded so they are not silently absorbed:

- **Observability — OpenTelemetry / Prometheus / Grafana.** The Phase 1G
  baseline (structured logging, optional Sentry/OTel seam, `prom-client`) and
  the closed metric registries from Phases 3E/4D/5E/6E exist and are untouched.
  Frontend instrumentation is a **later phase**, out of scope for ADR-035.
- **pgvector.** Deferred by ADR-026, unchanged here. **Later phase**, and not a
  frontend concern.
- **React Native application.** ADR-027's target; not started by this plan.
- **Phase 2–6 activation.** All five domain backends stay dark and unimported.

---

## 7. Artifacts and verification

**Produced (docs only, both new files):**
- `spotme/docs/adr/035-frontend-migration-plan.md` — Status **PROPOSED**
- `spotme/docs/reports/2026-08-07-migration-phase-0.md` — this report

**Verified during the mission:**
- `git merge --ff-only origin/master` → `772a92a` (no merge commit; tracked
  tree was clean beforehand)
- `npm test --prefix spotme/web` → **1,077 assertions, exit 0**, 56 suites

**Not done, by constraint:** no application code, no `package.json` change, no
new dependency, no merge of any branch or PR, no touch of
`claude/vercel-token-connection-bj4d21`, no flag flipped, no deployment. Env
variables appear by **name only**.

**Follow-up hygiene noted, not performed:** repair the stale
`docs/adr/README.md` index (missing 029/033/034); remove the zero-byte
shell-fragment files littering `spotme/web/src/` and the repository root.
