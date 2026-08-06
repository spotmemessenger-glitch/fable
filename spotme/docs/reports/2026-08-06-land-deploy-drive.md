# Land, deploy both hosts, drive on mobile — session report

**Date:** 2026-08-06
**Branch:** `master`
**Merge commit:** `d578fda`

---

## Summary, in the order it matters

| # | Mission item | Outcome |
|---|---|---|
| 1 | Land the chain into master | **Done.** `d578fda`, real merge commit, pushed. |
| 2 | Deploy the api service | **Done and verified live.** `buildId` changed. |
| 3 | Write the single owner allowlist row | **BLOCKED — new, concrete diagnosis.** See §4. |
| 4 | Deploy `spotme-web-v2` | **Done and content-verified.** https://spotme-web-v2.vercel.app |
| 5 | Drive the whole app on a mobile viewport | **Done for everything not behind the Moments gate.** See §5. |

The previous two sessions were blocked on "no deploy credentials". That is
resolved — both CLIs are authenticated. What remains blocked is item 3, and the
reason is **not** credentials this time; it is network topology plus a missing
SSH key. §4 states it precisely enough to be fixed in one step.

**Correction to the mission brief:** `RAILWAY_TOKEN` and `VERCEL_TOKEN` are
**not** in this environment — checked in both shells and in the persisted User
and Machine scopes, all absent. The deploys succeeded because both CLIs hold
their own stored sessions (`railway whoami` → `spotmemessenger@gmail.com`,
`vercel whoami` → the `ysnap` team). Worth knowing, because a CI runner given
only those two env vars would still fail.

---

## 1. Landing

`origin/master` was at `6c675e9`, one merge further along than the last report
described. `claude/wave-1c-land-iphone-ecc8ff` was **not** an ancestor — three
commits were genuinely unlanded:

```
5319d9b  feat(moments): iPhone media — HEIC and .mov stripped before storage
48b6aeb  fix(moments): #/posts?m=<id> opens that post, not the feed
ff05145  docs(reports): land + iPhone media + deeplink session report
```

Merged `--no-ff` into master as `d578fda`. No squash, no rebase; commit identity
and authorship preserved. Typecheck clean after the merge.

One thing worth recording: `npx tsc --noEmit` initially reported ~15 errors of
the form `Property 'moment' does not exist on type 'PrismaClient'`. Those were a
**stale generated client**, not code — `npx prisma generate` cleared all of them.
A reviewer who trusted the first run would have concluded the merge broke the
build.

---

## 2. The api deploy

Deployed to Railway project `spotme-backend`, service `api`, environment
`production`.

**Proof it is the new image, not the old container:**

| | before | after |
|---|---|---|
| `/api/version` | `682627b50c4d6fdf` | **`84dfbddbab23bd0b`** |
| `/health` | 200 `{"status":"ok"}` | 200 `{"status":"ok"}` |
| `/ready` | 200 db up, redis up | 200 db up, redis up |

Gated routes answer in their expected class, **not 500** — which is the failure
mode the Wave-1D chain existed to fix:

```
/api/v1/moments/feed          -> 401
/api/v2/discovery/visibility  -> 401
/api/v1/moments/<bad-id>      -> 401
```

### The trap: `railway up` from the wrong directory

The first attempt failed in 34 s with

```
resolve : lstat .../snapshot-target-unpack/spotme: no such file or directory
```

The service has **Root Directory `spotme/backend`**, so the uploaded snapshot
must be rooted at the *repo* root — but this repo root carries many gigabytes of
unrelated ML clones (`CogVideo/`, `Wan2.2/`, `LTX-Video/`…), so uploading it is
not viable. Fix: stage the subtree at the right depth and upload that.

```bash
git archive HEAD spotme/backend | tar -x -C <staging>   # 2.8 MB
cd <staging> && railway up -p b25e2c6e-… -s api -e production
```

`git archive HEAD` also guarantees only **committed** files ship — no local
debris, no stray `.env`.

**Not verified:** that `ffmpeg` and `heif-convert` are present in the running
container. The Dockerfile change is in the deployed source and the build ran it,
but `railway ssh` needs an SSH key this machine does not have (§4), and the
permission layer blocked the build-log fetch. The definitive check is an actual
HEIC upload, which is gated behind item 3. **If an iPhone upload returns 503
`transcode-unavailable`, that is this unverified step failing.**

---

## 3. The web deploy

Built locally and deployed prebuilt to the **`spotme-web-v2`** Vercel project
(`prj_lNTasFskHPOqHthEsNhoALjxyrqT`), live at
**https://spotme-web-v2.vercel.app**.

Verified **by content, not by hash** — per the standing note that a hash check
here has produced 19 consecutive false readings:

```
GET /                       -> 200
bundle                      -> /assets/index-DA7urPJ_.js   (the one built here)
api-production-0a4ca        -> present   (API base baked in)
mo-backbtn                  -> present   (the new single-post view shipped)
```

Three separate traps had to be cleared, and all three exit 0 when they fail:

1. **Same Root Directory trap as Railway.** `spotme-web-v2` has Root Directory
   `spotme/web`, so `vercel build` run *from inside* `spotme/web` looks for
   `spotme/web/spotme/web` and dies with `Cannot resolve entry module
   index.html`. The build must run from the **repo root**. (Root `.vercel/` is
   gitignored, so this leaves nothing behind.)
2. **Stale `node_modules`.** `qrcode-generator` is declared in `package.json`
   but was absent from the installed tree, so `vite build` failed on an
   unresolved import from `src/views/verify.js`. `npm install` fixed it. The
   committed source was never broken.
3. **The empty build that reports success.** After the first failure, `vercel
   build` printed `"status": "ok" — Build completed successfully` while
   `.vercel/output/` contained **no `static/` directory at all** and
   `builds.json` recorded the `vite build` failure inside it. Reading the CLI's
   exit status alone would have shipped an empty deployment. Always check that
   `.vercel/output/static/` exists before deploying.

Also: a stale shell working directory inside `.vercel/output` produced
`EBUSY: resource busy or locked` on the rebuild. Harmless once understood.

**Deploy order:** the standing runbook says Vercel before Railway, because a
Railway-first rollout can 401 every user still on the old bundle. That risk did
not apply here — this change introduces no new auth requirement — but the order
was Railway-first and should be reversed on any change that does.

`spotme/web/.vercel/project.json` was restored to `spotme-messenger` afterwards,
so the repo is not left mis-linked.

---

## 4. The owner allowlist row — blocked, and this time the reason is precise

**Not done. Nobody was granted anything. Production gating is unchanged.**

Two independent blockers, one of which is the same as last time:

### a. The handle is still blank

The mission line reads `My handle is @__________`. The last session refused to
guess, on the grounds that granting a gated production surface to the wrong
account lets a stranger in. That reasoning still holds and I did not guess
either.

**But this may not actually be blocking.** `src/scripts/wave1c/owner-grant.ts`
already identifies the owner **by email**, not by handle:

```ts
const INVITED = [{ email: 'movietrends47@gmail.com', note: 'stage-a owner' }];
```

That is committed in the repo and matches the session's known owner email. The
script locates the account server-side by an exact unique selector and never
prints a userId. So if the owner's production account was made via `/auth/signup`
(which records an email), **no handle is needed**. A handle is only needed if the
account came from the web guest flow, which records no email.

I could not determine which, because of blocker (b).

### b. The production database is not reachable from here

This is new information and it is the real obstacle:

- `DATABASE_URL` resolves — through the Railway CLI, never printed — to
  **`postgis.railway.internal:5432`**. That is the private network. Prisma from
  this machine gets `Can't reach database server`.
- The `postgis` service exposes **no TCP proxy**: its variable *names* are
  `DATABASE_URL, PGDATA, POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD` and
  `RAILWAY_PRIVATE_DOMAIN`. There is no `DATABASE_PUBLIC_URL` and no
  `RAILWAY_TCP_PROXY_*`.
- `railway ssh` — the in-network route — refuses with **`No SSH keys found in
  your SSH agent or ~/.ssh/`**. This box has no SSH keys.

### To unblock — one of these, and the first is cleaner

1. **Add an SSH key to the Railway account.** Generate `ssh-keygen -t ed25519`
   and add the public key in Railway account settings. Then `railway ssh
   --service api` works and the grant runs inside the container, against the
   private DB, with no new public exposure.
2. **Enable a TCP proxy on the `postgis` service** in the Railway dashboard.
   That publishes `DATABASE_PUBLIC_URL` and makes the DB reachable directly —
   but it also exposes the database to the internet, so (1) is preferable.

I deliberately did **not** take the third route — wiring a one-shot script into
`main.ts`, deploying, and reverting. That is exactly the pattern that left
`runM2Proof()` executing on every production boot, purging a user and writing
and deleting allowlist rows on every restart, until the previous session caught
it. It should not be repeated.

**Production row counts remain unknown to me.** I did not read them, because I
could not connect.

---

## 5. The mobile drive — against the real deployment

Real Chromium at **390×844**, against **https://spotme-web-v2.vercel.app**
talking to the **deployed** Railway API. Two genuinely separate browsers, one
per account, so the chat legs are two real peers rather than two tabs.

| Step | Result | Evidence |
|---|---|---|
| onboarding renders on mobile | **PASS** | full form, no horizontal overflow |
| 18+ gate refuses a minor | **PASS** | `1994-05` proceeds; `2011-05` does not leave onboarding |
| signup + username claim | **PASS** | `@drv_a6q1`, `@drv_b6q1` claimed on the production registry |
| username search | **PASS** | A searching `drv_b6q1` returns `@drv_b6q1 / Drive B` |
| chat A→B | **PASS** | `hello-from-A-x7k2` appears on B's device |
| chat B→A | **PASS** | `reply-from-B-q9v4` appears on A's device |
| read receipts | **PASS** | A's message flips to **Read** |
| presence | **PASS** | each peer shows the other **Online** |
| identity survives reload | **PASS** | no re-signup; profile and chat list intact |
| nearby map | **PASS** | real Google map, real street names, radius rings |
| discovery presence | **PASS** | "1 nearby", B listed `online now` |
| share deeplink routes to a post | **PASS** | `#/posts?m=…` → heading **"Post"** + back arrow, **not** the chat inbox |
| Posts tab absent without allowlist | **PASS** | bottom nav is Discovery / Chats / Alerts only |
| **Moments feed 404s for a non-allowlisted account** | **PASS, in production** | `GET /api/v1/moments/feed?mode=friends` → **404** |

That last row is worth calling out: it is the half of the acceptance criterion
the previous session could only evidence client-side. A **404** rather than a
401 proves the request authenticated and was then refused by the domain gate —
the gate is doing its job on the live deployment.

### What could not be driven, and why

Everything behind the Moments gate: **posting a JPEG, posting a HEIC, posting an
iPhone `.mov`, stories, reels swipe, comment, react, report, block, delete own
post.** All of these need an allowlisted account, which is §4. This is the same
gate, not thirteen separate problems — one row unblocks all of them.

That specifically means **the iPhone HEIC/`.mov` work landed in this chain is
still unproven in production.** It is proven locally by 13 tests on the stored
bytes; it has never run against the deployed container. Chat media rides a
different path (blobstore), so sending a photo in a chat would not have
exercised it.

### Two corrections to my own observations

- I first recorded the 18+ refusal as **silent**. That is wrong. The handler
  calls `toast(AGE_REFUSAL)` (`main.js:436`); my snapshot was simply taken after
  the toast faded. The gate refuses *with* a message. I did not capture the
  toast, so I am not claiming I saw it — only that the code emits one and the
  navigation was correctly blocked.
- The deeplink shows **"Posts aren't switched on"** for my test account. That is
  **correct**, not the bug the previous report guarded against: that account
  genuinely is not allowlisted. Distinguishing it from the dead-link message
  ("This post isn't available") requires an allowlisted account — untestable
  until §4.

---

## 6. Latent issue noticed, not fixed

`start()` in `spotme/web/src/main.js` sets `starting = true` and
`goBtn.disabled = true` at line 438, but only clears them on the 400 (age) and
409 (username taken) branches. If anything after that throws — `boot()`,
`offerNotifications()`, `navigate()` — the Start button stays disabled and every
later click returns early at the `if (starting) return` guard **with no toast at
all**, so onboarding wedges silently until a reload.

I hit a symptom consistent with this while driving (a Start click that produced
neither navigation nor a message), though the account did in fact get created,
so I cannot claim a confirmed reproduction. A `try/finally` around the block
would close it. Out of scope for this session; flagging because a wedged signup
screen is invisible to the user and unrecoverable without a reload.

---

## 7. Honest list of what I did not do

- **Did not write the allowlist row.** §4. No production data was modified in
  this session at all.
- **Did not read any production database row.** I could not connect.
- **Did not verify `ffmpeg`/`heif-convert` inside the running container.** §2.
- **Did not prove the iPhone HEIC/`.mov` path in production.** §5.
- **Did not measure paint timings.** A localhost-class harness is the wrong
  instrument, and the previous two sessions each produced a misleading number
  this way. Use Lighthouse or field RUM against the deployment.
- **Did not touch** calls/realtime or `rooms.js`.
- **Did not print, log or commit any credential.** `DATABASE_URL` was only ever
  resolved inside `railway run`; variable *names* were listed, never values.
  `vercel link` added `.env*` to the root `.gitignore`, which is kept — it is
  what stops the OIDC token it wrote to `.env.local` from being committed.

---

## What the owner needs to supply

1. **An SSH key on the Railway account** (preferred), or a TCP proxy on the
   `postgis` service. Either one unblocks the allowlist row, and with it every
   Moments journey step and the production iPhone-media proof.
2. **The @username — only if** the owner's production account was created
   through the web guest flow. If it was created via signup with
   `movietrends47@gmail.com`, the committed `owner-grant.ts` already has what it
   needs and no handle is required.
