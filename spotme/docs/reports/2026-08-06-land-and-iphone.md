# Land, activate, iPhone media, deploy — 2026-08-06

Filed at `spotme/docs/reports/` rather than a top-level `docs/reports/`, which
does not exist in this repository — every prior report lives here.

**Headline.** Item 1 was already done before this session started, and its
premise in the brief is wrong in a way worth knowing. Items 3 and 4 are built,
proven, and pushed. Item 2 is built and proven against a real local stack but
**was not run against production** — no credentials, and the @username line in
the brief is still blank. The deploys in items 1 and 5 are blocked on the same
missing credentials. Along the way: **master's HEAD was CI-red** and is now
fixed, and I found a **GPS leak on a format that was already accepted**.

---

## Corrections to the brief's premises

**1. The chain is already merged. Master is not at `88518f9`.**

The brief says "everything from yesterday evening is UNMERGED on
`feat/wave-1c-discovery` (through `461ade2`)". It is merged:

```
origin/master                      = 6c675e9
461ade2 is an ancestor of master   = YES
88518f9 is an ancestor of master   = YES   (it is feat/wave-1b-age-gate's tip)
```

The landing was done by a prior session in three `--no-ff` merges — no squash,
no rebase, history preserved:

| Merge SHA | Content |
|---|---|
| `d1115f9` | Wave 1C Discovery Stage-A, through `63f0066` |
| `2be65ed` | foundation fix + Moments activation, through `78846bc` |
| **`aa3f00f`** | **Wave 1D repair chain, through `461ade2`** ← the SHA you asked for |

Master then took three more commits (`38125ab`, `f39cb95`, `6c675e9`).

I did not re-merge anything. There was nothing to merge.

**2. Master's HEAD was CI-red, and had been since last night.**

This matters because the brief asks for "CI green before and after".

```
aa3f00f  CI success     ← the merge
6c675e9  CI failure     ← master's HEAD
```

The break is `npm run lint` on the web job — a CI gate. `f39cb95` landed the
phone harness carrying two bindings it never used (a `writeFile` import and a
`handleB` for the second account whose chat leg was never driven). The prior
report's claim of "eslint clean" was true at `aa3f00f` and stopped being true
two commits later.

Fixed in `3259f59` on my branch. Both bindings were genuinely dead, so they are
removed rather than underscore-prefixed.

**3. The `moments` RuntimeFlag row must NOT be inserted.**

Item 2 says "insert the `moments` RuntimeFlag row if the gate needs it". It
does not need it, and inserting it would have done the opposite of what you
asked. From `DomainGate`:

> EXISTENCE is granted by EITHER the domain-wide RuntimeFlag OR a per-user
> Stage-A allowlist entry — the two are independent.

A `moments` RuntimeFlag row switches Moments on for **every account**. The
allowlist row alone is what gates the surface to one person. The activation
script therefore never touches RuntimeFlag, asserts the row is still absent
afterwards, and refuses to run at all if an enabled flag row already exists.

---

## 1. Land the chain — **ALREADY DONE; deploy BLOCKED**

Merge SHA: **`aa3f00f8f6f0064cb222fac9b25de4bdea7526e7`**.

**Deploy to the api service: not done.** No `RAILWAY_TOKEN`, no `railway` CLI,
no production `DATABASE_URL`. I also did not announce a deploy, because there
is nothing I can deploy.

I verified the route classes against a **local** build of master + my changes
(Postgres 16 + PostGIS 3.4, 23/23 migrations applied):

| Check | Result |
|---|---|
| `/health` | `200 {"status":"ok"}` |
| `/ready` | `200 {"status":"ready","checks":{"db":"up","redis":"disabled"}}` |
| `/api/v2/exchange/offers` (dark) | `404` |
| `/api/v2/assistant/compose` (dark) | `404` |
| `/api/v1/moments/feed` unauthenticated | `401` |
| `/api/v1/moments/feed` authed, not allowlisted | `404` |
| `/api/v1/moments/feed` authed, allowlisted | `200` |

Note the paths: `/health` and `/ready` are **not** under `/api` — `/api/health`
is a 404.

**Still outstanding from last night:** production is running `682627b50c4d6fdf`,
which predates `38125ab`. Until the api service is redeployed, every boot still
replays the M2 proof block that purges a user and writes/deletes allowlist rows
against the live database. That is the most urgent item in this report and I
cannot action it.

---

## 2. Moments for your account only — **BUILT AND PROVEN LOCALLY; NOT RUN IN PRODUCTION**

**Row counts, as asked.** From the **local** proof database, clearly not
production: `domainAllowlist_rows_total: 0`, `runtimeFlag_rows_total: 0`.
**Production counts are unknown to me** — no `DATABASE_URL`. No unexpected rows
existed locally, so nothing stopped the run.

**Why it did not run against production — two independent blockers:**

1. **The @username is still blank.** The brief again reads
   `MY @USERNAME: __________`. You selected "I'll type it now" when I asked,
   but the handle did not arrive with the answer. Guessing it would grant a
   gated production surface to an account that may not be yours — the
   "genuinely irreversible or unsafe" case, so I stopped rather than picked.
2. **No production credentials**, which you confirmed and asked me to work
   around.

**What is ready.** `spotme/backend/src/scripts/wave1d/owner-grant-moments.ts`.
One command once you supply the handle:

```bash
MOMENTS_OWNER_USERNAME=<handle> node dist/scripts/wave1d/owner-grant-moments.js
```

It locates you server-side by @username, never prints the userId (selectors are
masked — output shows `ow***`), writes exactly one row noted `owner`, and is
idempotent. Revocation is deleting that one row; dark again within one 5s cache
window.

**Proven, not asserted** — against a real API + PostGIS stack:

| Guard | Evidence |
|---|---|
| pre-op counts reported before any write | `pre_domainAllowlist_rows_total: 0` |
| unexpected rows STOP the run | drill: injected a foreign row → `STOP_UNEXPECTED_ALLOWLIST_ROWS`, note listed, exit 1, **zero writes** |
| idempotent | re-run → `post_domainAllowlist_rows_moments: 1` (not 2) |
| your account reaches the feed | `owner_feed_status: 200` |
| a second, non-allowlisted adult does not | `non_allowlisted_feed_status: 404` |
| RuntimeFlag untouched | `post_runtimeFlag_moments_present: false` |

**Nobody was let in. Production gating is unchanged.**

---

## 3. iPhone media — **BUILT AND PROVEN, against a local store, not R2**

`ALLOWED_MIME` now accepts `image/heic`, `image/heif`, `video/quicktime` — but
only because each is **converted into a format the strip boundary already
cleans, before anything is persisted**:

```
HEIC/HEIF → JPEG (libheif) → stripImageMetadata()   ← the existing boundary
.mov      → mp4, -map_metadata -1
```

### Three findings that changed the implementation

**(a) `heif-convert` copies the source EXIF into its output.** A naive
HEIC→JPEG ships the GPS IFD intact. Measured on Ubuntu 24.04 *and* on the
production `node:22-slim` bookworm image:

```
converted JPEG contains Exif marker : true
converted JPEG contains GPS IFD tag : true
```

So the re-strip is load-bearing, not defensive. A test asserts the intermediate
JPEG **still leaks**, and would fail if that ever stopped being true — which is
what stops someone deleting the strip as redundant.

**(b) Video originals were already leaking, on a format that was already
accepted.** `ingest()` stored video **exactly as uploaded** (`clean = bytes`),
on the reasoning that container metadata was the transcode worker's job. But
the worker only cleans the **derived variants** — the stored original kept its
GPS tags and stayed reachable by presigned GET. Last night's video proof
asserted on the *720p variant*, so it could not have caught this. All video now
goes through the same normalise, so `mp4` and `webm` are fixed alongside `.mov`.

**(c) Byte-scanning for coordinates is not a sound test for mp4.** QuickTime
keeps the location in an ASCII `©xyz` atom, but mp4 writes a `loci` atom holding
**16.16 fixed-point binary**. ffprobe reports `location=+37.7749-122.4194/` for
a file in which that text appears nowhere:

```
mp4 with GPS:  ffprobe says location=+37.7749…   contains b'+37.7749' = False
```

A string scan would have passed vacuously. The video assertions go through
ffprobe's parser instead.

### The proof

8 tests in `spotme/backend/test/moment-normalize.spec.ts`, all passing. The
fixtures are **real files** — a genuine libheif-encoded HEIC (`heic` brand)
carrying a structurally valid EXIF GPS IFD, and a genuine QuickTime file with a
container location tag — and every leg asserts the source is still tagged
before claiming the pipeline removed it.

```
✓ the fixtures really do carry location metadata (guards against a vacuous pass)
✓ the ffmpeg normalise args always drop container metadata
✓ the newly accepted MIME types get an upload slot; unsupported ones still do not
✓ HEIC→JPEG conversion ALONE still leaks GPS — the re-strip is not decorative
✓ a HEIC upload is STORED as a JPEG with no EXIF and no GPS
✓ a .mov upload is STORED as an mp4 with the location tag gone
✓ an mp4 upload is normalised too — the stored original is not the uploaded bytes
✓ a mislabelled upload is refused and nothing is persisted
```

**The qualifier, stated plainly.** "STORED" here means the bytes handed to
`putObject` — captured through a storage adapter that records exactly what
would go to the bucket. **This is not an R2 proof.** This container has no R2
credentials (`AWS_ACCESS_KEY_ID` is the agent proxy's placeholder, prefix
`proxy-`). It is a real proof of the mechanism at the only boundary where bytes
become an object, and it is not the same as fetching from the production bucket.

### What the runtime image needs

**`ffmpeg` — already installed.** The Dockerfile has had it since M3.

**`libheif-examples` — added.** This provides `heif-convert`. ffmpeg **cannot**
stand in: this build has no HEIF demuxer at all (`ffmpeg -demuxers` lists
none, and `-decoders` has `hevc` but nothing that opens a HEIC container).

**Deliberately NOT added: `libheif-plugin-libde265`.** Debian bookworm ships
libheif **1.15**, which predates the 1.17 plugin split, so that package does not
exist in the suite and naming it fails the build. 1.15's `libheif1` links
libde265 directly. Verified by running both legs inside the real base image:

```
$ docker run --rm node:22-slim …
HEIC decode on the PRODUCTION base image (bookworm/libheif 1.15)
Written to /tmp/out.jpg          DECODE: OK
.mov remux on the same image     REMUX: OK  → no location tag
```

CI installs the same package, so the HEIC legs **run** there instead of
skipping. Without the tool the tests skip rather than fail — which would have
quietly stopped proving anything, hence the CI step.

If HEIC is ever refused in production, the service still refuses **safely**: a
missing converter is a typed refusal, never a pass-through of unstripped bytes.

---

## 4. Share deeplink — **FIXED**

`#/posts?m=<id>` did not open "the generic feed" — it opened the **chat inbox**.
The router looked the whole hash up in its route table, `#/posts?m=abc` matched
nothing, and it fell through to the `|| inbox` default. The Posts tab did not
even light up.

Now the router splits the hash, routes on the path, and hands the parameters to
the view. The Moments view locates the post by a `data-moment-id` on its card,
scrolls to it, and highlights it briefly. If it is not on the first page the
view pages forward a bounded number of times; if it still cannot be found it
says so, because the post may be private, deleted, or from someone this account
cannot see — and silently showing an ordinary feed is what made the link look
broken. The focus is consumed once, so paging afterwards does not re-yank the
view.

Driven in a real browser: a shared link lands on the Posts surface with
`lit tab = #/posts`.

18 tests in `spotme/web/test/share-deeplink.test.js`. The parser lives in
`src/lib/hash-route.js` rather than `main.js` so the test runs the **real
function** — `main.js` reaches the DOM at import time, which is why the existing
nav fence can only assert on its source as text.

**Deliberately not built: a fetch-by-id endpoint.** That is what would make a
shared link work for a recipient who cannot already see the post in their feed.
The feed's visibility rules — blocks, moderation state, private/friends scoping
— live in repository SQL, and re-deriving that predicate for a single-row read
is how a private post leaks. That is a security-sensitive surface deserving its
own change and review, not a side effect of a routing fix. **Flagging it as a
real gap:** until it exists, a shared link only works for someone whose feed
already contains the post.

---

## 5. Deploy and drive — **DRIVEN LOCALLY; DEPLOY BLOCKED**

**Deploy to `spotme-web-v2`: not done.** No `VERCEL_TOKEN`, no `vercel` CLI.
**There is no preview URL.** I am not going to hand you one that does not exist.

**Driven** in real Chromium, 390×844, `isMobile`, touch, iPhone UA, against a
real API + PostGIS + an allowlisted account — **8 of 9 passed**:

| Journey step | Result | Evidence |
|---|---|---|
| signup with the 18+ gate | **PASS** | under-18 month refused (stays on onboarding); adult month completes as `@ownmu3hgo` |
| identity survives a full close and reopen | **PASS** | browser genuinely closed and relaunched; reopens straight into the app |
| Posts tab ABSENT before the grant | **PASS** | bar shows `["#/discovery","#/chat","#/notifications"]` |
| the grant allowlists exactly that account | **PASS** | `moments_rows=1 owner_feed=200 stranger_feed=404 runtimeFlag_present=false` |
| **Posts tab PRESENT after the grant** | **PASS** | first time this half has ever been evidenced |
| the Posts feed loads | **PASS** | surface renders, state `"Nothing here yet"` (empty, not refused) |
| share deeplink opens the Posts surface | **PASS** | `lit tab = #/posts` |
| no uncaught page errors | **PASS\*** | see below |
| username search | **PASS** | (carried from the prior harness run; unchanged) |

\* Scored FAIL by my harness, and the harness was wrong. The 6 console entries
are the browser logging **404 fetches from `momentsAvailable()`** while the
account was not yet allowlisted — the gate's designed answer, not an app fault.
My filter was too narrow. Calling this out rather than quietly widening the
filter and reporting 9/9.

### NOT DRIVEN, and why

- **post a JPEG / HEIC / .mov through the UI, story, reels swipe, comment,
  react, report, block, delete own post.** The upload path needs a storage
  adapter; this container has no R2 or MinIO credentials, so `putObject` has
  nowhere to go. The **API-level** behaviour for HEIC and `.mov` is separately
  proven in item 3 — what is missing is the **UI** drive, not the capability.
- **chat A↔B readable both ways.** Needs two live peers over the realtime seam
  the other session owns. I stayed off it as instructed.
- **nearby map.** Carried from the prior run; I did not re-drive it.

### Emulation numbers — labelled

**Chromium CPU-throttling emulation on a cloud container. These are not device
numbers and must not be quoted as such.** Third-party requests blocked, because
the render-blocking font CDN is reset by this sandbox's proxy and would swamp
the app's own number.

```
cpu=1x   FCP=428ms  nav=549ms  frames=59  over50ms=0  worst=17ms
cpu=4x   FCP=628ms  nav=589ms  frames=60  over50ms=0  worst=21ms
```

FCP scales with the throttle (428→628ms), which is the sanity check that it is
genuinely CPU-bound this time — unlike last night's 12.9s reading that was
identical at 1× and 4× and turned out to be a network artifact.

**The Google Fonts render-block is still unfixed and still real.** `index.html`
pulls `fonts.googleapis.com` as a render-blocking stylesheet with no fallback or
timeout. Any user whose network blocks or throttles it gets a blank screen until
it resolves. It is a product decision about asset hosting (self-host,
`font-display`, or async-load), so I have not picked one.

**The phone harness** is `spotme/web/test/phone-harness.mjs`:

```bash
cd spotme/web
npm i -D playwright     # then, in THIS container, launch with
                        # executablePath: '/opt/pw-browsers/chromium'
WEB=http://127.0.0.1:5199 API=http://127.0.0.1:4599 node test/phone-harness.mjs
```

The preinstalled Chromium is build 1194 and current playwright expects 1234, so
`npx playwright install` is not the fix here — point `executablePath` at
`/opt/pw-browsers/chromium`.

---

## Commits pushed

Branch `claude/wave-1c-land-iphone-homzb6`. Tree clean.

| SHA | What |
|---|---|
| `c6f703d` | feat: accept iPhone media by converting it at the strip boundary |
| `294af46` | fix: a shared post link opens that post, not the generic feed |
| `3259f59` | fix(ci): drop the unused bindings that left master's lint red |
| `d5745d7` | feat: owner-only activation script, gated by allowlist not RuntimeFlag |
| `9874a5a` | refactor: keep the activation script clear of the dark-reach fence |

Gates at the final state: backend `tsc` clean, build clean, **637 passed /
0 failed** (22 skipped, 5 suites skipped — they need MinIO/R2). Web lint clean,
tests pass, `vite build` clean.

### Hygiene notes

- **Nothing was staged with `git add -A`.** Every commit staged named paths and
  `git diff --cached` was read before committing.
- **`spotme/web/package-lock.json` was reverted twice, not committed.** `npm
  install` rewrote all 3,784 lines by changing the indentation from two spaces
  to one. Verified semantically identical (parsed JSON compares equal) and
  discarded as noise.
- **`playwright` was reverted out of `package.json`.** `npm i -D` added it; the
  harness is documented as installing it at run time and CI's `npm ci` should
  not carry it. It stays in local `node_modules` and works.
- **One change on this branch was not mine:** the two unused bindings in
  `phone-harness.mjs` came from `f39cb95`, which is already in master. I fixed
  them rather than reporting and leaving CI red, since they are a committed CI
  gate failure rather than another session's work in progress. Flagging it here
  as required.
- I did not touch the calls/realtime port or `rooms.js`.

---

## What I need from you

1. **The @username.** Item 2 is one command away. Everything else about it is
   built and proven.
2. **Credentials**, if any of the blocked work is to be finished from a session
   like this: production `DATABASE_URL` (or an in-network runner), a Vercel
   token for the web deploy, Railway access for the api deploy, R2 keys for a
   real-bucket EXIF proof. Add them to the environment settings rather than
   pasting them into chat.
3. **Redeploy the api service** — urgently, and independently of everything
   above. Production still runs the pre-`38125ab` image whose boot path replays
   a destructive proof script against the live database on every restart.
4. **A decision on the fetch-by-id endpoint** (item 4's remaining gap) and on
   **the Google Fonts render-block**.
