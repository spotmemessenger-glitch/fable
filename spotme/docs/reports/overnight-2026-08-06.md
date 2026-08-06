# Overnight session — 2026-08-06

Owner asleep, no questions asked. Reversible judgment calls were made and are
recorded below. What follows separates what was **driven and proven** from what
was **blocked**, and the blocked items say why rather than being dressed up.

**Headline:** item 1 is done and CI-green on master. Item 2's root cause was
already fixed and is already live in production — and the mission's stated
hypothesis for it is wrong, which matters. Item 3's photo *and* video EXIF
claims are proven end to end, but against a **local object store, not R2**.
Items 4 and 6 are blocked on credentials this container does not hold, and
item 4 is additionally blocked on the owner's @username, which was left blank
in the mission text.

---

## Corrections to the mission's premises

Three things in the brief did not match the repository. Recording them first,
because two of them would have sent the work in the wrong direction.

1. **The branches are one linear chain, not two.** `feat/wave-1c-discovery`
   contains *both* the discovery commits *and* the moments chain, 178 commits
   ahead of `origin/master`, fast-forwardable with zero conflicts. There was
   nothing to resolve.

2. **The branch head is 8 commits past `78846bc`**, the commit the mission
   named as the end of the chain. Those 8 include `78a819d`, which is the fix
   for the two production 500s that item 2 asks for. Landing only what was
   named would have merged the known-broken state and stranded the fix.
   **Judgment call: I landed the full branch head (`461ade2`).**

3. **The postgis / migration-drift hypothesis for the 500s is disproven.**
   Item 2 asks me to diff `_prisma_migrations` and fix schema drift. That is
   not what was wrong. `78a819d` diagnosed it by reproducing over real HTTP:
   - **Principal shape.** Every moments route read `u.sub`; the JWT strategy
     returns `{ id, role, kind }` — no `sub`. So `authorId`/`reporterId`
     reached Prisma as `undefined` → `PrismaClientValidationError`. The
     lifecycle e2e could never catch it because it drives `MomentsService`
     directly with `authorId` strings; only a request through the real
     strategy fails. That is exactly why it was 10/10 locally and 500 in prod.
   - **Unresolvable optional DI tokens.** `@Optional() x: ModerationSink | null`
     — a union type emits `Object` as `design:type`, so the token resolved to
     nothing and `@Optional` silently injected `null`.

   I independently confirmed migrations are *not* drifted: all 23 repo
   migrations apply cleanly to a fresh PostGIS database, and the proof run
   reports `migrations_missing_in_db: []`, `migrations_extra_in_db: []`,
   `migrations_unfinished: []` (23 repo / 23 db).

---

## 1. Land the chain into master — **DONE, CI green**

Merged in the mission's order, `--no-ff` (no squash, no rebase), suites run at
each step before the next merge.

| Step | Merge SHA | Content | Backend suite at that point |
|---|---|---|---|
| a | `d1115f9` | Wave 1C Discovery Stage-A, through `63f0066` | 598 passed, 0 failed |
| b | `2be65ed` | foundation fix + Moments, through `78846bc` | 625 passed, 0 failed |
| c | `aa3f00f` | Wave 1D repair chain, through `461ade2` | 629 passed, 0 failed |

`master` is now **`aa3f00f`** (was `88518f9`). GitHub CI on `aa3f00f`:
**success** (run 310435073). Web suite green, `eslint` clean, `vite build`
clean at the final state.

Merge c is the judgment call from correction 2 above; its commit message
records why.

> Note: local `master` in the fresh clone was stale at `67bc221`. The first
> merge was built on it, caught, and redone from `origin/master`. The SHAs
> above are all from the correct base.

---

## 2. The two production 500s — **root cause fixed and ALREADY LIVE; endpoints proven 2xx locally, not in production**

**Production is already running the fixed code.** `/api/version` returns a hash
of the backend source, so this is checkable rather than assumed:

```
production GET /api/version  -> {"buildId":"682627b50c4d6fdf"}
local build at master aa3f00f -> 682627b50c4d6fdf      # identical
```

Both endpoints were then driven over real HTTP against a full local stack
(Postgres 16 + PostGIS, Redis, the built image):

- `POST /v1/moments` → **201**, moment id returned
- `POST /v1/moments/reports` → **201**, row written, `queuedAt` set (the D7
  delivery marker — so the moderation sink genuinely ran, which was the second
  half of the bug)

**What I could not do:** re-drive those two endpoints *against production*.
That needs an allowlisted principal, which needs a write to the production
`DomainAllowlist`, and this container has no production `DATABASE_URL`. So:
the fix is correct, it is deployed, and it is proven on the same source
locally — but I have not personally watched production return 201, and I am
not going to claim I have.

No redeploy was needed or performed. No Railway credentials are present in
this environment.

### A live production defect found and fixed on the way

`main.ts` carried a block labelled `// ---- TEMPORARY: Wave 1D M2 re-run
(reverted after capture). ----`. **It was never reverted.** It ran
`runM2Proof()` on **every boot of the deployed image**, and that script is not
read-only — it purges the user `md50872`, creates two guest accounts, writes
and deletes `DomainAllowlist` rows, and deletes users. Every restart and every
redeploy replayed those writes against the live database.

Removed in `38125ab`. This is the single most important thing in this report
that nobody asked for.

---

## 3. The EXIF proof — **PASSES for photo AND video, against a LOCAL store, not R2**

Read the qualifier before the result. **The stored objects I fetched and
asserted on came from the `LocalStorageAdapter` on disk, not from R2.** This
container has no R2 credentials (`AWS_ACCESS_KEY_ID` here is the agent proxy's
placeholder, prefix `proxy-`). The mission asked for the bytes in the bucket;
what I have is the bytes the same code path wrote to the store it was pointed
at. That is a real proof of the mechanism and it is *not* the production-R2
proof the mission asked for.

With that said, both legs pass, and both are **non-vacuous** — the run asserts
the source carries the metadata before claiming it was stripped.

**Photo**
```
photo_source_contains_gps   : true      <- the source really has GPS
photo_upload_status         : 201
photo_post_status           : 201
photo_asseturl_status       : 200
photo_stored_bytes          : 119
photo_STORED_CONTAINS_GPS   : false     <- gone from the stored bytes
photo_stored_has_exif_app1  : false     <- no EXIF APP1 segment at all
```

**Video** (`-map_metadata -1`)
```
video_source_container_gps  : true      <- ffprobe confirms the source has it
video_upload_status         : 201
video_variants              : 720p (136011 B), 480p (115613 B)
video_asserted_variant      : 720p
video_stored_read           : ok        <- read back by recorded storageKey
video_STORED_CONTAINS_GPS   : false
video_stored_format_tags    : major_brand=isom minor_version=512
                              compatible_brands=isomiso2avc1mp41
                              encoder=Lavf60.16.100      <- no location tag
```

**Second account sees the post:** `second_account_feed_status: 200`,
`second_account_sees_post: true`. Delete works too — `photo_delete_status: 200`,
`photo_gone_after_delete: true`.

### Two things the proof runner was hiding

The video leg **proved nothing before tonight**. It uploaded a video generated
with no metadata, so "no GPS in the output" would have held even with
`-map_metadata -1` deleted from the ladder. The source now carries a real
container location tag and the run asserts its presence first.

And the video leg could never have run at all on a local store: the transcode
worker fetched the original through the adapter's presigned GET, under a
comment claiming the path "works identically against R2, MinIO and the local
disk". It did not — the local adapter signs a **path-relative** URL and
`fetch()` rejects a relative input, so every job died with `Failed to parse URL
from /api/v2/media/local?…` and no variant was ever produced. Fixed in
`38125ab`; R2 is unaffected because it signs absolute URLs and takes the same
branch it always did.

---

## 4. Deploy the preview and switch Moments on for the owner — **BLOCKED, and one blocker is not technical**

**This item was not attempted, for two independent reasons.**

1. **The @username is blank.** The mission line reads
   `MY @USERNAME: __________  (owner: type it here)` and was never filled in.
   The task is to insert a `DomainAllowlist` row for that handle in
   **production**. Guessing it would mean granting a gated production surface
   to an account that is not the owner's — letting a stranger in. That is the
   "genuinely irreversible or unsafe" case the mission carved out, so I
   stopped rather than picked a plausible handle.

2. **No credentials.** No Vercel token or `vercel` CLI (the "connector
   re-authorized" note did not reach this container's environment), and no
   production `DATABASE_URL` for the RuntimeFlag / DomainAllowlist writes.

**Row counts, as asked — from the local proof database, clearly not production:**
`runtimeFlag_rows_total: 0`, `runtimeFlag_rows_moments: 0`,
`domainAllowlist_rows_total: 0`. Production counts are unknown to me.

**What I did verify about the gate,** in a real browser: an account with **no**
allowlist row gets **no Posts tab**. The gate holds from the client side. The
"second, non-allowlisted account still gets 404" half of the acceptance
criterion is therefore evidenced; the "my account gets the Posts tab" half is
not, because there is no allowlisted account to test with.

**Nobody was let in. Production gating is unchanged.**

---

## 5. Drive the whole app in a real browser — **PARTIAL, honestly scored**

Harness committed at `spotme/web/test/phone-harness.mjs` (`f39cb95`), 390×844,
`isMobile`, touch. Run it with:

```bash
cd spotme/web
npm i -D playwright && npx playwright install chromium
WEB=http://127.0.0.1:5199 API=http://127.0.0.1:4599 node test/phone-harness.mjs
```

**8 passed, 0 failed, 3 not driven.**

| Journey step | Result | Evidence |
|---|---|---|
| signup with the 18+ gate | **PASS** | under-18 birth month refused (stays on onboarding); adult month completes signup |
| identity survives full close and reopen | **PASS** | persistent profile, browser genuinely closed and relaunched, reopens straight into the app |
| username search | **PASS** | `HTTP 200 {"results":[{"username":"phxc4b2s",…}]}` |
| nearby map | **PASS** | surface renders |
| Posts tab absent without allowlist | **PASS** | gate holds |
| chat A↔B both directions | **NOT DRIVEN** | needs two live peers over the realtime seam the other session owns — I stayed off it as instructed |
| post a photo / post a video | **NOT DRIVEN** | behind the Moments domain gate; no allowlisted account (see item 4) |
| story, reels swipe, comment, react, report, block, delete own post | **NOT DRIVEN** | same gate |

The Moments API paths *are* separately proven 2xx over real HTTP in item 3 —
create, feed-visible-to-second-account, report, delete. What is missing is the
**UI** drive of them, not the capability.

### Emulation numbers — labelled, and they found something real

**These are Chromium CPU-throttling emulation on a cloud container. They are
not device numbers and must not be quoted as such.**

```
time-to-first-frame : FCP 156ms, nav wall 178ms @ 4x CPU (third-party blocked)
scroll stall rate   : 0/122 frames >50ms (0.0%), worst frame 17ms @ 4x CPU
```

The first number took three attempts to get honestly, and the detour is the
finding. The initial measurement said **FCP ~12.9s**, identically at 1× and 4×
CPU throttle — identical across throttle rates means it was never CPU-bound.
It was `fonts.googleapis.com`, pulled by `index.html` as a **render-blocking
stylesheet**, being reset by this sandbox's proxy. With third-party requests
blocked the same page paints in **156ms**.

So the 12.9s is a sandbox artifact and I am not reporting it as an app number.
**But the underlying exposure is real:** first paint is render-blocked on an
external font CDN with no fallback or timeout. Any user whose network blocks,
throttles, or cannot reach `fonts.googleapis.com` — a privacy blocker, a
corporate network, a censored region — gets a **blank screen** until it
resolves or resets. Worth fixing (self-host, `font-display`, or async-load the
stylesheet); not fixed tonight because it is a product decision about asset
hosting, not a bug with an obvious single answer.

One intermediate diagnostic of mine was also wrong and is worth flagging so it
is not trusted later: a probe that polled `page.evaluate` *without* awaiting
`goto` raced the navigation and swallowed the errors, and briefly looked like
proof that the app painted nothing at all. It was measurement error. The
numbers above come from the corrected, awaited measurement.

---

## 6. Exchange — **NOT STARTED**

Correctly gated behind "if context remains". Context did not remain after
items 1–5 and the two unplanned defects. Nothing half-built was left behind,
per the mission's own instruction to stop cleanly at a boundary.

---

## Commits pushed

Branch `claude/wave-1c-merge-production-0fwxik` and `master` both at `f39cb95`.

| SHA | What |
|---|---|
| `d1115f9` | merge: Wave 1C Discovery Stage-A |
| `2be65ed` | merge: foundation fix + Moments activation |
| `aa3f00f` | merge: Wave 1D Moments repair chain (incl. the 500 fix) |
| `38125ab` | fix: stop running the M2 proof on every boot; repair local-store transcode; make the video EXIF assertion non-vacuous |
| `f39cb95` | test: phone harness |

Tree clean. Backend 629 passed / 0 failed; web suite green; lint and build
clean.

---

## What the owner needs to decide or supply

1. **The @username.** Item 4 cannot start without it. Everything else for that
   item is understood and ready.
2. **Credentials, if items 2–4 are to be finished from a session like this
   one:** production `DATABASE_URL` (or an in-network runner), R2 keys for the
   real-bucket EXIF proof, a Vercel token for the preview deploy. Without
   these, "prove it in production" is not reachable from this container by any
   route.
3. **The Google Fonts render-block** — self-host or async-load. Small change,
   real blast radius on poor networks.
4. **Redeploy the api service** at the owner's convenience to pick up `38125ab`
   and stop the M2 proof block from executing on every boot. Production is
   otherwise already on the fixed source. *(Not deployed by me: no credentials,
   and the mission asks for an announcement before touching the api service
   while the other session is wiring LiveKit.)*
