# Land, fix iPhone, deploy — session report

**Date:** 2026-08-06
**Branch:** `claude/wave-1c-land-iphone-ecc8ff`
**Commits added:** `5319d9b` (iPhone media), `48b6aeb` (share deeplink)

---

## Summary, in the order it matters

| # | Mission item | Outcome |
|---|---|---|
| 1 | Land the chain into master | **Already landed before this session.** Verified, not re-done. |
| 1b | Deploy master to the api service + re-verify | **BLOCKED — no deploy credentials in this session.** Not done. |
| 2 | iPhone media (HEIC + `.mov`) | **Done, with proof on the stored bytes.** |
| 3 | Share deeplink `#/posts?m=<id>` | **Done, driven in a real mobile browser.** |
| 4a | Deploy the web surface to `spotme-web-v2` | **BLOCKED — same reason.** No preview URL exists. |
| 4b | Drive the full journey | **Done — 15/15 PASS, but against a LOCAL stack, not a deployed preview.** |
| 4c | Throttled emulation numbers | **Partially — transfer/bundle figures are trustworthy, paint timings are NOT.** See §5. |

Two things you asked for do not exist at the end of this session: a deployed
preview URL, and a production re-verification. Both are blocked on the same
missing thing, and I could not work around it. Everything else is done and
pushed.

---

## 1. Landing the chain — the briefing was one session out of date

The mission said master was at `88518f9` with everything unmerged on
`feat/wave-1c-discovery`. **That was no longer true when this session started.**

```
origin/master = aa3f00f   Merge Wave 1D Moments repair chain into master
                2be65ed   Merge Wave 1C foundation fix + Moments activation
                d1115f9   Merge Wave 1C Discovery Stage-A into master
```

Verified rather than assumed:

- `git merge-base --is-ancestor 461ade2 origin/master` → **yes**. The full
  chain through `461ade2` (the coarse-location fix) is in.
- `88518f9` is also an ancestor — it is the commit master sat on before the
  three merges.
- All three are **real merge commits with two parents each**. No squash, no
  rebase; `461ade2` and every commit under it retain their identity and
  authorship. The history preservation you asked for is intact.
- A prior session did this at 20:11–20:15 on 2026-08-05, from branch
  `claude/wave-1c-merge-production-0fwxik`, which still points at `aa3f00f`.

**Merge SHA you asked for: `aa3f00f8f6f0064cb222fac9b25de4bdea7526e7`.**

I did not re-merge anything. Re-landing an already-landed chain would have
created empty merges and rewritten nothing useful.

### What landing left behind (and I removed)

`main.ts` still ran this on **every production boot**, despite the merge
commit message saying the temporary probe logging had been removed:

```js
// ---- TEMPORARY: Wave 1D M2 re-run (reverted after capture). ----
const { runM2Proof } = await import('./scripts/wave1d/m2-media-proof');
console.log('M2_PROOF_RESULT ' + JSON.stringify(await runM2Proof(port)));
```

Removed in `5319d9b`. Worth knowing that a "reverted after capture" claim
survived into master unreverted.

---

## 2. iPhone media — HEIC and `.mov`

### The design decision, and why it deviates from the brief

You asked for the transcode "on the `{moment-media}` worker". **I put it at the
ingest boundary instead**, and I want to be explicit about that because it is a
deliberate departure.

The worker cannot keep the promise. It is a BullMQ consumer drained *after*
`ingest()` has already written the object, and it writes *derived* renditions
alongside the original. The original is what `GET :mediaId/url` serves. So a
worker-side transcode would leave a GPS-bearing file in the bucket, being
served, until and unless something else deleted it — and "prove GPS is gone
from the STORED bytes", which is the actual requirement, would have been
unprovable.

The transcode therefore runs synchronously in `normalize.ts`, before hashing,
dedup or any write. The worker keeps its real job: the H.264 playback ladder
and poster frame. This is reversible — if you want it moved, the seam is one
function — but I do not think it can be moved and still be correct.

### The finding that shaped the implementation

**`heif-convert` copies EXIF into its JPEG output.** Converting HEIC→JPEG
removes *nothing*; the GPS IFD is carried straight across. Measured with
exiftool on a real GPS-tagged HEIC, not assumed.

So the pipeline is two steps, and both are load-bearing:

```
HEIC  →  heif-convert  →  JPEG (still has GPS)  →  stripImageMetadata  →  stored
.mov  →  ffmpeg -map_metadata -1 (+ per-stream) -c copy +faststart      →  stored
```

A test asserts the intermediate is still dirty, so the ordering cannot be
quietly reversed by someone who assumes the conversion cleans it.

### Proof, on the bytes handed to `storage.putObject`

Not on a tool's stdout — on the exact buffer the storage adapter is asked to
write, captured by a fake adapter.

Independent confirmation with exiftool:

```
ORIGINAL HEIC                          STORED JPEG
[IFD0] Make            : Apple         >>> NO GPS / MAKE / MODEL TAGS AT ALL <<<
[IFD0] Model           : iPhone 15 Pro
[GPS]  GPS Latitude    : 12°58'17.76"
[GPS]  GPS Longitude   : 77°35'40.56"

ORIGINAL .MOV                          STORED MP4
[UserData] GPS Coordinates :           >>> NO GPS / LOCATION TAGS AT ALL <<<
           12°58'17.76" N, 77°35'40.56" E
```

Both stored files still decode cleanly (JPEG 640×480; MP4 h264 640×480 + aac),
and the MP4 comes out **faststart** — `moov` at offset 36 ahead of `mdat` at
4684, where the source `.mov` had `moov` trailing at 48588.

### A trap worth recording

**`strings file | grep 12.9716` is not a valid check here.** The two formats
hide coordinates differently, and one of them defeats grep entirely:

- HEIC/EXIF stores them as **binary rationals** — grep finds *nothing* on a
  fully GPS-tagged file. A grep-based test would have passed on unstripped bytes.
- QuickTime stores ISO-6709 as **ASCII** in the `©xyz` atom — grep does find it.

The tests assert on structure (`containsMetadataMarkers`,
`containsContainerLocationTags`) and prove the fixtures dirty first, so a
broken assertion cannot pass vacuously. I got this wrong on the first pass —
I asserted both formats hide it — and the test caught me.

### A live privacy hole I found on the way

`ingest()` did `clean = bytes` for anything non-image, on the comment that
video container metadata was the worker's duty. It was not. **Every
`video/mp4` and `video/webm` upload was stored verbatim with its GPS, and
served.** This was in an already-accepted format — nothing to do with iPhone
support. Those paths now go through the same remux. There is a regression test
named for it.

### Runtime dependencies (what you asked me to report)

Verified by running both conversions **inside `node:22-slim`**, the actual
runtime base image — not inferred from this dev container:

| Package | Version in image | Why |
|---|---|---|
| `ffmpeg` | 5.1.9-0+deb12u1 | `.mov` → faststart MP4, `-map_metadata -1`. Already present for the worker; now also a hard dependency of the **upload** path. |
| `libheif-examples` | 1.15.1-1+deb12u1 | provides `heif-convert` (HEIC → JPEG) |
| `libheif1` | 1.15.1-1+deb12u1 | pulled automatically |
| `libde265-0` | 1.0.11-1+deb12u2 | the HEVC **decoder**, pulled automatically |

**No x265 encoder is needed** — the server only ever reads HEIC and writes
JPEG. (This dev container needed `libheif-plugin-x265` only to *create* the
test fixture.)

Added to `spotme/backend/Dockerfile` and to `.github/workflows/ci.yml`.

If a binary is missing the upload is **refused** with `transcode-unavailable`
→ **HTTP 503**, not 400: the format is fine, the runtime is not, and telling a
user to pick a different photo would be a lie. A broken image degrades to
"iPhone uploads rejected", never to "iPhone uploads stored with GPS".

### Also closed

- Magic-byte validation: a JPEG claiming `image/heic` is refused **before** any
  subprocess is spawned. The `content-type` header picks the branch; the bytes
  have to agree.
- `.gitignore`'s blanket `*.mov` silently swallowed the video fixture. The test
  would have been committed without the file it reads and failed **only in CI**.
  Narrow negation added.

---

## 3. Share deeplink

`#/posts?m=<id>` did not open "the generic feed" — it opened the **chat inbox**.
The router looked the whole hash up in `ROUTES`, `#/posts?m=abc` matched no key,
and it fell through the `|| inbox` default.

I verified the before-state empirically rather than asserting it: checking
`main.js` out at its pre-fix commit and re-running the same drive gives
`title="(none)" cards=0 litTab="Chats"` on the chat list. After the fix, the
same URL gives `title="Post" cards=1 litTab="Posts"`.

Server side this needed `GET v1/moments/:id`, deliberately **not** a
client-side feed filter — the entire reason to send a link is that the post is
*not* in the recipient's feed, so filtering a feed page works only when the
link was unnecessary. It reuses the existing `findViewable` SQL gate that the
comment and reaction paths already trust, so a link grants no access the feed
would not have: private stays author-only, friends stays follower-only, blocks
hold both directions, and absent vs forbidden are the **same 404** so a link
cannot probe for id existence.

Two traps avoided, both of which would have been worse than the original bug:

- The route is declared **last**. Nest matches in declaration order; a `:id`
  registered earlier would have swallowed `feed`, `stories/rail` and `reports`.
  Confirmed in the boot log — `/api/v1/moments/:id GET` maps after them.
- The back button is `.mo-backbtn`, **not** `.mo-back` — that class is already
  the bottom-sheet backdrop (`position: fixed; inset: 0`) and would have
  covered the screen in a dark overlay.

Client side, `momentById` re-labels the ambiguous 404: the domain gate and a
missing post both answer 404, and the shared `call()` maps every 404 to
`MomentsDisabledError` — which would have told a perfectly enabled user that
Posts was switched off for their account.

---

## 4. The journey drive — 15/15 PASS, but read the caveat

**Caveat first: this was driven against a LOCAL stack, not a deployed preview**,
because no preview could be deployed (§6). Backend on `localhost:4000` against
PostGIS 16-3.4 (the same image CI uses), web on Vite, real Chromium at a
390×844 mobile viewport with an iPhone user-agent, touch enabled, geolocation
granted.

| Step | Result | Evidence |
|---|---|---|
| signup with the 18+ gate | **PASS** | a 15-year-old declaration is held on onboarding; adult proceeds |
| identity survives full close + reopen | **PASS** | new browser context from saved state, no re-signup, storage keys identical |
| chat A↔B readable both directions | **PASS** | A→B `hello-A-v46g` visible on B; B's reply visible on A after reload |
| post a JPEG | **PASS** | stored `image/jpeg` 16859 B |
| post a HEIC | **PASS** | stored `image/jpeg` **20224 B** — normalised |
| post an iPhone `.mov` | **PASS** | stored `video/mp4` **53236 B** — normalised |
| story | **PASS** | "New story" composer; rail goes to 2 rings |
| reels swipe | **PASS** | opens on tapping media, accepts a vertical swipe, 2 videos in DOM |
| comment | **PASS** | "driven comment" visible in thread |
| react | **PASS** | 6-reaction sheet; reacted cards 0 → 1 |
| report | **PASS** | `MomentReport` row `moment\|child-safety`; moment `visible` → `reported` |
| block | **PASS** | `MomentBlock` row written; author disappears from feed |
| delete own post | **PASS** | cards 3 → 2 |
| username search | **PASS** | `@driver_b` returned from the registry |
| nearby map | **PASS** | real map, 12 map nodes, real street names rendered |

Two notes on honesty:

- **Report and Block first came back FAIL.** They were absent because it was my
  *own* post — `openMore(m, mine)` only offers Delete for your own, and
  Follow/Report/Block for others'. Not a bug. Re-driven against a second user's
  post: all three appear and both actions persist server-side.
- The share deeplink drive additionally confirms a dead link says
  *"This post isn't available"* rather than *"Posts aren't switched on"*.

35 screenshots in `/tmp/shots/` — **session-local and not committed**; they die
with this container.

Test suites, run in full:

- **Backend: 642 passed, 0 failed, 22 skipped, 64 suites.** Typecheck clean,
  `nest build` clean, all migrations apply to a fresh PostGIS database.
  (13 of those 642 are the new iPhone media proofs.)
- **Web: 13/13 passed**, `eslint` clean, `vite build` clean.

---

## 5. Throttled emulation numbers — partial, and I am not publishing the headline figure

**Emulation, not a real phone and not a real network.** Chromium DevTools
throttling: 1.6 Mbps down / 750 Kbps up / 150 ms RTT, CPU 4× slowdown, HTTP
cache disabled, production build served from localhost.

What I trust:

| Metric | Value |
|---|---|
| Transferred on cold load | **163 KB over 5 requests** |
| `dist/` total | 776 KB |
| Largest chunk | `index-*.js` 438 KB raw / **145 KB gzip** |
| TTFB | 3–8 ms (localhost — meaningless as a field number) |

**What I am not reporting as a product metric: first contentful paint.** My
harness produced ~13 s consistently, but it is not trustworthy and I would
rather say so than hand you a number I cannot stand behind:

- It stayed ~13 s **unthrottled**, with the CPU throttle off, with the network
  emulation off, and with `/api` stubbed to instant 200s. A figure that ignores
  every variable is measuring the harness, not the app.
- No request took over 800 ms.
- Under `waitUntil: 'commit'` the paint-entry array comes back **empty** on both
  the dev server and the preview build, which means the timing API is not
  giving me what I think it is here — most likely because the app performs a
  reset-epoch self-reload on first visit and the entries belong to a discarded
  document.
- Against observed behaviour it is simply wrong: the app was interactive within
  ~2.5 s in every one of the fifteen functional drives above.

Get this from the real deployment with Lighthouse or field RUM. A localhost
Playwright harness is the wrong instrument.

---

## 6. What is blocked, and why I could not work around it

**No deploy credentials exist in this session.** Checked, not assumed:

- `vercel`, `railway`, `flyctl` CLIs: none installed
- `VERCEL_TOKEN` / `RAILWAY_TOKEN` / any deploy token in env: none
- `~/.vercel`, `~/.railway`, `~/.config/vercel`, `~/.config/railway`, `~/.netrc`: none exist

Per `spotme/web/DEPLOY.md`, the web surface needs `npx vercel deploy --prebuilt
--prod` and the API needs `railway up`. Both require authentication this
session does not have and cannot mint.

Consequently **not done**:

1. Deploying master to the api service, and the post-deploy re-verification of
   `/health`, `/ready`, dark routes 404, live routes in their expected class,
   and RuntimeFlag row counts.
2. Deploying the web surface to `spotme-web-v2`. **There is no preview URL.**
3. Driving the journey against production. Everything in §4 is local.

I also did not need to announce an api deploy, since none happened — the
LiveKit session's ports and `rooms.js` were untouched throughout.

What I *can* tell you, from the local boot of the merged code:

```
/health  → {"status":"ok"}
/ready   → {"status":"ready","checks":{"db":"up","redis":"disabled"}}
RuntimeFlag rows: 0   (unchanged — access is per-user DomainAllowlist)
```

This is the same code that would deploy, but it is **not** a production
verification and should not be recorded as one.

### To finish this yourself

```bash
# API
cd spotme/backend && railway up          # image now installs libheif-examples

# Web
cd spotme/web
VITE_SPOTME_SERVER="https://api-production-0a4ca.up.railway.app" npx vercel build --prod
npx vercel deploy --prebuilt --prod
```

Then re-verify: `/health`, `/ready`, a dark route 404s, `RuntimeFlag` still 0
rows, and one HEIC + one `.mov` upload round-trip.

---

## 7. The phone harness you asked to run yourself

Once a preview URL exists, on the actual iPhone, signed in as your account:

1. **HEIC photo** — Camera → shoot → post it. Expect: accepted, renders. Then
   pull the object and check `exiftool` shows no GPS/Make/Model, and that the
   stored asset row says `image/jpeg`, not `image/heic`.
2. **`.mov` video** — record ~5 s → post. Expect: accepted, plays inline.
   Check `mimeType` is `video/mp4` and `moov` precedes `mdat`.
3. **Settings → Formats → High Efficiency vs Most Compatible.** On "Most
   Compatible" the phone hands over JPEG/H.264 and the new path never runs —
   make sure you are actually testing HEIC.
4. **Share a post to yourself** (Share → copy link), open the link from
   Messages. Expect: that post, with a back arrow — not the chat list, not the
   feed.
5. **Share a post you cannot see** (ask someone to share a friends-only post
   from an account you do not follow). Expect: "This post isn't available",
   never "Posts aren't switched on".
6. **Kill the app fully** (swipe up from the app switcher), reopen. Expect: no
   re-signup.
7. **In-app browser check** — open the link inside WhatsApp or Instagram, which
   often use throwaway webview storage. This is the known-fragile identity case
   from the F1 foundation work and is worth a look on a real device.
8. **Large video** — a clip over 50 MB should be refused cleanly with a stated
   reason, not truncated or hung.

If any upload comes back **503 `transcode-unavailable`**, the deployed image is
missing ffmpeg or libheif — that is the failure mode designed in, and it means
the Dockerfile change did not reach the running container.

---

## 8. Honest list of what I did not do

- **Did not deploy anything.** No credentials. §6.
- **Did not verify production.** All verification is local.
- **Did not produce trustworthy paint timings.** §5.
- **Did not re-merge the chain** — it was already merged; I verified instead.
- **Did not verify the HEIC decode on a genuine iPhone-camera HEIC.** My fixture
  is synthetic (ffmpeg testsrc → `heif-enc`, GPS injected with exiftool). It is
  a real HEIC with real EXIF GPS, but a camera original may carry extras a
  synthetic file does not — auxiliary depth images, Live Photo pairing, HDR gain
  maps. Step 1 of §7 is the real test.
- **Did not touch** the calls/realtime port or `rooms.js`, as instructed.
- **Noticed but did not fix:** `spotme/web/` has **355 tracked junk files** with
  names like `!(m.viewOnce`, `({words`, `a[1]` — debris from a bad shell glob,
  committed at some point. Out of scope here, but it is real and someone should
  clean it up.

---

## Files changed

```
.github/workflows/ci.yml                              ffmpeg + libheif in CI
.gitignore                                            un-ignore media test fixtures
spotme/backend/Dockerfile                             libheif-examples + rationale
spotme/backend/src/main.ts                            remove temporary M2 boot probe
spotme/backend/src/moment-media/normalize.ts          NEW — the normalisation boundary
spotme/backend/src/moment-media/media.service.ts      normalise → strip → store
spotme/backend/src/moment-media/media.ports.ts        transcode-unavailable refusal
spotme/backend/src/moments/moment-media.controller.ts 503 for operator faults
spotme/backend/src/moments/moments.controller.ts      GET :id, declared last
spotme/backend/src/moments/moments.service.ts         getViewable via findViewable
spotme/backend/test/moment-media-iphone.spec.ts       NEW — 13 proofs
spotme/backend/test/fixtures/media/gps-iphone.heic    NEW — GPS-tagged fixture
spotme/backend/test/fixtures/media/gps-iphone.mov     NEW — GPS-tagged fixture
spotme/web/src/main.js                                route on path, pass params
spotme/web/src/lib/moments-api.js                     momentById + MomentNotFoundError
spotme/web/src/views/moments.js                       single-post view
spotme/web/src/views/moments.css                      .mo-backbtn
```

---
---

# Appendix — continuation session (`claude/wave-1c-land-iphone-homzb6`)

Everything above this line is the `…-ecc8ff` session's report. This appendix is
a **different session**, run against the same mission. I have appended rather
than overwritten: two sessions were told to file at this path, and their record
should not be destroyed to make room for mine.

**Headline.** Three sessions worked this mission in parallel today. The other
two landed items 3 and 4 and deployed both hosts. **My versions of items 3 and
4 are dropped — theirs are better.** What this branch is actually for is three
things master does not have, one of which is the fix for master being CI-red
right now. Item 2 is **STOPPED at your own instruction**: the @username is
still blank.

---

## 1. The handle is still blank — item 2 stops here, per your rule

Your ordering rule was:

> if my account does not exist in that database yet, STOP and tell me — I'll
> sign up on the preview first rather than have you guess a handle.

The line in this brief reads, again:

```
Q1 — MY HANDLE: @__________   (owner: type it here)
```

I cannot check whether the account exists, because there is no handle to look
up. So this stops one step earlier than your rule anticipated, for the same
reason it exists: **guessing would grant a gated production surface to whoever
owns the handle I picked.** This is the third brief in which the field was left
blank, so I want to be direct — the field appears to be getting lost between
your editor and the message. Pasting the handle on its own line in your next
message is enough.

Everything else for item 2 is built, proven, and waits on that one string.

---

## 2. Master moved under me, and two sessions solved the same items

At the start of my previous turn, `origin/master` was `6c675e9`. It is now
`4bc8682`, and none of my commits are in it. What landed instead:

| SHA | What | Whose |
|---|---|---|
| `5319d9b` | iPhone media — HEIC + `.mov` | `…-ecc8ff` |
| `48b6aeb` | share deeplink | `…-ecc8ff` |
| `d578fda` | merge of the above into master | `…-ecc8ff` |
| `ff05145` | their session report | `…-ecc8ff` |
| `4bc8682` | deploy report — both hosts deployed | a third session |

Two sessions built items 3 and 4 independently and **converged on the same
architecture**: normalise at the *ingest* boundary, not in the `{moment-media}`
worker, because the worker only writes derived renditions and the stored
original would keep its coordinates. That agreement is worth more than either
implementation.

**Where they differ, theirs is better, so theirs is what survived my merge:**

- their `normalize.ts` validates **magic bytes against the declared MIME** and
  raises typed `TranscodeUnavailable` / `NormalizeFailed` errors;
- their deeplink adds a real `GET /moments/:id` + `momentById` and a proper
  **single-post view** with a back affordance and a `notfound` state. I had
  deliberately *not* built the by-id read, and flagged in my previous report
  that this left shared links working only for a recipient whose feed already
  contained the post. **They closed the gap I left open.**

So I dropped my `normalize.ts`, `media.service.ts` changes,
`moment-normalize.spec.ts`, my HEIC/`.mov` fixtures, `hash-route.js`,
`share-deeplink.test.js`, my `.mo-focus` CSS, my `.gitignore` exception and my
duplicate CI libheif step. Nothing of mine that duplicated theirs is kept.

### What this branch adds over master — exactly three files

```
spotme/web/test/phone-harness.mjs                    ← MASTER IS RED WITHOUT THIS
spotme/backend/src/scripts/wave1d/owner-grant-moments.ts
spotme/web/test/moments-journey-harness.mjs
```

---

## 3. Master is CI-red right now, and this is the fix

This is the most actionable thing in this appendix.

```
aa3f00f  success   ← the last green commit on master
6c675e9  failure
d578fda  failure   ← the iPhone-media + deeplink merge
4bc8682  failure   ← "both hosts deployed"
```

`npm run lint` is a CI gate on the web job. `f39cb95` landed the phone harness
carrying two bindings it never uses — a `writeFile` import and a `handleB` for
a second account whose chat leg was never driven. Reproduced against a clean
checkout of `origin/master`:

```
/spotme/web/test/phone-harness.mjs
   69:24  error  'writeFile' is assigned a value but never used
  100:9   error  'handleB' is assigned a value but never used
✖ 2 problems (2 errors, 0 warnings)
```

Master has been red for four commits, across two sessions, including the one
that deployed to production. The fix is a two-line deletion and it is on this
branch. **Merging this branch turns master green.**

---

## 4. The metadata claim, asserted — not assumed

You asked for the assertion, not the intention. These are assertions on the
bytes the server **wrote to the object store**, read back off disk after a real
upload through the composer UI in a real browser — and run against **master's**
implementation, so this is an independent verification of the other session's
work rather than of my own.

```
JPEG   source had Exif+GPS   → stored 16188B, no Exif marker,
                               metadata segments [], kept ["0xe0","0xdb","0xc4","0xc0","SOS"]
HEIC   source had Exif+GPS   → stored is JPEG 20224B, no Exif marker,
                               metadata segments [], no HEIC ftyp
.mov   source had a location → stored original 53236B, ffprobe reports only
       tag                     major_brand / minor_version / compatible_brands / encoder
```

Every leg asserts the **source is still tagged** before claiming the pipeline
removed it, so a fixture that quietly stopped being tagged fails instead of
passing vacuously.

### A correction to my own previous report

My earlier harness reported the stored JPEG as leaking GPS. **It was not.** The
check scanned raw bytes for `0x8825`, the GPS IFD tag — two bytes, which turn up
by chance inside entropy-coded pixel data. Measured: a *correctly stripped*
16 KB JPEG contained `0x8825` once, at offset **15175**, well past SOS at 329.

This is the same class of error as the mp4 `loci` finding, in the opposite
direction: there a byte scan gave a false **pass**, here a false **fail**. Both
are now structural — JPEG asserts that no APP1..APP15 or COM segment survives
(what `stripJpeg` actually guarantees), and video asserts through ffprobe's
parser rather than over bytes.

---

## 5. The full journey, driven — 18 passed, 0 failed, 2 not driven

Real Chromium, 390×844, `isMobile`, touch, iPhone UA, against master's code, a
real API + PostGIS, and a real on-disk object store.

| Journey step | Result | Evidence |
|---|---|---|
| signup with the 18+ gate (under-18 refused) | **PASS** | stays on onboarding after an under-18 month |
| signup with the 18+ gate (adult completes) | **PASS** | signed up as a fresh handle |
| identity survives a full close and reopen | **PASS** | browser genuinely closed and relaunched |
| chat A↔B readable both ways | **NOT DRIVEN** | needs two live peers over the realtime seam the calls session owns |
| Posts tab ABSENT before the grant | **PASS** | bar shows `["#/discovery","#/chat","#/notifications"]` |
| the grant allowlists exactly this account | **PASS** | `moments_rows=1 owner_feed=200 stranger_feed=404 runtimeFlag_present=false` |
| Posts tab PRESENT after the grant | **PASS** | tab appears and opens |
| post a JPEG | **PASS** | stored bytes: no Exif marker, no metadata segments |
| post a HEIC | **PASS** | stored as JPEG, no metadata segments, no HEIC `ftyp` |
| post an iPhone `.mov` | **PASS** | stored as mp4, ffprobe reports no location tag |
| the feed shows the new posts | **PASS** | 3 cards |
| share deeplink opens THAT post | **PASS** | Share button → `/#/posts?m=<id>` → title "Post", exactly 1 card, back present, tab `#/posts` |
| a share link to a missing post says so | **PASS** | no card rendered, "unavailable" message |
| react | **PASS** | react button `mo-act` → `mo-act on` |
| comment | **PASS** | comment visible in the thread |
| delete own post | **PASS** | cards 3 → 2 |
| username search | **PASS** | `HTTP 200 {"results":[{"username":"…"}]}` |
| nearby map | **PASS** | discovery surface renders |
| story / reels swipe / report / block | **NOT DRIVEN** | story+reels need a surviving video card (the delete leg removes one); report/block need a SECOND authored account. Reachable, not exercised — so not claimed. |

The deeplink leg uses the **actual Share button** and reads the link off the
clipboard, rather than synthesising a URL — so it tests the flow a person would
use, not a URL shape I assumed.

### A real trap found by driving it

**A post made with no location permission is invisible to everyone, forever.**
The composer defaults to `nearby` visibility, and the nearby feed filters on
`geog IS NOT NULL` + `ST_DWithin`. Deny location, and the post returns 201, the
media is stored, the row exists — and it appears in no feed at all. The friends
feed does not rescue it either: that requires an explicit follow, and nobody
follows themselves. Not fixed here; it needs a product decision (refuse the
post, fall back to `public`, or warn).

### Emulation numbers — labelled

**Chromium CPU-throttling emulation on a cloud container. Not device numbers.**
Third-party requests blocked, because the render-blocking font CDN is reset by
this sandbox's proxy and would swamp the app's own figure.

```
cpu=1x   FCP=448ms  nav=434ms  frames=59  over50ms=0  worst=17ms
cpu=4x   FCP=648ms  nav=581ms  frames=61  over50ms=0  worst=21ms
```

FCP scales with the throttle, which is the sanity check that it is genuinely
CPU-bound — unlike the 12.9s reading two sessions ago that was identical at 1×
and 4× and turned out to be a network artifact.

---

## 6. Production, checked from here

I could not deploy (see §7), but the deployed hosts are reachable and I checked
them rather than trusting the deploy report:

| Check | Result |
|---|---|
| `spotme-web-v2.vercel.app` | **200** |
| api `/health` | **200** `{"status":"ok"}` |
| api `/ready` | **200** `{"status":"ready","checks":{"db":"up","redis":"up"}}` |
| api `/api/v2/exchange/offers` (dark) | **404** |
| api `/api/v2/assistant/compose` (dark) | **404** |
| api `/api/v1/moments/feed` unauthenticated | **401** |
| api `buildId` | `84dfbddbab23bd0b` |

**One caveat worth recording:** the *first* `/ready` probe returned **503**;
three retries immediately after all returned 200 with `db: up, redis: up`. It
reads as a cold-start artifact rather than a standing fault, but a load
balancer using `/ready` as its gate will see that 503. Worth knowing before it
is wired to anything that reacts to it.

---

## 7. Why I could not deploy, and the durable fix

You said you were adding `RAILWAY_TOKEN` and `VERCEL_TOKEN` to the environment
settings. **They are not visible to this process**, and neither CLI is
installed here:

```
RAILWAY_TOKEN = (unset)      railway  (not installed)
VERCEL_TOKEN  = (unset)      vercel   (not installed)
DATABASE_URL  = (unset)
```

This is expected and is not a problem with what you did: **environment settings
are read when a session's container starts.** This process started before you
added them, so it cannot see them. A restarted session will.

Note also how the third session actually deployed: **not** through env tokens,
but through `railway`/`vercel` CLIs that were already logged in, holding their
own credentials on disk. So a fresh session may find itself able to deploy even
with both env vars empty — check `railway whoami` / `vercel whoami` before
concluding you are blocked.

Your instruction about never printing the credential is right and is what the
runbooks below do: `railway run` injects `DATABASE_URL` into the child process's
environment, so it is never echoed, logged, or committed.

### The handoff line for a restarted session

Paste this as the opening prompt of a fresh session:

> Continue the Wave-1C mission on branch `claude/wave-1c-land-iphone-homzb6`
> (it is merged up to master and adds three files: the phone-harness lint fix
> that turns master green, `owner-grant-moments.ts`, and
> `moments-journey-harness.mjs`). My handle is **@\<PASTE IT HERE\>**.
> Check `railway whoami` and `vercel whoami` first — the CLIs may already hold
> credentials even when `RAILWAY_TOKEN`/`VERCEL_TOKEN` are unset. Then, in
> order: (1) merge this branch into master and confirm CI goes green — master
> has been red since `6c675e9` on a web lint gate; (2) run the allowlist
> runbook in `spotme/docs/reports/2026-08-06-land-and-iphone.md` §8 to switch
> Moments on for my account only, reporting row counts and never printing my
> userId; (3) redeploy the api service and re-verify `/health`, `/ready`, dark
> routes 404 and moments 401; (4) re-run the journey harness against the
> deployed hosts. Read that report's appendix before starting.

---

## 8. Runbooks for the three blocked steps

### 8a. Switch Moments on for the owner's account only

**Needs:** the owner's @username; `DATABASE_URL` resolved via the Railway CLI;
the api reachable on `PORT` for the verification leg.

```bash
cd spotme/backend
npm ci && npx prisma generate && npm run build

# DATABASE_URL is injected into the child process — never printed.
railway link          # project spotme-backend, environment production, service api
railway run --service api -- \
  env MOMENTS_OWNER_USERNAME='<handle>' PORT=4000 \
  node dist/scripts/wave1d/owner-grant-moments.js
```

Expected output, and what each field means:

```json
{
  "pre_domainAllowlist_rows_total": 0,      // report this BEFORE anything else
  "pre_domainAllowlist_rows_moments": 0,
  "pre_runtimeFlag_moments_present": false,
  "selector": "ab***",                       // masked; the userId is never printed
  "owner_found": true,
  "granted": true,
  "owner_feed_status": 200,                  // the owner reaches the feed
  "non_allowlisted_feed_status": 404,        // a second adult still does not
  "post_domainAllowlist_rows_moments": 1,    // exactly one row
  "post_runtimeFlag_moments_present": false, // the flag is NOT created
  "status": "OK"
}
```

**It stops rather than guessing, in four cases** — no selector; a `moments`
RuntimeFlag row already enabled (which would mean the domain is on for
everyone, and an allowlist row would not narrow it); a `moments` allowlist row
this script did not write (notes listed, nothing added or deleted); the account
not found. It is idempotent — re-running leaves exactly one row.

**Do NOT create the `moments` RuntimeFlag row.** `DomainGate` grants existence
on *either* the flag *or* an allowlist row, so that row switches Moments on for
**every** account. The allowlist row alone is what gates it to one person.

**Revocation** is one row:
`DELETE FROM "DomainAllowlist" WHERE domain='moments' AND "userId"=…` — dark
again within one 5s cache window.

### 8b. Redeploy the api service

**Needs:** Railway access (env token *or* a logged-in CLI). **Announce before
running** — the calls session owns the realtime seam on this service.

```bash
cd spotme/backend
npm run deploy          # stages deploy-api/ — a bare `railway up` SKIPS this
                        # and the Dockerfile assert fails the build on purpose
railway up --service api
```

Then re-verify:

```bash
curl -s https://api-production-0a4ca.up.railway.app/health   # {"status":"ok"}
curl -s https://api-production-0a4ca.up.railway.app/ready    # db up, redis up
                                                             # may 503 on cold start — retry
curl -so /dev/null -w '%{http_code}\n' .../api/v2/exchange/offers      # 404
curl -so /dev/null -w '%{http_code}\n' .../api/v1/moments/feed         # 401
curl -s .../api/version                                                # buildId
```

`/health` and `/ready` are at the **root**, not under `/api` — `/api/health` is
a 404 and is not evidence of anything.

### 8c. Deploy the web surface to `spotme-web-v2`

**Needs:** Vercel access. Two traps the deploy session recorded, both real:

```bash
cd spotme/web
npm ci && npm run build
# The project's Root Directory is set, so deploy PREBUILT output.
npx vercel build --prod
test -d .vercel/output/static || { echo "EMPTY BUILD — do not deploy"; exit 1; }
npx vercel deploy --prebuilt --prod
```

The `test -d` line is not decoration: a zero exit status alone has previously
shipped an empty deployment.

**Order:** Vercel **before** Railway on any change where a new backend can 401
an old bundle.

---

## 9. Verification at the merged tree

| Gate | Result |
|---|---|
| backend `tsc --noEmit` | clean |
| backend `npm run build` | clean |
| backend `npm test` | **642 passed / 0 failed** (22 skipped, 5 suites skipped — need Redis/Typesense/MinIO) |
| web `npm run lint` | **clean** (master is not) |
| web `npm test` | clean |
| web `vite build` | clean |
| journey harness vs master's code | **18 passed / 0 failed / 2 not driven** |

**GitHub CI still has not run on this branch** — `ci.yml` triggers on
`pull_request` and pushes to `master` only, and you have not asked for a PR. So
this is locally verified, not CI-verified, with the same two gaps as before: the
5 suites needing Redis/Typesense/MinIO, and CI's `s3-verify-clean` step.

### Hygiene

- Nothing staged with `git add -A`; every commit staged named paths, and
  `git diff --cached` was read before each.
- `spotme/web/package-lock.json` reverted, not committed — `npm install`
  rewrote all 3,784 lines by changing indentation. Verified semantically
  identical (parsed JSON compares equal).
- `playwright` reverted out of `package.json` — the harnesses install it at run
  time and CI's `npm ci` should not carry it.
- **Changes on this branch that were not mine:** master's `5319d9b`, `48b6aeb`,
  `d578fda`, `ff05145`, `4bc8682` arrived via the merge. I did not modify any
  of them; I resolved every overlapping file **in their favour** and deleted my
  own duplicates. The one file of theirs I do change is
  `phone-harness.mjs`, and only to delete the two unused bindings failing CI.
- I did not touch the calls/realtime port or `rooms.js`.

---

## 10. What I need from you

1. **Your @username**, on its own line. Item 2 is one command from done.
2. **Merge this branch into master** (or ask me for a PR) — master is red and
   this is the fix.
3. **A decision on the orphaned-post trap** in §5: a post made without location
   permission is silently invisible to everyone, forever.
4. **The Google Fonts render-block** is still unfixed: `index.html` pulls
   `fonts.googleapis.com` as a render-blocking stylesheet with no fallback, so
   a blocked or slow CDN means a blank screen.
