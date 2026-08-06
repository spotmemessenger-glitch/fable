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
