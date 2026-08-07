# ADR-035 — Frontend migration to React + TypeScript: the executable plan

**Status: PROPOSED** · **Date:** 2026-08-07 · **Verified against `master` `772a92a`**

**Relates to:** [ADR-015](015-compile-time-feature-flags.md) (compile-time
flags), [ADR-016](016-dark-shipping.md) (dark shipping),
[ADR-024](024-discovery-coarse-broadcast-hotfix.md) (coarse-broadcast P0
fence), [ADR-027](027-mobile-native-boundary.md) (mobile-native boundary),
[ADR-033](033-server-only-transport-migration.md) (server-only transport),
PR #132 (design tokens, self-hosted fonts), the Platform Phase 1–6 programmes.

> **Nothing in this ADR is authorized by writing it.** Every item that touches
> spend, activation, or product scope is marked **[PROPOSED]** and remains
> owner-retained. No code, dependency, or configuration changed in the mission
> that produced this document.

---

## Context

Spot Me ships one production frontend: `spotme/web` — ~10,751 lines of
imperative view JavaScript across 14 screens, built by 950 `el()` calls into a
hash router, plus ~7,446 lines of CSS. It works, it is the deployed product,
and its suite is green (1,077 assertions, exit 0, verified 2026-08-07).

Alongside it sit React artifacts accumulated by the Platform Phase programme:
`spotme/web-next` (React 18.3, five domain shells, 105 tests, **inert**),
`@spotme/contracts` (shared TypeScript types), and — discovered during this
inventory — two further mobile directories in various states of reality
(§Inventory D).

The intent to migrate is recorded in several places (ADR-027 item 8,
Phase 1F/2E/3D/4C/5D/6D, the web-next README). None of them says **how a
migrated screen reaches a user**, what "done" means for one slice, or how a
shipped slice is taken back. This ADR supplies exactly that and nothing more.

---

## Inventory

### A. Every surface in `spotme/web/src`

80 non-empty source files. Test coverage is stated per surface; "fence" means
a test that reads source as **text** and asserts structure (these break on any
file move and are called out again in §Consequences).

#### A.1 Views — all DOM-coupled, all must be rewritten

Every view imports `el()` from `lib/ui.js` and builds DOM imperatively. None
has a component model, none is unit-tested directly.

| View | JS | CSS | `el()` | Direct test coverage |
|---|---:|---:|---:|---|
| `views/chat.js` | 4,672 | 2,844 | 308 | none direct; behaviour covered via `lib/rooms.js` in `media`/`requests`/`viewonce`/`send-failure-visible` |
| `views/moments.js` | 1,196 | 272 | 98 | `moments-nav-fence` (fence), `moments-home` (fence) |
| `views/profile.js` | 1,097 | 825 | 140 | none |
| `views/discovery.js` | 750 | 607 | 66 | none direct; `discovery-coarse-broadcast` covers `lib/discovery.js` |
| `views/inbox.js` | 742 | 317 | 74 | none |
| `views/verify.js` | 391 | — | 27 | none direct; `identity-verify` covers the underlying modules |
| `views/group-manage.js` | 338 | 484¹ | 36 | none |
| `views/bluetooth.js` | 303 | 425 | 44 | none |
| `views/group-new.js` | 295 | 484¹ | 34 | none |
| `views/groups.js` | 291 | 484¹ | 30 | none direct; `groups-permissions` covers `lib/group-perms.js` |
| `views/contacts.js` | 241 | 181 | 21 | none |
| `views/notifications.js` | 175 | 108 | 33 | none |
| `views/member-picker.js` | 153 | — | 14 | none direct; `member-search` covers `lib/api.js` |
| `views/stories.js` | 107 | 88 | 25 | none |

¹ the three group views share `views/groups.css`.

**Finding: there is no view-level test coverage anywhere in the product.** All
1,077 assertions sit below the view layer or in text fences. A React rewrite
therefore has no behavioural safety net at the surface being rewritten — this
is the single largest risk in the whole migration and drives the DoD in §(f).

#### A.2 Application shell — DOM-coupled

| Module | Lines | DOM refs | Coverage |
|---|---:|---:|---|
| `main.js` | 1,017 | 36 | `moments-home` (fence), `moments-nav-fence` (fence) |
| `app.js` | 360 | 26 | none |
| `store.js` | 530 | 25 | `store-quota` |
| `net.js` | 291 | 3 | via `discovery-coarse-broadcast`, `requests` |

`main.js` owns the hash router (`ROUTES`, 9 entries), the nav bar, the
cold-open landing rule (`homeTab()`), and app boot. It is the piece that must
learn to host React.

#### A.3 Already framework-free — movable to a shared package UNCHANGED

Verified two ways: zero references to `document`/`window`/`localStorage`/
`navigator`/`addEventListener` **outside comments**, and an import graph that
reaches only `../api.js`, `../auth-headers.js`, `../socket-transport.js` and
siblings — never `lib/ui.js`, never `views/`.

| Group | Files | Lines | Coverage |
|---|---:|---:|---|
| **`lib/crypto/*`** — x3dh, ratchet, safety-number, signing-identity, signing-key-store, signing-key-publication, e2e-v2, identity-{store,pin,pin-store,binding,availability,enforcement} | 13 | ~3,767 | **heaviest in the repo** — `a5-matrix`, `crypto`, `ratchet`, `x3dh`, `safety-number`, `identity-{pin,pin-store,binding,status,verify,availability,enforcement,substitution,durability}`, `signing-{identity,key-store,key-publication}`, `key-self-heal`, `e2e-v2-reload`, plus the `signing-not-shipped` / `e2e-v3-not-shipped` fences |
| **`lib/transport/*`** — ITransportAdapter, socketio-adapter, centrifugo-adapter, index, room | 5 | 597 | `transport`, `transport-seam` |
| **`lib/calls/livekit-media.js`** | 1 | 327 | `calls-flag` (covers `calls/select.js`); `livekit-call.harness.mjs`, `turn-relay.check.mjs` are opt-in harnesses |
| **`lib/ai/*`** — baseline, gateway, index, ports | 4 | 162 | `ai-gateway`, `ai-gateway-not-shipped` (fence) |
| **API clients** — `api.js`, `auth-headers.js`, `moments-api.js`, `discovery-api.js`, `groups-api.js`, `group-perms.js` | 6 | 482 | `member-search`, `groups-permissions`, `api-auth` |
| **Pure logic** — `english.js`, `photos.js`, `voice.js` | 3 | 183 | `english-guard` |

**~5,518 lines move with no edit.** Three modules
(`crypto/identity-store.js`, `crypto/signing-key-store.js`,
`crypto/e2e-v2.js`) each matched the DOM grep once; all three hits are prose
in comments explaining *why IndexedDB and not localStorage*. They are clean.

Two near-misses stay behind: `lib/transport/select.js` (39 lines) and
`lib/calls/select.js` (59 lines) read `localStorage` flags directly. They are
flag readers, not logic — §(c) gives them a one-function host shim.

#### A.4 DOM-coupled infrastructure — rewrite or shim, not a straight move

| Module | Lines | Why it is stuck | Coverage |
|---|---:|---|---|
| `lib/socket-transport.js` | 1,088 | `localStorage` token + cursor persistence, `window.__transport` debug handle | `transport-seam`, `terminal-auth`, and 8 dynamic-mock suites |
| `lib/db.js` | 376 | `new URL(window.location.href)`, `localStorage` sweep, `window.__db` | `wipe-device`, `identity-durability` |
| `lib/rooms.js` | 1,524 | 7 DOM refs; the chat engine | `media`, `requests`, `viewonce`, `send-failure-visible` |
| `lib/photoedit.js` | 879 | 33 DOM refs — canvas editor | none |
| `lib/reach.js` | 532 | debug handle only (1 ref, in a comment) | `requests` |
| `lib/media.js` | 288 | canvas/Image compression | `media`, `media-leakage` |
| `lib/notify.js` | 266 | Notification API, audio priming | via 5 dynamic suites |
| `lib/discovery.js` | 275 | lobby broadcast | **`discovery-coarse-broadcast` — the ADR-024 P0 privacy fence** |
| `lib/blobstore.js`, `lib/media-transfer.js`, `lib/crop.js`, `lib/pullrefresh.js`, `lib/qr-scan.js`, `lib/ui.js`, `lib/push.js`, `lib/translate.js`, `lib/video.js`, `lib/demo.js` | 1,616 | IndexedDB / canvas / gesture / Capacitor / DOM helpers | `blobstore`, `media-transfer`, `qr-scan`, `translate-guards`, `translit`, `push*` |

#### A.5 Design system

`tokens.css` (663) + `fonts.css` (632) + 15 vendored font files, pinned by
`test/design-tokens-fence.test.js` (29 assertions). See §(d).

### B. Test inventory

56 suites in `npm test --prefix web`, 1,077 assertions, exit 0 at `772a92a`.
By kind:

- **Behavioural, module-level (33):** import a `lib/` module directly or via
  `--experimental-test-module-mocks`. These survive a move untouched provided
  import specifiers are updated.
- **Text fences (9):** `signing-not-shipped`, `e2e-v3-not-shipped`,
  `ai-gateway-not-shipped`, `moments-nav-fence`, `moments-home`,
  `design-tokens-fence`, `discovery-coarse-broadcast` (behavioural + textual),
  and the backend's five `*-dark-fences.spec.ts`. **These read source paths as
  strings and will fail on any file move.** Every one is load-bearing — they
  are what keeps unactivated crypto and Phase 2–6 code dark.
- **Serverless (`api/`) (3):** `push`, `translate-guards`, `api-auth` — cover
  `spotme/web/api/*`, untouched by a frontend migration.
- **Opt-in harnesses (5):** `phone-harness`, `livekit-call.harness`,
  `turn-relay.check`, `viewonce-live`, plus `e2e/*` and `bench/*`.

### C. `spotme/web-next` as it actually stands

React 18.3.1 · 34 source files · 105 tests · five domain shells (discovery,
exchange, events, moments, assistant) · `@spotme/contracts` consumer.

Every shell follows one shape: pure prop-driven components ← framework-free
controller (`useSyncExternalStore`) ← injected ports, with fixture adapters
only. `App.tsx` mounts **Discovery alone**; the other four shells are
unreferenced by the entry point on purpose.

**It is not an application.** No router, no auth, no backend, no deployment.
`scripts/check-boundaries.mjs` plus five backend `*-dark-fences.spec.ts`
suites actively assert that it imports nothing from `spotme/web`, appears in
no Vercel config, and that `App.tsx` mounts none of the four dark shells.

**The trap this sets for slice 1** is recorded in §(e): web-next's Discovery is
built against the **Phase 2 backend**, and `DiscoveryModule` is not imported by
`AppModule` — it is dark, has no live route, and its selected search engine
(Typesense) is unwired and unpaid for. Shipping web-next Discovery *as-is* is
a Phase 2 activation, not a frontend migration.

### D. Mobile surfaces — three of them, only one real

| Path | Tracked in git | What it is |
|---|---|---|
| `spotme/web` + `web/android/` + `capacitor.config.json` | **yes** | The shipping Capacitor shell. `@capacitor/push-notifications` is a runtime dep, dynamically imported at two sites in `lib/push.js`; `@capacitor/{android,cli,core}` are devDeps. |
| `spotme/app` | **yes — 21 files** | An Expo 57 / RN 0.86 / **React 19.2.3** prototype on `react-native-bare-kit` + `spotme-core`. Its own header calls it "Phase 1 chat screen… do two phones find each other over the DHT". **It is a P2P prototype, and ADR-033 removed the P2P transport family.** |
| `spotme/mobile` | **no — 0 tracked files** | An untracked Expo working directory. Not in the repository, not gitignored either. It is not evidence of anything. |

---

## Decisions

### (a) React 19

**Decision: target React 19.** `web-next` moves 18.3.1 → 19 as part of slice 0.

*Rationale.* The upgrade cost is at its global minimum right now and will only
rise: web-next is inert, so **zero shipped code depends on React 18** — there
is no working behaviour to protect. `spotme/app`, the only React surface with
a native runtime, already pins React 19.2.3 (RN 0.86 requires React 19), so
choosing 18.3 forks the React major across surfaces — directly against
ADR-027's stated reason for choosing React at all ("React keeps the component
model continuous from web to native"). The one pattern web-next depends on,
`useSyncExternalStore`, is unchanged in 19; `ref`-as-prop removes `forwardRef`
boilerplate before any is written.

*Rejected — React 18.3 ("don't touch what works").* Nothing works yet; inert
code has no working state. It defers an unavoidable upgrade to a moment when
slices are mid-flight, which is strictly worse than doing it while the tree is
still dark.

*Rejected — Preact / Solid / Svelte.* Would discard the 105 existing web-next
tests, five built shells, and ADR-027's native-continuity argument, in exchange
for bundle size the migration has not yet measured a problem with.

### (b) Mobile boundary — ADR-027 stands; the Capacitor deps are not a contradiction

**Decision: ADR-027 is reaffirmed unchanged. Capacitor remains the shipping
shell for the entire duration of this migration. This plan creates no React
Native application.**

The apparent conflict dissolves on reading: ADR-027 §Decision says "Capacitor
stays the shipping shell now **and during migration**." Capacitor sitting in
`spotme/web`'s dependencies is that clause being honoured, not violated.

What the inventory *did* surface is a genuine, separate problem — **three
mobile directories, two of them misleading:**

1. **`spotme/app` is dead relative to ADR-033.** It is a P2P/DHT prototype on
   `react-native-bare-kit` + `spotme-core`; ADR-033 removed the P2P transport
   family entirely and declared its reintroduction "a regression against this
   ADR, not a legitimate feature". Left in the tree it will be mistaken for
   the ADR-027 React Native target it is not.
   **[PROPOSED] — retire `spotme/app`.** Deletion is owner-retained; this ADR
   only recommends it. Until the owner decides, it is quarantined by §(g)'s
   rule that no slice may import from it.
2. **`spotme/mobile` is untracked.** It has no bearing on any decision and
   must not be built on. Whoever needs it should commit it behind a PR or
   remove it.
3. **The ADR-027 React Native target does not exist in the repository.** No
   committed RN app implements it. That is consistent — ADR-027 explicitly says
   acceptance "does not itself start a rewrite" — but it must be stated so the
   next session does not go looking for it.

*Rejected — "Capacitor in deps means ADR-027 is stale; supersede it."* ADR-027
is four days old, Accepted, and its transitional clause covers exactly this
state. Superseding an Accepted ADR on a misreading would be the more expensive
error.

*Rejected — start the React Native app in this migration.* It doubles the
surface area of an already large migration, needs native module expertise and
a second release pipeline, and ADR-027's boundary rule (native only for
capability the WebView cannot meet) is not met by any screen in slices 1–6.

### (c) Monorepo layout

**Decision — proposed target:**

```
spotme/
  apps/
    web/                 ← today's spotme/web, moved wholesale (Vercel root follows)
  packages/
    contracts/           ← exists
    core/                ← NEW — §A.3 modules, moved UNCHANGED
    ui/                  ← NEW — React components + design tokens + fonts
    search-bench/        ← exists
```

**What `web-next` becomes: it is dissolved, not promoted.** Its components go
to `packages/ui/<domain>/`, its controllers/ports/fixtures to
`packages/core/<domain>/`, its 105 tests follow the code. `App.tsx`,
`main.tsx`, `index.html` and `vite.config.ts` are deleted — they are a harness
for an app that will never exist. `scripts/check-boundaries.mjs` is rewritten
as a `packages/` import-boundary fence (§(g)).

*Rationale.* web-next has no router, no auth, and no backend; it is a component
library wearing an app costume. `apps/mobile/` is deliberately **not** created
— an empty directory for a decision nobody has made is scaffolding for later,
and later can scaffold for itself.

*Rejected — two deployable apps (`apps/web` legacy + `apps/web-next` React),
split at the CDN.* Two production surfaces, two auth sessions, and —
decisively — **if the hosts ever differ, IndexedDB is origin-scoped, so the
crypto identity store cannot be shared**; the same person would hold two
different cryptographic identities depending on which screen they opened. That
is a correctness failure, not an inconvenience.

*Rejected — no monorepo; keep sibling directories.* The §A.3 modules would need
copying (two divergent crypto implementations — unacceptable) or
`../../web/src` relative imports (unenforceable, and invisible to the fences).

*Rejected — a workspace tool (Nx / Turborepo) in this step.* npm workspaces
already covers what four packages need. Adopting a build orchestrator before a
measured build-time problem is exactly the speculative complexity the migration
should not carry.

**[PROPOSED] — the move itself is slice 0 and touches deployment.** Relocating
`spotme/web` → `apps/web` changes the Vercel Root Directory, which has
previously produced a total outage when wrong. It must ship alone, with no
other change in the PR.

### (d) Tailwind adoption and the #132 tokens

**Decision: [PROPOSED] adopt Tailwind CSS v4, tokens-first, scoped to
`packages/ui` only.** `apps/web`'s legacy CSS is never converted.

The carry-over is mechanical because v4 reads CSS custom properties natively:
`tokens.css` becomes the theme source via `@theme`, rather than being
re-encoded in a JavaScript config. Concretely, PR #132's contract is preserved
in full:

- `--onfill` (text/icons on a filled ground) and `--surface` (the ground) stay
  **distinct tokens with the same value** — the distinction that makes a dark
  theme possible later.
- `--ink-press`, `--arch`, `--bt-scope-*`, `--bt-blip`, `--vcard-*` move
  verbatim.
- `fonts.css`, the 15 vendored font files, and the discrete-weight decision
  (640/650 snap to 700 against discrete faces; a variable range face would
  silently restyle the app) move verbatim.
- `test/design-tokens-fence.test.js` (29 assertions, codepoint-based Indic
  coverage) **moves with the tokens and keeps running**. It is the mechanism
  that catches a dropped font or an unlisted language, and a slice that breaks
  it is not done.

*Rejected — plain CSS Modules per component.* Workable, but every migrated
slice would re-derive its own spacing and type scale from the raw tokens, and
the 950 existing `el()` call sites already carry class strings that have no
utility vocabulary to land on.

*Rejected — CSS-in-JS (styled-components / emotion).* Runtime cost on a mobile
WebView, and it would strand `tokens.css` as a second parallel system —
recreating the two-sources-of-truth problem #132's fence exists to prevent.

*Rejected — Tailwind v3 + `tailwind.config.js`.* Requires duplicating every
token into JavaScript. Same objection, more typing.

**This is a new dependency and therefore cannot be executed under the
constraints of the mission that wrote this ADR.** It needs its own PR.

### (e) Slice order — Discovery first, with its scope pinned

**Decision: the default holds — slice 1 is Discovery — but scoped to the
LEGACY live Discovery surface, explicitly excluding any Phase 2 activation.**

| # | Slice | Why here |
|---|---|---|
| 0 | Monorepo move + `packages/core` extraction + React 19 + island host + tokens | Infrastructure. No user-visible change. Ships alone. |
| 1 | **Discovery** (`views/discovery.js`, `lib/discovery.js`) | The beachhead's architecture exists, and this is the first step of the fixed Discovery execution order (ADR-022) — migration effort lands where product effort already points. |
| 2 | Contacts · Notifications · Stories | Small, low-coupling, no realtime. Widens the component library cheaply. |
| 3 | Groups (list · new · manage) | Self-contained; `group-perms` already framework-free and tested. |
| 4 | Profile · Settings | Large but shallow; forces the media/crop/photoedit port boundaries. |
| 5 | Inbox | Chat-adjacent; the last step before chat. |
| 6 | Moments | Live product surface (PR #126) with two structural fences to re-satisfy. |
| **last** | **Chat, and every crypto-facing surface (verify, safety numbers)** | Per mission constraint, and independently correct: chat is 4,672 lines with 308 `el()` calls and **no view-level tests**, and crypto UI regressions are the class of bug this product can least afford. |

**The slice-1 trap, stated plainly.** `web-next/src/discovery/` is built against
the **Phase 2** Discovery backend: PostGIS people-search, a Typesense
`SearchPort`, place/directions provider ports. `DiscoveryModule` is **not
imported by `AppModule`** — there is no live route, no provisioned Typesense,
and the mandatory production-hardware re-benchmark has not been run. Shipping
that code to a user is a **Phase 2 activation with new spend**, which is
owner-retained and **[PROPOSED]** at most.

So slice 1 reuses web-next Discovery as **architecture and components**
(controller shape, port injection, `coarsen.ts`, the privacy-mutation battery,
the a11y bar), re-pointed at the **endpoints `views/discovery.js` calls
today**. No new backend, no new provider, no new spend.

**Slice-1 hard gate:** `test/discovery-coarse-broadcast.test.js` — the ADR-024
P0 fence proving precise GPS never reaches the broadcast — must pass **against
the React implementation**, not merely continue passing against the legacy one.
This is the one slice that carries a P0 privacy fence, and it is deliberately
first so the fence-parity mechanism is proven while the blast radius is one
screen.

*Deviation considered and rejected: a smaller pathfinder slice first.*
`views/notifications.js` (175 lines) or `views/stories.js` (107) would be
gentler. Rejected because every candidate small enough to be a pathfinder is
also small enough to prove nothing: none exercises ports, realtime, or a
privacy fence, so slice 1's real risks would simply be deferred to slice 2 with
an extra release of overhead. Discovery is the right first slice; the pinned
scope, not a different screen, is what makes it safe.

### (f) Per-slice definition of done

A slice is done when **all nine** hold. Any one missing means not done.

1. **Dark flag.** `spotme.ui.<slice>` — default **off**, read at exactly one
   place, mirroring the existing `spotme.transport` / `momentsHome` pattern
   already in the codebase (ADR-015 compile-time default false, ADR-016 dark
   shipping).
2. **Both stacks live.** The legacy view stays in `ROUTES`, **unmodified and
   reachable**, for the whole slice lifetime and one full release after
   cutover. This is what makes §(g) tier 1 possible; it is not negotiable.
3. **Legacy suite unchanged and green.** 1,077 assertions is the regression
   floor. A slice that edits an existing assertion to make it pass must justify
   the edit in its PR body.
4. **New tests in the slice's package.** vitest + Testing Library, matching
   web-next's existing setup: controller tests, UI tests, and — where the
   surface touches location or identity — a privacy-mutation battery.
5. **Fence parity.** Every fence covering that surface passes against the
   **React** implementation. For slice 1 that is `discovery-coarse-broadcast`;
   for Moments, `moments-nav-fence` and `moments-home`; for all slices,
   `design-tokens-fence`.
6. **A parity test** asserting flag-off renders legacy and flag-on renders
   React — so the rollback path is itself tested, not assumed.
7. **Accessibility parity** at web-next's existing bar: 44 px touch targets,
   keyboard-activatable controls, visible focus, reduced-motion support,
   fixed-size skeletons (no layout shift).
8. **Bundle budget recorded.** Initial-load bytes before and after, in the PR
   body. A slice that grows the bundle without stating by how much is not done.
9. **Docs updated in place** (Governance G9): the
   `03-IMPLEMENTATION-STATUS.md` row and this ADR's slice table.

**Activation — flipping the flag on for real users — is owner-retained and is
NOT part of any slice's DoD.** A slice is complete when it is shippable and
dark.

### (g) Rollback

Three tiers, cheapest first.

**Tier 1 — flag off (seconds, no deploy).** Because DoD #2 keeps the legacy
view in `ROUTES` untouched, flipping `spotme.ui.<slice>` off makes the next
render serve legacy. DoD #6 tests this path.

**Tier 2 — revert the merge commit (one PR).** Each slice is **additive by
construction**: it adds a React implementation and a flag read, and changes no
legacy file except the one-line flag branch. A revert therefore cannot break
the legacy path.

**Tier 3 — persisted-state divergence: prevented, not recovered.** The real
hazard is a React slice writing localStorage/IndexedDB in a shape the legacy
view cannot read; flag-off then lands on a *broken* legacy screen and tier 1
has failed silently.

> **Rule: a migrated slice MUST NOT change any persisted shape.** Same keys,
> same schema, same encodings. A slice needing new persisted data writes it
> under a **new key the legacy code ignores**. Storage schema changes are a
> separate change with their own migration and their own rollback, never
> bundled into a slice.

This rule is what makes tiers 1 and 2 real rather than theoretical, and it is
the single most important line in this ADR.

**Deleting the legacy view is a separate PR**, no earlier than one full release
after the flag has been on at 100% with no rollback — never in the cutover PR.

**Quarantine.** No slice may import from `spotme/app` or `spotme/mobile`
(§(b)). The `packages/` boundary fence enforces this.

---

## Consequences

**Positive.** One React major across web and native (a). ~5,518 lines of
crypto, transport, calls, AI and API-client code move with **no edit and no
retest** (A.3) — the highest-risk code in the product is the code the migration
does not touch. Every slice is independently revertible in seconds (g). The
#132 design-system contract, including its 29-assertion fence, survives intact
(d).

**Cost / risk.**

- **No view-level tests exist anywhere** (A.1). Each slice must write its own
  characterization coverage; there is nothing to migrate against. This is the
  dominant risk and the reason the DoD has nine items.
- **Nine text fences pin source paths as strings** (B). The slice-0 monorepo
  move breaks all of them at once. They must be updated *in the same commit* as
  the move, and each must be tamper-checked afterwards to prove it did not
  become vacuous — a fence that silently stops matching anything is worse than
  no fence, and this repository has already been bitten by exactly that (the
  #132 codepoint fence's first draft passed vacuously).
- **The five backend `*-dark-fences.spec.ts` suites assert web-next's isolation
  and non-deployment.** Dissolving web-next into `packages/` invalidates their
  assumptions. They must be rewritten to fence the *new* layout — asserting the
  four dark domains (exchange, events, moments, assistant) remain unmounted —
  before slice 1, or Phase 2–6 darkness stops being enforced.
- Temporary duplication: two implementations of each migrated screen for at
  least one release.
- Slice 0 touches the Vercel Root Directory — a known outage mode.

**Reversible.** Until slice 0 merges, nothing has changed. After it, every
slice reverts independently by tier 1 or 2.

---

## Out of scope — LATER phases

Named here so they are not silently absorbed into this plan:

- **Observability (OpenTelemetry / Prometheus / Grafana).** The Phase 1G
  baseline (structured logging, optional Sentry/OTel seam, `prom-client`) and
  the closed metric registries added in Phases 3E/4D/5E/6E already exist and
  are untouched by this ADR. Frontend instrumentation is a **later phase**.
- **pgvector.** Deferred by ADR-026 and unchanged here. Not a frontend concern.
- **React Native application.** ADR-027's target; not started by this plan (b).
- **Phase 2–6 activation.** Discovery / Exchange / Events / Moments / Assistant
  backends stay dark and unimported. This ADR migrates *frontend rendering*
  only and activates nothing.

---

## Owner decisions required — all [PROPOSED]

| # | Item | Why owner-retained |
|---|---|---|
| P1 | Adopt this migration plan at all | Sets programme direction |
| P2 | React 19 upgrade for web-next | Low risk, but a stack decision |
| P3 | Monorepo move + Vercel Root Directory change (slice 0) | Deployment change; known outage mode |
| P4 | Tailwind v4 adoption | **New dependency** |
| P5 | Retire `spotme/app` (dead P2P prototype, ADR-033) | **Deletion** — explicitly owner-retained |
| P6 | Commit or remove the untracked `spotme/mobile` | Repository hygiene |
| P7 | Any Phase 2 Discovery activation (Typesense provisioning, provider credentials) | **Spend + activation + product scope** |
| P8 | Any flag flip to real users | Activation |

---

## Evidence

All verified against `master` `772a92a`, 2026-08-07:

- `npm test --prefix spotme/web` → **1,077 assertions, exit 0**, 56 suites.
- Surface inventory: `spotme/web/src`, 80 non-empty files; per-file line counts
  and `el()` counts in §A.
- Framework-free classification: DOM-reference grep (`document.`, `window.`,
  `localStorage`, `navigator.`, `addEventListener`, `HTMLElement`) plus an
  import-graph trace showing `lib/crypto`, `lib/transport`, `lib/calls`,
  `lib/ai` reach only `../api.js`, `../auth-headers.js`,
  `../socket-transport.js` and siblings.
- View DOM coupling: all 14 views import `el()` from `lib/ui.js`; 950 call sites.
- `spotme/web-next`: `package.json` (react ^18.3.1), 34 source files,
  `App.tsx` mounting Discovery only, `scripts/check-boundaries.mjs`.
- Isolation fences:
  `backend/test/{discovery,exchange,events,moments,assistant}-dark-fences.spec.ts`.
- Mobile surfaces: `git ls-files -- spotme/app` → 21;
  `git ls-files -- spotme/mobile` → 0; `spotme/app/package.json` → expo
  ~57.0.8, react-native 0.86.0, react 19.2.3, react-native-bare-kit.
- Capacitor: `spotme/web/package.json` deps/devDeps;
  `spotme/web/src/lib/push.js:90,161`; `spotme/web/capacitor.config.json`;
  `spotme/web/android/`.
- Design system: PR #132 (merged, `ba7682a`), `tokens.css`, `fonts.css`,
  `test/design-tokens-fence.test.js` (29 assertions).
- Deployment: `spotme/web/vercel.json` (root = `spotme/web`, output `dist`).

**Repository-state correction (Governance G9, CLAUDE.md bootstrap step 8):**
the working tree began this mission 48 commits behind `origin/master` and was
fast-forwarded to `772a92a` before any inventory was taken. The ADR index
`docs/adr/README.md` is **stale** — it ends at 028 and does not list ADR-029,
033, or 034. Numbers 030–032 were never used; this ADR takes **035**.
