# Mission 3 — Posts (Moments) is the home page — session report

**Date:** 2026-08-06
**Master built from:** `4bc8682` (docs(reports): both hosts deployed, app driven on mobile)
**Branch:** `feature/moments-home` → PR #126
**Merge commit:** `9155522` (GitHub merge commit, no squash — master had moved to
`8dc0c3d` under this session via the parallel calls/ADR-033 landing; verified
zero-conflict and zero web-tree overlap before merging)
**Deploy:** https://spotme-web-v2.vercel.app — prebuilt from the merged web tree,
`.vercel/output/static` existence checked before deploy, content-verified live
(bundle `index-CtJDYHV7.js`, `momentsHome` + API base present, `/` → 200)

---

## What changed (one PR, two commits)

1. `4ddfb30` — **feat(spotme): Posts is Home for served accounts.** All in
   `spotme/web/src/main.js` + a fence test:
   - The server probe's last definitive answer is cached in device settings
     (`momentsHome`) and read synchronously at cold open. It is a cache of the
     server's statement, never a switch: a device never told "served" cannot
     acquire it, the bar is still built only from the live probe, and every
     Moments request stays gated server-side.
   - Cold open, no deeplink, served → lands `#/posts`, overriding a remembered
     bare bar-tab hash. The four bar-tab paths are the only "remembered tab"
     the cold open may override; `#/posts?m=<id>`, `#/thread/…`, `#r=…` links
     and every unlisted screen miss the set and always win.
   - The probe reconciles both directions: a served account still sitting on
     the landing tab moves to Posts (first grant / cold cache); a hint-led
     Posts landing the server now denies falls back to Chats. Any navigation
     by the person cancels reconciliation for the session.
   - Review fixes (from a specialist review pass before the drive): finishing
     onboarding lands on `homeTab()` rather than a literal `#/chat`, so a
     served account interrupted by the age re-declaration returns to Posts;
     adopting a different account via recovery calls
     `resetMomentsAvailability()` and clears the hint before `boot()`.
   - Fence: `test/moments-home.test.js` (10 checks), wired at the end of the
     `npm test` chain.
2. `ecdccb5` — **chore(web): the suite runs on Windows.** Four fence tests
   derived paths via `URL.pathname` (`/C:/…` → `C:\C:\…` ENOENT) and compared
   paths assuming forward slashes; the chain died at its fourth test on
   Windows and everything after never ran. Also the two unused bindings in
   `phone-harness.mjs` that had eslint — and with it the CI web job — red on
   master. CI runs Linux and behavior there is byte-identical.

## Behavior contract → what was driven

Real Chromium (Playwright), 390×844, against a **full local stack**: Docker
Postgres 16 + PostGIS (host :15432) and Valkey (:16379), the backend API on
:4000 (23/23 migrations, `/health` and `/ready` green), vite dev on :5183
proxying `/api`. The served test account was allowlisted by one row in the
**local** database only — production data was never touched.

| # | Case | Result |
|---|------|--------|
| 1 | Non-served: cold open → chat-list home, Posts absent from the bar (3 buttons) | **PASS** |
| 2 | Non-served: remembered tab (`#/notifications`) survives reload unchanged | **PASS** |
| 3 | Served, first grant: cold open lands Chats, probe reconciles → bar gains Posts tab AND view moves to `#/posts` | **PASS** |
| 4 | Served, steady state: cold open lands directly on `#/posts`, Posts tab selected | **PASS** |
| 5 | Served: remembered `#/chat` overridden → lands `#/posts` | **PASS** |
| 6 | Served: tapping Chats mid-session sticks — no yank after user navigation (probe long resolved) | **PASS** |
| 7 | Empty feed looks alive: "Nothing here yet / No posts nearby. Be the first." + Create-a-post + own story bubble in the ring; no spinner, no error | **PASS** |
| 8 | Composer opens; photo post created; appears in Nearby feed with coarse cell `g12.972:77.595` | **PASS** |
| 9 | Reactions: 🤍 → ❤️ via the sheet, persisted into the single-post view | **PASS** |
| 10 | Comments: posted and rendered | **PASS** |
| 11 | Two video posts (local ffmpeg transcode); reels viewer: `scroll-snap-type: y mandatory`, exactly one pane playing, neighbour preloads `metadata`; snapping flips playback | **PASS** |
| 12 | Deeplink `#/posts?m=<id>` cold → the RIGHT single post ("Post" heading + back arrow), not the feed | **PASS** |
| 13 | Deeplink `#/thread/<roomId>` cold, served account → opens the chat, not Posts | **PASS** |
| 14 | Landed on Posts, unread from the other account → Chats tab pip shows **1** | **PASS** |
| 15 | Production, non-served account against spotme-web-v2 (new bundle): chat-list home, Posts absent (3-tab bar), `GET /api/v1/moments/feed` → **404** from the production Railway API, remembered `#/notifications` survives reload unchanged | **PASS** |
| 16 | Production, served (owner) account | **SKIP — blocked on the owner's @username / allowlist row (see prior report §4); never guessed** |

Notes on the drive:
- Case 14 doubles as the answer to mission item 6: the product **does** have an
  unread indicator on the Chats tab (`updateNav`'s pip), and it renders while
  landed on Posts. No new indicator was built.
- The A↔B chat rode the local server (search `@m7drvb` → Start chat → replay
  on B's next boot), so the unread pip was fed by a real cross-account message.
- The moments availability probe 404s twice per cold boot (known pre-existing
  duplicate probe — `boot()` + first render; confirmed idempotent, only extra
  network).

## Fences and suites at the final state

- `npm test` (spotme/web): full chain **exit 0** on Windows — first time it
  can complete on this host (see commit 2).
- `test/moments-home.test.js` 10/10 · `test/moments-nav-fence.test.js` 13/13.
- `eslint .` clean (master had it red via `phone-harness.mjs`).
- `vite build` clean.
- PR CI (run 31098214076): **web ✓** (red on master before this PR), **e2e ✓**,
  **compose ✓**, backend ✗ on exactly the pre-existing
  `moment-media-iphone.spec.ts` pair (same 2-failed/653-passed counts as
  master) — no new failures introduced.

## Drift and findings (recorded, not fixed here)

1. **Master CI has been red for its last three runs.** Two causes: the web
   lint errors fixed in this PR, and `spotme/backend/test/moment-media-iphone.spec.ts`
   (2 tests) failing in the backend job — pre-existing from the iPhone-media
   chain (`d578fda`), untouched by this PR per "no backend changes".
2. **`spotme/backend/scripts/build-id.mjs` cannot run on Windows** (same
   `URL.pathname` bug class). A 2-line `fileURLToPath` fix was applied
   **locally only, deliberately not committed** — the mission forbids backend
   changes. Suggested follow-up.
3. Committed debris exists on master (e.g. a top-level `spotme/'` file and
   odd-named files under `spotme/web/src/` such as `0)`, `Clear`,
   `a.name.localeCompare(b.name))`) — noticed while listing the tree; not
   touched.
4. `momentsAvailable()` fires twice per cold boot (pre-existing; idempotent).

## Hard-rule compliance

- No backend changes committed; no flag changes; the only allowlist row was
  written to the **local Docker Postgres** (`spotme-dev-postgres-1`).
- No secrets in chat, logs, or commits — env NAMES only throughout; the local
  backend `.env` was confirmed gitignored before creation.
- The main working tree (mid-merge on `calls-livekit-catchup`) was never
  touched: all work happened in a dedicated worktree at `C:\Users\yuv\fable-m3`.
- Dark domains stay dark: production gating is unchanged; the client cannot
  enable anything the server refuses.

## What the owner still needs to supply (unchanged from the previous report)

An SSH key on the Railway account (preferred) or a TCP proxy on `postgis`,
plus — only if the production owner account came from the guest flow — the
@username. That unblocks the production allowlist row, and with it case 16
and the whole production Moments journey.
