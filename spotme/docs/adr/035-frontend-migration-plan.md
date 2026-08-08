# ADR-035 — Frontend migration to React + TypeScript: the executable plan

**Status: ACCEPTED (plan) — P5 and P6 PENDING owner confirmation; host CURRENCY
settled, AUDIENCE open as P10; **slice 1 amended to EXCHANGE**. Amended 2026-08-07** · **Date:** 2026-08-07
**Verified against `master` `acf48bc`**

> **Acceptance adopts the PLAN. It activates nothing.** P4 (Tailwind) is
> **deferred**, P7 (Phase 2 activation) and P8 (flag flips) are **refused for
> now**. Recorded in `handbook/DECISIONS.md` → "Frontend migration — ADR-035
> decisions P1–P8".
>
> **CORRECTION 2026-08-07 — P5, P6 and the §(c) host pick are PENDING, not
> decided.** The eight answers reached this ADR as a *recommendation table*
> ("my recommendation", "My read", "If you agree") and were recorded as an
> owner decision. That is a stronger claim than was given. For P1–P4, P7 and
> P8 the over-reading is harmless — they set direction or **restrict** action.
> For **P5 and P6 it is not**: both authorize a **deletion**, which this ADR
> itself lists as owner-retained. A decision arriving is not consent being
> given. Both are downgraded to **PENDING EXPLICIT OWNER CONFIRMATION** and
> **must not be executed** until the owner states approval directly. The §(c)
> host question is **split**: currency is settled (`spotme-messenger`, per the
> CLAUDE.md directive from PR #138) but **audience remains OPEN as P10**, which
> blocks slice 0's Root Directory repoint (see §(c)).

**Relates to:** [ADR-015](015-compile-time-feature-flags.md) (compile-time
flags), [ADR-016](016-dark-shipping.md) (dark shipping),
[ADR-024](024-discovery-coarse-broadcast-hotfix.md) (coarse-broadcast P0
fence), [ADR-027](027-mobile-native-boundary.md) (mobile-native boundary),
[ADR-033](033-server-only-transport-migration.md) (server-only transport),
PR #132 (design tokens, self-hosted fonts), the Platform Phase 1–6 programmes.

> **Nothing was authorized by writing this ADR**; the owner's P1–P8 answers of
> 2026-08-07 are what adopted it. Spend, activation and product scope remain
> owner-retained: P7 and P8 are refused for now and nothing flips without a
> further, explicit decision. No code, dependency, or configuration changed in
> the mission that produced this document.

---

## Context

Spot Me ships one production frontend: `spotme/web` — ~11,018 lines of
imperative view JavaScript across 14 screens, built by 963 `el()` calls into a
hash router, plus ~7,553 lines of CSS. It works, it is the deployed product,
and its suite is green (1,085 assertions, exit 0, verified 2026-08-07).

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

82 non-empty source files. Test coverage is stated per surface; "fence" means
a test that reads source as **text** and asserts structure (these break on any
file move and are called out again in §Consequences).

#### A.1 Views — all DOM-coupled, all must be rewritten

Every view imports `el()` from `lib/ui.js` and builds DOM imperatively. None
has a component model, none is unit-tested directly.

| View | JS | CSS | `el()` | Direct test coverage |
|---|---:|---:|---:|---|
| `views/chat.js` | 4,672 | 2,844 | 302 | none direct; behaviour covered via `lib/rooms.js` in `media`/`requests`/`viewonce`/`send-failure-visible` |
| `views/moments.js` | 1,463 | 379 | 118 | `moments-nav-fence` (fence), `moments-home` (fence), `moments-media-url` |
| `views/profile.js` | 1,097 | 825 | 140 | none |
| `views/discovery.js` | 750 | 607 | 65 | none direct; `discovery-coarse-broadcast` covers `lib/discovery.js` |
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
1,085 assertions sit below the view layer or in text fences. A React rewrite
therefore has no behavioural safety net at the surface being rewritten — this
is the single largest risk in the whole migration and drives the DoD in §(f).

#### A.2 Application shell — DOM-coupled

| Module | Lines | DOM refs | Coverage |
|---|---:|---:|---|
| `main.js` | 1,025 | 36 | `moments-home` (fence), `moments-nav-fence` (fence) |
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
| **API clients** — `api.js`, `auth-headers.js`, `moments-api.js`, `discovery-api.js`, `groups-api.js`, `group-perms.js` | 6 | 536 | `member-search`, `groups-permissions`, `api-auth` |
| **Pure logic** — `english.js`, `photos.js`, `voice.js` | 3 | 183 | `english-guard` |

**~5,572 lines move with no edit.** Three modules
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
| `lib/blobstore.js`, `lib/media-transfer.js`, `lib/crop.js`, `lib/pullrefresh.js`, `lib/qr-scan.js`, `lib/ui.js`, `lib/push.js`, `lib/translate.js`, `lib/video.js`, `lib/demo.js` | 2,005 | IndexedDB / canvas / gesture / Capacitor / DOM helpers | `blobstore`, `media-transfer`, `qr-scan`, `translate-guards`, `translit`, `push*` |

#### A.5 Design system

`tokens.css` (663) + `fonts.css` (632) + 15 vendored font files, pinned by
`test/design-tokens-fence.test.js` (29 assertions). See §(d).

### B. Test inventory

57 suites in `npm test --prefix web`, 1,085 assertions, exit 0 at `acf48bc`.
By kind:

- **Behavioural, module-level (34):** import a `lib/` module directly or via
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

**The trap this sets for Discovery's slice** is recorded in §(e): web-next's Discovery is
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
   **APPROVED for retirement (owner, 2026-08-07).** Execution is a deletion and
   still needs its own PR. Until it lands it is quarantined by §(g)'s rule that
   no slice may import from it.

   > **STOP — `spotme/app` is not self-contained. Retiring it must not touch
   > `spotme/core`, `spotme/package.json`, or `spotme/web/vendor/spotme-core/`.**
   >
   > `spotme/app/package.json` declares `"spotme-core": "file:.."`, which
   > resolves to `spotme/` itself — `spotme/package.json` is *named*
   > `spotme-core`. Separately, `spotme/web` declares
   > `"spotme-core": "file:vendor/spotme-core"` and its `prebuild` copies
   > `../core` into `vendor/spotme-core/core`. **`web/src/app.js:10` and
   > `web/src/views/chat.js:20` import `spotme-core/core/translit.js`** — the
   > Indic transliteration engine, which `test/translit.test.js` describes as
   > sitting "on the composer's critical path". Deleting the parent along with
   > the app takes out transliteration in the live product.

   **P5b — the P2P residue survives P5 and is NOT resolved here.** `web/src`
   imports exactly one file from spotme-core: `core/translit.js`. The other
   five tracked files — `swarm.js` (Hyperswarm DHT), `room.js`
   (Autobase/Hypercore), `identity.js`, `schema.js`, `index.js` — are the same
   dead P2P stack ADR-033 removed, and they are **committed twice**: once at
   `spotme/core/` and again, vendored, at `spotme/web/vendor/spotme-core/`.
   Retiring `spotme/app` leaves all of it shipping. Pruning core to
   `translit.js` alone touches the live build and the vendoring `prebuild`
   step, so it is a separate change on its own evidence — **open, not folded
   into P5.**
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

**The move itself is slice 0 and touches deployment.** Relocating
`spotme/web` → `apps/web` changes the Vercel Root Directory, which has
previously produced a total outage when wrong. It must ship alone, with no
other change in the PR.

#### Canonical host — CURRENCY settled, AUDIENCE open (P10)

Two different claims were being run together. Separating them:

**CURRENCY — settled.** `spotme-messenger` is git-wired `master` → production
and carries the current code; `spotme-web-v2` promotes nothing on a master push
and is pinned behind. This is established by the Vercel API and ratified as a
**standing directive** in `CLAUDE.md` → "Production hosts" (PR #138,
`d4b15a4`), which instructs that `spotme-messenger` is to be treated as
production and `spotme-web-v2` is not. **Slice 0 follows that directive.**

**AUDIENCE — open. This is P10, and it is not answered.** Which project real
testers actually open is a different question from which is git-wired.
Git-wiring proves currency, not audience. Both can be true at once: a current
project nobody visits, and a stale one people do.

**A circularity to avoid repeating.** This section previously recorded the
audience question as CLOSED by CLAUDE.md. That was invalid reasoning.
CLAUDE.md's standing line cites the same promotion chain
(`17654da → 772a92a → 097bc78 → 356eb627`), the same `target: null`
observation, and the same manual-`--prod` finding as the Vercel API read it was
written from. It is that analysis restated, not a second source agreeing with
it — so it cannot corroborate the pipeline read against a conflicting one. A
two-source conflict was resolved by counting one source twice.

**RETRACTED: the "error trail" claim.** This section also asserted that the
eight `spotme-web-v2` references across five reports were the residue of
sessions misreading a green check. **That is false, and checking the reports
refutes it.** Three of the five name the project as an *assigned mission
target*:

- `2026-08-07-deploy-drive.md` — "**Mission:** deploy `api` (Railway) and
  `spotme-web-v2` (Vercel) from `master`"
- `2026-08-06-land-deploy-drive.md` — numbered task 4, "Deploy `spotme-web-v2`"
- `2026-08-06-land-and-iphone.md` — numbered task 4a, "Deploy the web surface
  to `spotme-web-v2`"

Those sessions were *directed* there. That is genuine evidence about where work
was being pointed, and it supports rather than undermines the
audience-is-`web-v2` reading. Characterising it as error was an over-claim made
while defending a conclusion.

**No platform evidence exists to settle it.** Vercel Web Analytics is
**disabled on both projects** (checked 2026-08-07,
`web_analytics_not_enabled`), and neither has a custom domain. There is no
repository fact and no platform fact that can close P10 — only the owner can.

**What turns on it.** If the audience is on `spotme-web-v2`, the CLAUDE.md
directive is still the right thing to *obey* but the wrong thing to *hard-wire*:
slice 0 would be repointing the Root Directory away from where people are, and
the correct move would be to migrate the audience or move the git integration
first. **Slice 0's final step should not run until P10 is answered.**

Both Spot Me projects are connected to the repository and both build on every
master push — one commit produces two builds. They are not equivalent:

| | `spotme-messenger` | `spotme-web-v2` |
|---|---|---|
| master merge | **`target: "production"`**, automatically | `target: null` (preview only) |
| Production deploys | via git integration | **only manual CLI pushes** (`actor: claude-code_2-1-224_agent`, `gitRootDirectory: spotme/web`) |
| Domains | `spotme-messenger.vercel.app` (+ team/branch aliases) | `spotme-web-v2.vercel.app` (+ aliases) |
| `framework` | `null` | `vite` |

Verified 2026-08-07 against the Vercel API: merges of #134 (`17654da`), #135
(`772a92a`), #136 (`097bc78`) and this ADR's own `356eb62` each produced a
**production** deployment on `spotme-messenger` and a **preview** on
`spotme-web-v2`.

**The duplicate has a repository cost, which is why it is not merely
redundant.** `spotme-web-v2` carries `NODE_ENV` in its Vercel environment; with
it set, `npm install` omits devDependencies, `vite` is absent and the build
dies at exit 127. The fix had to be made in the **shared**
`spotme/web/vercel.json` (`--include=dev`) — one repository file bent to
accommodate one duplicate project. Slice 0 inherits that wart.

**P9 — retiring `spotme-web-v2` is the CLAUDE.md direction, but should wait on
P10.** The standing line calls it "stale, misconfigured, and being retired", and
retiring it would end the double builds and free `--include=dev` from the shared
`vercel.json`. **But if P10 shows the audience is there, retiring it deletes the
surface people use** — the direction would need revisiting, not executing faster.
Deleting a Vercel project is owner-retained regardless; this ADR records the
direction and does not execute it.

### (d) Tailwind adoption and the #132 tokens

**Decision: DEFERRED (owner, 2026-08-07). Slices 0 and 1 ship WITHOUT
Tailwind**, on plain CSS against the #132 tokens — the pattern web-next's five
domain CSS files already use. Revisited at slice 2 against the evidence test
below.

*Why the deferral is right, and why this ADR's original position was weaker.*
The draft proposed Tailwind v4 up front. That was adopting a utility layer with
**zero measured evidence that plain CSS + tokens fails**, while #132's tokens
had just landed — churning the design system twice in consecutive slices. A
working pattern already exists in the tree; the ladder says use it.

**Revisit trigger, so "later" does not become "never."** After slice 1 ships,
count the spacing, colour and type values in its React CSS that are **not**
drawn from a `tokens.css` custom property. A small count means plain CSS held
and Tailwind stays unadopted. A large count is measured drift, and Tailwind
gets its own PR on that evidence. The test is countable, not a matter of taste.

*The plan below is what adoption WOULD look like if the trigger fires; it is
not in force.* Retained because the token carry-over is the hard part and the
analysis should not be redone.

**If adopted: Tailwind CSS v4, tokens-first, scoped to
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
the 963 existing `el()` call sites already carry class strings that have no
utility vocabulary to land on.

*Rejected — CSS-in-JS (styled-components / emotion).* Runtime cost on a mobile
WebView, and it would strand `tokens.css` as a second parallel system —
recreating the two-sources-of-truth problem #132's fence exists to prevent.

*Rejected — Tailwind v3 + `tailwind.config.js`.* Requires duplicating every
token into JavaScript. Same objection, more typing.

**This is a new dependency and therefore cannot be executed under the
constraints of the mission that wrote this ADR.** It needs its own PR.

### (e) Slice order — EXCHANGE first (amended 2026-08-07)

**Decision: slice 1 is EXCHANGE. Discovery moves to slice 5.** This reverses
the original "Discovery first (beachhead exists)" call recorded below.

| # | Slice | Why here |
|---|---|---|
| 0 | **Dark-fence rewrite FIRST**, then monorepo move + React 19 + tokens | Infrastructure. No user-visible change. Ships alone. **Task order inside the PR is load-bearing** — see below. |
| 1 | **Exchange** (`packages/ui/exchange`) + the **island host** | **Greenfield — see below.** |
| 2 | Contacts · Notifications · Stories | Small, low-coupling, no realtime. Widens the component library cheaply. **Built (dark)** on `feat/slice-2-small-surfaces`: `packages/ui/{contacts,notifications,stories}` behind `spotme.ui.contacts` / `.notifications` / `.stories`, all default OFF; legacy views keep the route, one-line flag branch each. |
| 3 | Groups (list · new · manage) — **BUILT (dark)**, PR `feat/slice-3-groups`: `packages/ui/groups/` behind `spotme.ui.groups` (default OFF, read only in `apps/web/src/views/groups-island.js`); legacy views unchanged except the one-line flag branch; `lib/group-perms.js` reused via an injected port | Self-contained; `group-perms` already framework-free and tested. |
| 4 | Profile · Settings | Large but shallow; forces the media/crop/photoedit port boundaries. **Built (dark)** on `feat/slice-4-profile`: `packages/ui/profile` behind `spotme.ui.profile`, default OFF; media (upload/crop/AI avatars/voice clone) and the username registry stay app-side in `island-adapters-profile.js` + `voice-clone-sheet.js` — the package never sees a File, canvas, mic stream, or fetch. |
| 5 | **Discovery** (`views/discovery.js`, `lib/discovery.js`) | Moved here from slice 1. A working screen with **no view-level tests**, carrying the ADR-024 P0 privacy fence. |
| 6 | Inbox — **BUILT (dark)**, PR `feat/slice-6-inbox`: `packages/ui/inbox/` behind `spotme.ui.inbox` (default OFF, read only in `apps/web/src/views/inbox-island.js`); legacy view unchanged except the one-line flag branch; `lib/rooms.js` reused via the injected port, realtime crosses the port as a subscription with pre-shaped rows | Chat-adjacent; the last step before chat. |
| 7 | Moments | Live product surface (PR #126) with two structural fences to re-satisfy. |
| **last** | **Chat, and every crypto-facing surface (verify, safety numbers)** | Chat is 4,672 lines with 302 `el()` calls and **no view-level tests**; crypto UI regressions are the class of bug this product can least afford. **Session 1 of N built (dark)** on `feat/chat-react-s1`: characterization tests first (`apps/web/test/chat-characterization.test.js`, 37 assertions pinning the rooms-engine + view contract), then `packages/ui/chat` (message list + composer core only) behind `spotme.ui.chat` (default OFF, read only in `views/chat-island.js`); legacy `views/chat.js` carries the one-line branch; media/sheets/voice/calls/translation UI and all crypto UI remain legacy-only and are LATER sessions. **Session 2 of N built (dark)** on `feat/chat-react-s2` (base s1): media rows (photo, view-once locked tile with mask-only rendering, voice playback, file, location), attach sheet, long-press message sheet (reply/edit/delete/react/copy), reaction chips, reply composition — the adapter split into `chat-island-port.js` (ChatPort over the same rooms/db calls) + `chat-island-media.js` (all raw File/canvas/MediaRecorder/geolocation/clipboard APIs); the package stays fence-forbidden from storage/fetch and receives display-ready URLs/labels only. View-once burn-before-reveal is pinned by `apps/web/test/chat-viewonce-react.test.js` (13 assertions). **Session 3 of N built (dark)** on `feat/chat-react-s3` (base s2): translation + transliteration composer modes (header 文A/🌐 switches + language chips, live conversion preview, translate-before-send shipping the legacy `tr:{lang,text}` envelope, translit-as-reading-aid never rewriting the outgoing text), incoming-message auto-translation lines (instant `tr` path + detection path), plus polish — Forward/Share sheet items (legacy canForward gate), swipe-to-reply, double-tap ❤️, video-row real playback, decorative voice bars. The engines (`lib/translate.js`, `spotme-core/core/translit.js`) are driven UNCHANGED through NEW `views/chat-island-lang.js` (injected deps; call shapes pinned by `apps/web/test/chat-lang-react.test.js`, 8 tests); the package sees strings only (`ComposerView`/`TranslationLine`). **Session 4 of N built (dark)** on `feat/chat-react-s4` (base s3): the crypto-facing surfaces. NEW `packages/ui/verify` (VerifyShell, phases loading→ready with the honest e2e_v1 copy, digits, QR, CHANGED-key Accept/Keep — no dismiss — scan verdicts, enforcement-aware footer) behind **`spotme.ui.verify`** (default OFF, read only in NEW `views/verify-island.js`; legacy `views/verify.js` carries the one-line branch); the adapter REUSES the legacy engine calls verbatim (`safetyNumber`, `readRecord`/`applyToRecord`, `recordVerification`, `setRoomTrust`, `encodeVerificationPayload`/`verifyScannedPayload`, camera overlay app-side) and every crypto value crosses the port as a display string — digits pre-formatted, QR as a data: URL; the package imports no crypto module (fence extended to `verify`). Chat gained its crypto rows via `ChatSnapshot.security` (encryption-claim line + Verify entry, undecryptable/identity-key warning banner) shaped by NEW `views/chat-island-crypto.js` (reads `identityStatus()` only; legacy sentences verbatim) with the legacy undecryptable state machine (wrong-key upgrades no-key, first opened frame clears) in the port. ADR-008 §12 untouched (pinned by `verify-flag-parity`). Still legacy-only: calls, live location sharing UI, whole-thread transliteration reading lines, sender "Viewing now" ring, group management inside chat. |
| **last** | **Chat, and every crypto-facing surface (verify, safety numbers)** | Chat is 4,672 lines with 302 `el()` calls and **no view-level tests**; crypto UI regressions are the class of bug this product can least afford. |

#### Why Exchange, and why the original reasoning was wrong

**There is no vanilla Exchange screen anywhere in the web app.** No
`views/exchange.js`, no route in `ROUTES`, no nav entry. Slice 1 is therefore
**greenfield**, and every risk the migration is built to manage simply does not
arise:

- **No legacy path to keep alive.** DoD #2 ("legacy view stays in `ROUTES`,
  unmodified and reachable") has nothing to preserve.
- **No flag-off fallback to get right.** With the flag off the surface is
  simply absent, exactly as today.
- **No persisted-shape risk.** The §(g) rollback rule — a slice may never
  change a persisted shape — is trivially satisfied when nothing was ever
  persisted for this surface.
- **No rewrite risk.** Nothing is being replaced, so there is no behaviour to
  regress and no missing characterization tests to regret (§A.1).

That leaves slice 1 proving exactly what a first slice should prove — the
island host, the flag mechanism, the package boundary, the DoD, the rollback
drill — **against a surface where a mistake costs nothing a user can see.**

**What the original Discovery-first argument got wrong.** It reasoned from
"the beachhead exists" and from ADR-022's product ordering. Both are true and
neither is about migration risk. Discovery is a *working, shipped* screen with
**zero view-level test coverage** (§A.1) and it carries the **ADR-024 P0
coarse-broadcast fence** — so it combined the highest rewrite risk in the
programme with the only P0 privacy gate, and put both in the slice where the
mechanism itself was still unproven. Sequencing product priority ahead of
migration risk was the error; the two are independent axes.

**Discovery at slice 5 is a known and separately accepted risk.** It still
requires: scope pinned to today's live endpoints (no Phase 2 backend, no
Typesense — P7 remains **no**); legacy Discovery intact and rendering with the
flag off; and `test/discovery-coarse-broadcast.test.js` passing against
**both** implementations in one CI job. Moving it later does not soften any of
that — it means the mechanism enforcing it has four slices of evidence behind
it first.

#### The island host lands with slice 1

Deferred in slice 0 for a concrete reason: with `packages/ui` dark, a mount
point has nothing to mount, and `liveEntryDarkPackageImports()` fails the
moment `apps/web/src/main.js` imports `@spotme/ui`. Building it early would
have meant weakening a fence slice 0 had just strengthened. Slice 1 is its
first real consumer, so it arrives there — behind `spotme.ui.exchange`,
default off.

#### Unchanged by this amendment

The **per-slice definition of done** (§(f), nine items) and the **rollback
rule** (§(g), three tiers, with "a migrated slice MUST NOT change any
persisted shape" load-bearing) apply to every slice exactly as written.

<details>
<summary>Superseded: the original Discovery-first decision (kept for the record)</summary>

The original text read: *"the default holds — slice 1 is Discovery — but
scoped to the LEGACY live Discovery surface, explicitly excluding any Phase 2
activation."* Its supporting argument was that `web-next/src/discovery/` is
built against the **Phase 2** backend — PostGIS people-search, a Typesense
`SearchPort`, provider ports — while `DiscoveryModule` is not imported by
`AppModule`, so shipping it as-is would be a Phase 2 activation with new spend.
**That trap analysis remains correct and still governs slice 5.** What changed
is the ordering: greenfield before rewrite.

A smaller pathfinder slice was also considered and rejected at the time, on the
grounds that anything small enough to be a pathfinder proves nothing. Exchange
answers that objection properly — it is greenfield *and* a full surface.

</details>

**Slice 0's internal order is part of the decision, not an implementation
detail (owner answers, 2026-08-07):**

1. **Rewrite the five backend `*-dark-fences.spec.ts` suites FIRST** — owned by
   slice 0, no longer unassigned. They assert web-next's isolation and
   non-deployment; dissolving web-next into `packages/` removes their premise,
   and with it the only thing keeping Phase 2–6 dark. Rewritten to fence the
   new layout (the four dark domains stay unmounted), and **tamper-checked** —
   each shown to fail when the property it guards is deliberately broken, or it
   has passed vacuously.
2. Then the monorepo move, `packages/core` extraction, React 19, island host,
   tokens, and the remaining four text fences repaired and tamper-checked.
3. Vercel Root Directory repointed — **BLOCKED on P10** (§(c)). The CLAUDE.md
   directive names `spotme-messenger`, but that directive settles *currency*,
   not *audience*; repointing before P10 risks wiring the build away from where
   testers actually are. When it runs it is last in the PR, and afterwards the
   promotion must be verified git-triggered (`githubCommitRef: master`,
   `githubDeployment: 1`, no `actor`) rather than a manual `--prod` run.

   **Steps 1 and 2 are not blocked by P10** — the fence rewrites and the
   package restructure are host-agnostic. Only the repoint waits.

Nothing else ships in that PR. Tailwind is **not** in slice 0 (P4 deferred).

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
3. **Legacy suite unchanged and green.** 1,085 assertions is the regression
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

**Positive.** One React major across web and native (a). ~5,572 lines of
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

## Owner decisions — ANSWERED 2026-08-07

| # | Item | Decision |
|---|---|---|
| P1 | Adopt this migration plan | **YES** — adopted; this ADR is ACCEPTED |
| P2 | React 19 upgrade for web-next | **YES** — 18.3 would fork the major against `spotme/app`'s 19.2.3 |
| P3 | Monorepo move + Vercel Root Directory change | **YES in principle.** Move and restructure unblocked; the **Root Directory repoint waits on P10** (§(c)) |
| P4 | Tailwind v4 adoption | **DEFERRED** — slices 0–1 ship on plain CSS + tokens; revisit at slice 2 against the countable drift test (§(d)) |
| P5 | Retire `spotme/app` | **PENDING EXPLICIT OWNER CONFIRMATION** — a deletion, relayed as a recommendation and over-recorded as a decision. Do not execute. Also subject to the STOP in §(b): never touch `spotme/core`, `spotme/package.json`, or `web/vendor/spotme-core/` |
| P6 | Commit or remove `spotme/mobile` | **PENDING EXPLICIT OWNER CONFIRMATION** — a deletion with **no git safety net** (0 tracked files, so `rm` is unrecoverable). Do not execute |
| P7 | Phase 2 Discovery activation (Typesense) | **NO, not now** — spend + activation. Discovery is now slice 5 (§(e)) and stays pinned to live endpoints |
| P8 | Flag flips to real users | **NOT YET** — nothing flips until a slice passes all nine DoD items |

### Still open after P1–P8

| # | Item | Why still open |
|---|---|---|
| P5b | Prune `spotme/core` to `translit.js`; drop the vendored P2P copy | Touches the live build and the `prebuild` vendoring step — needs its own evidence and PR (§(b)) |
| P9 | Retire or demote the duplicate `spotme-web-v2` Vercel project | Ends double builds and allows the `--include=dev` workaround out of the shared `vercel.json`; deleting a project is owner-retained (§(c)) |
| P10 | **OPEN — blocks slice 0's Root Directory repoint.** Which project do real testers open? | Currency is settled (`spotme-messenger`); **audience is not**. CLAUDE.md restates the pipeline read, so it cannot corroborate it. Web Analytics is disabled on both projects and neither has a custom domain — no repository or platform fact can close this. Owner-only. |
| P11 | Characterization tests before each rewrite — appetite? | §A.1: no view-level coverage exists; the DoD assumes tests-first, which costs time |

---

## Evidence

All verified against `master` `acf48bc`, 2026-08-07:

- `npm test --prefix spotme/web` → **1,085 assertions, exit 0**, 57 suites.
- Surface inventory: `spotme/web/src`, 80 non-empty files; per-file line counts
  and `el()` counts in §A.
- Framework-free classification: DOM-reference grep (`document.`, `window.`,
  `localStorage`, `navigator.`, `addEventListener`, `HTMLElement`) plus an
  import-graph trace showing `lib/crypto`, `lib/transport`, `lib/calls`,
  `lib/ai` reach only `../api.js`, `../auth-headers.js`,
  `../socket-transport.js` and siblings.
- View DOM coupling: all 14 views import `el()` from `lib/ui.js`; 963 call sites.
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
fast-forwarded to `acf48bc` before any inventory was taken. The ADR index
`docs/adr/README.md` is **stale** — it ends at 028 and does not list ADR-029,
033, or 034. Numbers 030–032 were never used; this ADR takes **035**.
# ADR-035 — Frontend migration to React + TypeScript: the executable plan

**Status: ACCEPTED (plan) — P5 and P6 PENDING owner confirmation; host CURRENCY
settled, AUDIENCE open as P10; **slice 1 amended to EXCHANGE**. Amended 2026-08-07** · **Date:** 2026-08-07
**Verified against `master` `acf48bc`**

> **Acceptance adopts the PLAN. It activates nothing.** P4 (Tailwind) is
> **deferred**, P7 (Phase 2 activation) and P8 (flag flips) are **refused for
> now**. Recorded in `handbook/DECISIONS.md` → "Frontend migration — ADR-035
> decisions P1–P8".
>
> **CORRECTION 2026-08-07 — P5, P6 and the §(c) host pick are PENDING, not
> decided.** The eight answers reached this ADR as a *recommendation table*
> ("my recommendation", "My read", "If you agree") and were recorded as an
> owner decision. That is a stronger claim than was given. For P1–P4, P7 and
> P8 the over-reading is harmless — they set direction or **restrict** action.
> For **P5 and P6 it is not**: both authorize a **deletion**, which this ADR
> itself lists as owner-retained. A decision arriving is not consent being
> given. Both are downgraded to **PENDING EXPLICIT OWNER CONFIRMATION** and
> **must not be executed** until the owner states approval directly. The §(c)
> host question is **split**: currency is settled (`spotme-messenger`, per the
> CLAUDE.md directive from PR #138) but **audience remains OPEN as P10**, which
> blocks slice 0's Root Directory repoint (see §(c)).

**Relates to:** [ADR-015](015-compile-time-feature-flags.md) (compile-time
flags), [ADR-016](016-dark-shipping.md) (dark shipping),
[ADR-024](024-discovery-coarse-broadcast-hotfix.md) (coarse-broadcast P0
fence), [ADR-027](027-mobile-native-boundary.md) (mobile-native boundary),
[ADR-033](033-server-only-transport-migration.md) (server-only transport),
PR #132 (design tokens, self-hosted fonts), the Platform Phase 1–6 programmes.

> **Nothing was authorized by writing this ADR**; the owner's P1–P8 answers of
> 2026-08-07 are what adopted it. Spend, activation and product scope remain
> owner-retained: P7 and P8 are refused for now and nothing flips without a
> further, explicit decision. No code, dependency, or configuration changed in
> the mission that produced this document.

---

## Context

Spot Me ships one production frontend: `spotme/web` — ~11,018 lines of
imperative view JavaScript across 14 screens, built by 963 `el()` calls into a
hash router, plus ~7,553 lines of CSS. It works, it is the deployed product,
and its suite is green (1,085 assertions, exit 0, verified 2026-08-07).

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

82 non-empty source files. Test coverage is stated per surface; "fence" means
a test that reads source as **text** and asserts structure (these break on any
file move and are called out again in §Consequences).

#### A.1 Views — all DOM-coupled, all must be rewritten

Every view imports `el()` from `lib/ui.js` and builds DOM imperatively. None
has a component model, none is unit-tested directly.

| View | JS | CSS | `el()` | Direct test coverage |
|---|---:|---:|---:|---|
| `views/chat.js` | 4,672 | 2,844 | 302 | none direct; behaviour covered via `lib/rooms.js` in `media`/`requests`/`viewonce`/`send-failure-visible` |
| `views/moments.js` | 1,463 | 379 | 118 | `moments-nav-fence` (fence), `moments-home` (fence), `moments-media-url` |
| `views/profile.js` | 1,097 | 825 | 140 | none |
| `views/discovery.js` | 750 | 607 | 65 | none direct; `discovery-coarse-broadcast` covers `lib/discovery.js` |
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
1,085 assertions sit below the view layer or in text fences. A React rewrite
therefore has no behavioural safety net at the surface being rewritten — this
is the single largest risk in the whole migration and drives the DoD in §(f).

#### A.2 Application shell — DOM-coupled

| Module | Lines | DOM refs | Coverage |
|---|---:|---:|---|
| `main.js` | 1,025 | 36 | `moments-home` (fence), `moments-nav-fence` (fence) |
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
| **API clients** — `api.js`, `auth-headers.js`, `moments-api.js`, `discovery-api.js`, `groups-api.js`, `group-perms.js` | 6 | 536 | `member-search`, `groups-permissions`, `api-auth` |
| **Pure logic** — `english.js`, `photos.js`, `voice.js` | 3 | 183 | `english-guard` |

**~5,572 lines move with no edit.** Three modules
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
| `lib/blobstore.js`, `lib/media-transfer.js`, `lib/crop.js`, `lib/pullrefresh.js`, `lib/qr-scan.js`, `lib/ui.js`, `lib/push.js`, `lib/translate.js`, `lib/video.js`, `lib/demo.js` | 2,005 | IndexedDB / canvas / gesture / Capacitor / DOM helpers | `blobstore`, `media-transfer`, `qr-scan`, `translate-guards`, `translit`, `push*` |

#### A.5 Design system

`tokens.css` (663) + `fonts.css` (632) + 15 vendored font files, pinned by
`test/design-tokens-fence.test.js` (29 assertions). See §(d).

### B. Test inventory

57 suites in `npm test --prefix web`, 1,085 assertions, exit 0 at `acf48bc`.
By kind:

- **Behavioural, module-level (34):** import a `lib/` module directly or via
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

**The trap this sets for Discovery's slice** is recorded in §(e): web-next's Discovery is
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
   **APPROVED for retirement (owner, 2026-08-07).** Execution is a deletion and
   still needs its own PR. Until it lands it is quarantined by §(g)'s rule that
   no slice may import from it.

   > **STOP — `spotme/app` is not self-contained. Retiring it must not touch
   > `spotme/core`, `spotme/package.json`, or `spotme/web/vendor/spotme-core/`.**
   >
   > `spotme/app/package.json` declares `"spotme-core": "file:.."`, which
   > resolves to `spotme/` itself — `spotme/package.json` is *named*
   > `spotme-core`. Separately, `spotme/web` declares
   > `"spotme-core": "file:vendor/spotme-core"` and its `prebuild` copies
   > `../core` into `vendor/spotme-core/core`. **`web/src/app.js:10` and
   > `web/src/views/chat.js:20` import `spotme-core/core/translit.js`** — the
   > Indic transliteration engine, which `test/translit.test.js` describes as
   > sitting "on the composer's critical path". Deleting the parent along with
   > the app takes out transliteration in the live product.

   **P5b — the P2P residue survives P5 and is NOT resolved here.** `web/src`
   imports exactly one file from spotme-core: `core/translit.js`. The other
   five tracked files — `swarm.js` (Hyperswarm DHT), `room.js`
   (Autobase/Hypercore), `identity.js`, `schema.js`, `index.js` — are the same
   dead P2P stack ADR-033 removed, and they are **committed twice**: once at
   `spotme/core/` and again, vendored, at `spotme/web/vendor/spotme-core/`.
   Retiring `spotme/app` leaves all of it shipping. Pruning core to
   `translit.js` alone touches the live build and the vendoring `prebuild`
   step, so it is a separate change on its own evidence — **open, not folded
   into P5.**
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

**The move itself is slice 0 and touches deployment.** Relocating
`spotme/web` → `apps/web` changes the Vercel Root Directory, which has
previously produced a total outage when wrong. It must ship alone, with no
other change in the PR.

#### Canonical host — CURRENCY settled, AUDIENCE open (P10)

Two different claims were being run together. Separating them:

**CURRENCY — settled.** `spotme-messenger` is git-wired `master` → production
and carries the current code; `spotme-web-v2` promotes nothing on a master push
and is pinned behind. This is established by the Vercel API and ratified as a
**standing directive** in `CLAUDE.md` → "Production hosts" (PR #138,
`d4b15a4`), which instructs that `spotme-messenger` is to be treated as
production and `spotme-web-v2` is not. **Slice 0 follows that directive.**

**AUDIENCE — open. This is P10, and it is not answered.** Which project real
testers actually open is a different question from which is git-wired.
Git-wiring proves currency, not audience. Both can be true at once: a current
project nobody visits, and a stale one people do.

**A circularity to avoid repeating.** This section previously recorded the
audience question as CLOSED by CLAUDE.md. That was invalid reasoning.
CLAUDE.md's standing line cites the same promotion chain
(`17654da → 772a92a → 097bc78 → 356eb627`), the same `target: null`
observation, and the same manual-`--prod` finding as the Vercel API read it was
written from. It is that analysis restated, not a second source agreeing with
it — so it cannot corroborate the pipeline read against a conflicting one. A
two-source conflict was resolved by counting one source twice.

**RETRACTED: the "error trail" claim.** This section also asserted that the
eight `spotme-web-v2` references across five reports were the residue of
sessions misreading a green check. **That is false, and checking the reports
refutes it.** Three of the five name the project as an *assigned mission
target*:

- `2026-08-07-deploy-drive.md` — "**Mission:** deploy `api` (Railway) and
  `spotme-web-v2` (Vercel) from `master`"
- `2026-08-06-land-deploy-drive.md` — numbered task 4, "Deploy `spotme-web-v2`"
- `2026-08-06-land-and-iphone.md` — numbered task 4a, "Deploy the web surface
  to `spotme-web-v2`"

Those sessions were *directed* there. That is genuine evidence about where work
was being pointed, and it supports rather than undermines the
audience-is-`web-v2` reading. Characterising it as error was an over-claim made
while defending a conclusion.

**No platform evidence exists to settle it.** Vercel Web Analytics is
**disabled on both projects** (checked 2026-08-07,
`web_analytics_not_enabled`), and neither has a custom domain. There is no
repository fact and no platform fact that can close P10 — only the owner can.

**What turns on it.** If the audience is on `spotme-web-v2`, the CLAUDE.md
directive is still the right thing to *obey* but the wrong thing to *hard-wire*:
slice 0 would be repointing the Root Directory away from where people are, and
the correct move would be to migrate the audience or move the git integration
first. **Slice 0's final step should not run until P10 is answered.**

Both Spot Me projects are connected to the repository and both build on every
master push — one commit produces two builds. They are not equivalent:

| | `spotme-messenger` | `spotme-web-v2` |
|---|---|---|
| master merge | **`target: "production"`**, automatically | `target: null` (preview only) |
| Production deploys | via git integration | **only manual CLI pushes** (`actor: claude-code_2-1-224_agent`, `gitRootDirectory: spotme/web`) |
| Domains | `spotme-messenger.vercel.app` (+ team/branch aliases) | `spotme-web-v2.vercel.app` (+ aliases) |
| `framework` | `null` | `vite` |

Verified 2026-08-07 against the Vercel API: merges of #134 (`17654da`), #135
(`772a92a`), #136 (`097bc78`) and this ADR's own `356eb62` each produced a
**production** deployment on `spotme-messenger` and a **preview** on
`spotme-web-v2`.

**The duplicate has a repository cost, which is why it is not merely
redundant.** `spotme-web-v2` carries `NODE_ENV` in its Vercel environment; with
it set, `npm install` omits devDependencies, `vite` is absent and the build
dies at exit 127. The fix had to be made in the **shared**
`spotme/web/vercel.json` (`--include=dev`) — one repository file bent to
accommodate one duplicate project. Slice 0 inherits that wart.

**P9 — retiring `spotme-web-v2` is the CLAUDE.md direction, but should wait on
P10.** The standing line calls it "stale, misconfigured, and being retired", and
retiring it would end the double builds and free `--include=dev` from the shared
`vercel.json`. **But if P10 shows the audience is there, retiring it deletes the
surface people use** — the direction would need revisiting, not executing faster.
Deleting a Vercel project is owner-retained regardless; this ADR records the
direction and does not execute it.

### (d) Tailwind adoption and the #132 tokens

**Decision: DEFERRED (owner, 2026-08-07). Slices 0 and 1 ship WITHOUT
Tailwind**, on plain CSS against the #132 tokens — the pattern web-next's five
domain CSS files already use. Revisited at slice 2 against the evidence test
below.

*Why the deferral is right, and why this ADR's original position was weaker.*
The draft proposed Tailwind v4 up front. That was adopting a utility layer with
**zero measured evidence that plain CSS + tokens fails**, while #132's tokens
had just landed — churning the design system twice in consecutive slices. A
working pattern already exists in the tree; the ladder says use it.

**Revisit trigger, so "later" does not become "never."** After slice 1 ships,
count the spacing, colour and type values in its React CSS that are **not**
drawn from a `tokens.css` custom property. A small count means plain CSS held
and Tailwind stays unadopted. A large count is measured drift, and Tailwind
gets its own PR on that evidence. The test is countable, not a matter of taste.

*The plan below is what adoption WOULD look like if the trigger fires; it is
not in force.* Retained because the token carry-over is the hard part and the
analysis should not be redone.

**If adopted: Tailwind CSS v4, tokens-first, scoped to
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
the 963 existing `el()` call sites already carry class strings that have no
utility vocabulary to land on.

*Rejected — CSS-in-JS (styled-components / emotion).* Runtime cost on a mobile
WebView, and it would strand `tokens.css` as a second parallel system —
recreating the two-sources-of-truth problem #132's fence exists to prevent.

*Rejected — Tailwind v3 + `tailwind.config.js`.* Requires duplicating every
token into JavaScript. Same objection, more typing.

**This is a new dependency and therefore cannot be executed under the
constraints of the mission that wrote this ADR.** It needs its own PR.

### (e) Slice order — EXCHANGE first (amended 2026-08-07)

**Decision: slice 1 is EXCHANGE. Discovery moves to slice 5.** This reverses
the original "Discovery first (beachhead exists)" call recorded below.

| # | Slice | Why here |
|---|---|---|
| 0 | **Dark-fence rewrite FIRST**, then monorepo move + React 19 + tokens | Infrastructure. No user-visible change. Ships alone. **Task order inside the PR is load-bearing** — see below. |
| 1 | **Exchange** (`packages/ui/exchange`) + the **island host** | **Greenfield — see below.** |
| 2 | Contacts · Notifications · Stories | Small, low-coupling, no realtime. Widens the component library cheaply. **Built (dark)** on `feat/slice-2-small-surfaces`: `packages/ui/{contacts,notifications,stories}` behind `spotme.ui.contacts` / `.notifications` / `.stories`, all default OFF; legacy views keep the route, one-line flag branch each. |
| 3 | Groups (list · new · manage) | Self-contained; `group-perms` already framework-free and tested. |
| 4 | Profile · Settings | Large but shallow; forces the media/crop/photoedit port boundaries. **Built (dark)** on `feat/slice-4-profile`: `packages/ui/profile` behind `spotme.ui.profile`, default OFF; media (upload/crop/AI avatars/voice clone) and the username registry stay app-side in `island-adapters-profile.js` + `voice-clone-sheet.js` — the package never sees a File, canvas, mic stream, or fetch. |
| 5 | **Discovery** (`views/discovery.js`, `lib/discovery.js`) | Moved here from slice 1. A working screen with **no view-level tests**, carrying the ADR-024 P0 privacy fence. |
| 5 | **Discovery** (`views/discovery.js`, `lib/discovery.js`) | Moved here from slice 1. A working screen with **no view-level tests**, carrying the ADR-024 P0 privacy fence. **Built (dark)** on `feat/slice-5-discovery`: `packages/ui/discovery-live` behind `spotme.ui.discovery` (default OFF), pinned to today's lobby surface — the Phase-2 `packages/ui/discovery` (people-search contract) stays dark and untouched. `lib/discovery.js` reused via ports, unmodified; no coordinate of any kind crosses the port (labels + relative offsets only); `discovery-coarse-broadcast` extended to cover both paths in one run; the live Google map remains legacy-only (the package fence forbids external scripts — React path renders the locked drawn radar). |
| 6 | Inbox | Chat-adjacent; the last step before chat. |
| 7 | Moments | Live product surface (PR #126) with two structural fences to re-satisfy. |
| **last** | **Chat, and every crypto-facing surface (verify, safety numbers)** | Chat is 4,672 lines with 302 `el()` calls and **no view-level tests**; crypto UI regressions are the class of bug this product can least afford. |

#### Why Exchange, and why the original reasoning was wrong

**There is no vanilla Exchange screen anywhere in the web app.** No
`views/exchange.js`, no route in `ROUTES`, no nav entry. Slice 1 is therefore
**greenfield**, and every risk the migration is built to manage simply does not
arise:

- **No legacy path to keep alive.** DoD #2 ("legacy view stays in `ROUTES`,
  unmodified and reachable") has nothing to preserve.
- **No flag-off fallback to get right.** With the flag off the surface is
  simply absent, exactly as today.
- **No persisted-shape risk.** The §(g) rollback rule — a slice may never
  change a persisted shape — is trivially satisfied when nothing was ever
  persisted for this surface.
- **No rewrite risk.** Nothing is being replaced, so there is no behaviour to
  regress and no missing characterization tests to regret (§A.1).

That leaves slice 1 proving exactly what a first slice should prove — the
island host, the flag mechanism, the package boundary, the DoD, the rollback
drill — **against a surface where a mistake costs nothing a user can see.**

**What the original Discovery-first argument got wrong.** It reasoned from
"the beachhead exists" and from ADR-022's product ordering. Both are true and
neither is about migration risk. Discovery is a *working, shipped* screen with
**zero view-level test coverage** (§A.1) and it carries the **ADR-024 P0
coarse-broadcast fence** — so it combined the highest rewrite risk in the
programme with the only P0 privacy gate, and put both in the slice where the
mechanism itself was still unproven. Sequencing product priority ahead of
migration risk was the error; the two are independent axes.

**Discovery at slice 5 is a known and separately accepted risk.** It still
requires: scope pinned to today's live endpoints (no Phase 2 backend, no
Typesense — P7 remains **no**); legacy Discovery intact and rendering with the
flag off; and `test/discovery-coarse-broadcast.test.js` passing against
**both** implementations in one CI job. Moving it later does not soften any of
that — it means the mechanism enforcing it has four slices of evidence behind
it first.

#### The island host lands with slice 1

Deferred in slice 0 for a concrete reason: with `packages/ui` dark, a mount
point has nothing to mount, and `liveEntryDarkPackageImports()` fails the
moment `apps/web/src/main.js` imports `@spotme/ui`. Building it early would
have meant weakening a fence slice 0 had just strengthened. Slice 1 is its
first real consumer, so it arrives there — behind `spotme.ui.exchange`,
default off.

#### Unchanged by this amendment

The **per-slice definition of done** (§(f), nine items) and the **rollback
rule** (§(g), three tiers, with "a migrated slice MUST NOT change any
persisted shape" load-bearing) apply to every slice exactly as written.

<details>
<summary>Superseded: the original Discovery-first decision (kept for the record)</summary>

The original text read: *"the default holds — slice 1 is Discovery — but
scoped to the LEGACY live Discovery surface, explicitly excluding any Phase 2
activation."* Its supporting argument was that `web-next/src/discovery/` is
built against the **Phase 2** backend — PostGIS people-search, a Typesense
`SearchPort`, provider ports — while `DiscoveryModule` is not imported by
`AppModule`, so shipping it as-is would be a Phase 2 activation with new spend.
**That trap analysis remains correct and still governs slice 5.** What changed
is the ordering: greenfield before rewrite.

A smaller pathfinder slice was also considered and rejected at the time, on the
grounds that anything small enough to be a pathfinder proves nothing. Exchange
answers that objection properly — it is greenfield *and* a full surface.

</details>

**Slice 0's internal order is part of the decision, not an implementation
detail (owner answers, 2026-08-07):**

1. **Rewrite the five backend `*-dark-fences.spec.ts` suites FIRST** — owned by
   slice 0, no longer unassigned. They assert web-next's isolation and
   non-deployment; dissolving web-next into `packages/` removes their premise,
   and with it the only thing keeping Phase 2–6 dark. Rewritten to fence the
   new layout (the four dark domains stay unmounted), and **tamper-checked** —
   each shown to fail when the property it guards is deliberately broken, or it
   has passed vacuously.
2. Then the monorepo move, `packages/core` extraction, React 19, island host,
   tokens, and the remaining four text fences repaired and tamper-checked.
3. Vercel Root Directory repointed — **BLOCKED on P10** (§(c)). The CLAUDE.md
   directive names `spotme-messenger`, but that directive settles *currency*,
   not *audience*; repointing before P10 risks wiring the build away from where
   testers actually are. When it runs it is last in the PR, and afterwards the
   promotion must be verified git-triggered (`githubCommitRef: master`,
   `githubDeployment: 1`, no `actor`) rather than a manual `--prod` run.

   **Steps 1 and 2 are not blocked by P10** — the fence rewrites and the
   package restructure are host-agnostic. Only the repoint waits.

Nothing else ships in that PR. Tailwind is **not** in slice 0 (P4 deferred).

*Deviation considered and rejected: a smaller pathfinder slice first.*
`views/notifications.js` (175 lines) or `views/stories.js` (107) would be
gentler. Rejected because every candidate small enough to be a pathfinder is
also small enough to prove nothing: none exercises ports, realtime, or a
privacy fence, so slice 1's real risks would simply be deferred to slice 2 with
an extra release of overhead. Discovery is the right first slice; the pinned
scope, not a different screen, is what makes it safe.

### (e2) Chat — a deliberate exception to the packages/ui pattern (recorded 2026-08-08)

Chat landed via the four-session s-chain (#154/#156/#157/#158, merged as one
lineage), which builds the surface as **app-side islands** —
`views/chat-island.js` plus crypto/lang/media/port islands — rather than a
`packages/ui` shell with ports and a controller like Discovery, Exchange,
Events, Assistant and every other slice. A competing single-commit
`packages/ui/chat` implementation (#150) existed and was closed unmerged.

**This is an owner decision, not an accident.** The reasons, in the owner's
weighing: the s-chain was four sessions of work against one commit; it began
with a 37-assertion characterization suite pinning the 4,732-line legacy view's
engine contract *before* any React was written; it covers media, sheets,
reactions, translation, transliteration, verify and safety numbers where #150
covered thread and composer; #150's base lineage was orphaned by the slice-0
rebases; and the s-chain's `chat-island-port.js` is a variant of the ports
pattern, not the absence of one.

**The cost, stated so nobody reads this as drift:** chat components living in
`apps/web` will NOT carry to a React Native target the way `packages/ui`
components will. If/when an RN client becomes real, chat pays a second
migration that the other slices do not. The two-device acceptance checklist
from #150 is harvested as the s-chain's acceptance bar.

### (f) Per-slice definition of done

A slice is done when **all nine** hold. Any one missing means not done.

1. **Dark flag.** `spotme.ui.<slice>` — default **off**, read at exactly one
   place, mirroring the existing `spotme.transport` / `momentsHome` pattern
   already in the codebase (ADR-015 compile-time default false, ADR-016 dark
   shipping).
2. **Both stacks live.** The legacy view stays in `ROUTES`, **unmodified and
   reachable**, for the whole slice lifetime and one full release after
   cutover. This is what makes §(g) tier 1 possible; it is not negotiable.
3. **Legacy suite unchanged and green.** 1,085 assertions is the regression
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

**Positive.** One React major across web and native (a). ~5,572 lines of
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

## Owner decisions — ANSWERED 2026-08-07

| # | Item | Decision |
|---|---|---|
| P1 | Adopt this migration plan | **YES** — adopted; this ADR is ACCEPTED |
| P2 | React 19 upgrade for web-next | **YES** — 18.3 would fork the major against `spotme/app`'s 19.2.3 |
| P3 | Monorepo move + Vercel Root Directory change | **YES in principle.** Move and restructure unblocked; the **Root Directory repoint waits on P10** (§(c)) |
| P4 | Tailwind v4 adoption | **DEFERRED** — slices 0–1 ship on plain CSS + tokens; revisit at slice 2 against the countable drift test (§(d)) |
| P5 | Retire `spotme/app` | **PENDING EXPLICIT OWNER CONFIRMATION** — a deletion, relayed as a recommendation and over-recorded as a decision. Do not execute. Also subject to the STOP in §(b): never touch `spotme/core`, `spotme/package.json`, or `web/vendor/spotme-core/` |
| P6 | Commit or remove `spotme/mobile` | **PENDING EXPLICIT OWNER CONFIRMATION** — a deletion with **no git safety net** (0 tracked files, so `rm` is unrecoverable). Do not execute |
| P7 | Phase 2 Discovery activation (Typesense) | **NO, not now** — spend + activation. Discovery is now slice 5 (§(e)) and stays pinned to live endpoints |
| P8 | Flag flips to real users | **NOT YET** — nothing flips until a slice passes all nine DoD items |

### Still open after P1–P8

| # | Item | Why still open |
|---|---|---|
| P5b | Prune `spotme/core` to `translit.js`; drop the vendored P2P copy | Touches the live build and the `prebuild` vendoring step — needs its own evidence and PR (§(b)) |
| P9 | Retire or demote the duplicate `spotme-web-v2` Vercel project | Ends double builds and allows the `--include=dev` workaround out of the shared `vercel.json`; deleting a project is owner-retained (§(c)) |
| P10 | **OPEN — blocks slice 0's Root Directory repoint.** Which project do real testers open? | Currency is settled (`spotme-messenger`); **audience is not**. CLAUDE.md restates the pipeline read, so it cannot corroborate it. Web Analytics is disabled on both projects and neither has a custom domain — no repository or platform fact can close this. Owner-only. |
| P11 | Characterization tests before each rewrite — appetite? | §A.1: no view-level coverage exists; the DoD assumes tests-first, which costs time |

---

## Evidence

All verified against `master` `acf48bc`, 2026-08-07:

- `npm test --prefix spotme/web` → **1,085 assertions, exit 0**, 57 suites.
- Surface inventory: `spotme/web/src`, 80 non-empty files; per-file line counts
  and `el()` counts in §A.
- Framework-free classification: DOM-reference grep (`document.`, `window.`,
  `localStorage`, `navigator.`, `addEventListener`, `HTMLElement`) plus an
  import-graph trace showing `lib/crypto`, `lib/transport`, `lib/calls`,
  `lib/ai` reach only `../api.js`, `../auth-headers.js`,
  `../socket-transport.js` and siblings.
- View DOM coupling: all 14 views import `el()` from `lib/ui.js`; 963 call sites.
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
fast-forwarded to `acf48bc` before any inventory was taken. The ADR index
`docs/adr/README.md` is **stale** — it ends at 028 and does not list ADR-029,
033, or 034. Numbers 030–032 were never used; this ADR takes **035**.
