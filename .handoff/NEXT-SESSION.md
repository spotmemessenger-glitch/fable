# START HERE — pickup brief

**Written:** 2026-07-29, end of session.
**Updated:** 2026-07-31 overnight. Everything below was verified by RUNNING it.

---

## 0. LATEST (2026-07-31 overnight) — SUPERSEDES EVERYTHING BELOW

PR #6 is MERGED. `master` is at `81858cc`. The designated branch was restarted
from it (documented procedure for a merged branch) and now carries TEN
commits, all pushed, on **PR #7 (draft)**. PR #2 is still open, still rebased,
still unmerged.

```
master  81858cc
PR #7   claude/next-session-b6ypc5   cc0057d   DRAFT — this session's work
PR #2   feature/centrifugo-transport 02611cf   OPEN, unmerged
```

### How this session was run

Five audit agents in parallel (transport, crypto/storage, backend security,
UX wiring, build/PWA), each told to prove a fault or drop it, while I drove the
real app in two browsers against a real local stack (Postgres + NestJS on :4000
+ Vite on :5173). **Every fix below was verified independently before it was
applied** — several agent claims were wrong or narrower than reported, and one
("reactions are broken") turned out to be my own harness clicking inside a
deliberate 400 ms ghost-click window.

### What was actually wrong, and is now fixed

**Message loss — four separate paths, all in transport:**

1. `rejoin()` read `ack.events` and ignored `ack.envelopes`, then advanced the
   cursor anyway. The server strips `bin` rows from `events`
   (`type: { not: 'bin' }`), so an envelope is the ONLY way a missed attachment
   returns. Every photo/voice note/file received across a reconnect was dropped
   and marked consumed. `joinPromise` is cached, so `join` runs once per page
   load and every drop after that took this path — the common case on a phone.
2. Every room joined TWICE on first connect (`on('connect')` is registered above
   the `once('connect', resolve)` that settles `socketPromise`). Duplicate
   messages were absorbed by `store.add`'s id check, so it was invisible — but
   the second loop's `unopenedFloor = null` cleared a floor the first had just
   set, and the cursor then advanced past a frame it could not open.
3. Live frames dispatched concurrently while the replay loops are sequential. A
   frame that decrypted could move the cursor while an earlier failing frame was
   still inside `refreshRoomKey`, before its hold was set. Same race reordered
   `edit` past the `msg` it edits, which returns silently.
4. `replay()` capped events at `REPLAY_LIMIT` but computed `lastEventId` from an
   UNCAPPED attachments query — a client far enough behind advanced past events
   it was never sent (1200 messages in the case worked through). Now the
   frontier is where the capped query stopped, the ack says `truncated`, and the
   client drains pages.

**Identity — two catastrophic:**

5. `loadIdentity` did `.catch(() => null)` on its readonly get, collapsing
   "nothing stored" into "the read threw" — and that branch generates a key and
   `put`s it over the existing one. Non-extractable, so no copy: every v2
   conversation dies. A quota blip or an iOS-suspended tab was enough, and the
   device then reported `identityStatus() === 'ok'`.
6. `wipeDevice` walked localStorage only; the identity key lives in IndexedDB.
   "Clear all data" left it, and the next launch published the same key under a
   new account id.

**Accounts and data:**

7. `POST /api/push` — no guard, `userId` from the body, no FK behind it. Anyone
   could wipe a victim's push registrations, or point their own endpoint at a
   victim's id and receive a live feed of which rooms were active (`tag: roomId`).
8. `GET /api/knock?userId=<anyone>` — **no authentication at all**, and every
   stored knock carries `roomId` AND `secret`, the room's encryption key, for 30
   days. `_auth.js` (written for exactly this hole in `/api/translate`) was one
   file away and never imported.
9. `guestAuth` never cleared `deletedAt`, so re-claiming a released username left
   {deletedAt set, ordinary username} = permanently 403. **Our own reset flow
   does this** when the wipe half fails (private mode / quota).
10. Three endpoints returned other users' full `User` rows including
    `claimSecretHash` — the sole credential `guestAuth` checks. A chat request
    was enough to harvest one.
11. `GET /api/users/lookup` with NO parameter returned an arbitrary real account
    (`@Query` -> undefined -> Prisma strips it -> no filter). Verified live.
12. A knock's sender was taken from the payload while the authenticated sender
    sat unused in `meta.peerId`. Any user could knock as anyone, and
    `receiveKnock` stores the ATTACKER's roomId and secret.

13a. The bridged /api handlers verified a token's SIGNATURE but never asked
    whether the account still existed, so a deleted user's token kept working
    against /api/knock, /api/translate, /api/voice and /api/presence for its
    full 15-minute life while /api/auth/* refused it. One gate now covers all
    four (`src/middleware/guestAuth.ts`). `/api/turn` is deliberately NOT gated
    — it is fetched at boot before a token can exist and `readyRTC()` caches the
    result, so a 401 there pins the session to STUN-only. It is still
    unauthenticated and still mints Cloudflare credentials: see item 4 below.

**Shipped-broken and unreachable:**

13. A cloud build with `VITE_SPOTME_SERVER` unset resolved `API_BASE` to `''` and
    pointed the socket at the static host. App loads, onboarding works, chat
    never connects. Exit 0, no warning. `api.js` now falls back to the hosted
    API (DEPLOY.md's address); `.vercelignore` covers `.env*`.
14. `profile.js` claimed usernames against a DIFFERENT origin from the one
    everyone searches — two registries really do exist.
15. `#/groups` (~1200 lines: wizard, roles, bans, join-by-@handle) was a closed
    loop with no way in. `#/contacts` had no `nav()` anywhere. The Bluetooth
    scanner's only door was an empty state that vanished after first use.
16. A brand-new chat said "the server could read it" while actually on e2e_v2 —
    `convo` is captured once and `reach` upgrades asynchronously. The same stale
    read made `keyWarning` **unreachable** on exactly those rooms.
17. A failed TEXT message had no retry and nothing retried it (socket.io splices
    the packet once the ack times out). A group created in-app could never be
    shared. `inertNet` was missing `sendEdit`. "Last seen & online",
    "Transliteration" and "Read aloud" all wrote settings nothing read.

### THE TRAP THAT COST ME TWO FALSE ALARMS

Both were the harness, not the app:

- **Photo**: an earlier harness waited on `.psheet .pdone` (the view-once sheet).
  The ordinary photo path goes through the EDITOR and `.pe-send`. Photos work.
- **Reactions**: the message sheet arms itself against ghost clicks for 400 ms
  (`chat.js`, `Date.now() - mountedAt < 400`) because a long-press mounts a sheet
  under the finger. Playwright clicks faster than that. Reactions work.
- **Reload "data loss"**: sampling the thread once, 5 s after reload. With
  polling it reports *all persisted, all kept*.

**Rule: before believing a UI feature is broken, check the harness isn't
fighting deliberate armour.** Assert on what a user would see, and poll.

### Verification standard used throughout

Every fix has a regression test, and the important ones are MUTATION-VERIFIED —
revert the fix and exactly the checks that name it fail. Proven for: the
identity read fix, the knock impersonation guard, the relay auth gate, and text
retry.

```
web       25 suites green   (viewonce 17/21 is PRE-EXISTING — confirmed at
                             17/21 before any of this session's changes)
backend   6 suites / 44 tests, tsc --noEmit clean
build     vite build clean; a no-env build now bakes the Railway origin
E2E       test/e2e/full-journey.mjs — two real browsers, see below
```

### The E2E harness is the thing to run first next session

`spotme/web/test/e2e/full-journey.mjs` drives two isolated browser contexts
through: onboarding, @username discovery, the knock, text both ways, unicode, a
**20-message burst checked for loss / duplication / ordering**, read receipts,
typing, reactions, replies, a photo through the real editor, an offline window,
and a reload. It needs Postgres + backend + Vite up (see below).

```bash
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/spotme-test \
  -l /var/lib/postgresql/pg.log -o '-k /tmp -p 5432 -h 127.0.0.1' start"
cd spotme/backend && set -a && . /tmp/be.env && set +a && node dist/main.js &
cd spotme/web && npx vite --host 127.0.0.1 --port 5173 &
node test/e2e/full-journey.mjs
```

`/tmp/be.env` needs DATABASE_URL, JWT_ACCESS_SECRET (**now >= 32 chars or the
backend refuses to boot** — that is deliberate), JWT_REFRESH_SECRET, PORT=4000.
Playwright lives in the scratchpad and is symlinked into `web/node_modules`;
recreate the symlink if the container is new.

### STILL OPEN — ranked, with the evidence already gathered

1. **Any authenticated user can join any DM room.** `onJoin` refuses only
   `policy?.banned`, and `policyFor` returns null for every DM. Room ids are
   `dm-${cyrb53(sorted ids)}` — a pure function of two public ids. So: enumerate
   ids via username search, compute the room id, mint a guest token, join,
   replay 5000 events. For v1 rooms the secret is derivable the same way.
   **The data to fix it already exists** — `push.remember()` writes a
   `RoomMember` row on every join and it is never consulted. Suggested: refuse
   the join if `RoomMember` rows exist for that room and the caller is not one.
2. **`POST /api/groups` accepts an arbitrary `roomId`.** Plant a Group on
   someone's DM room and `policyFor` starts returning `banned: true` for the
   real participants — they are locked out of their own conversation. Fix:
   refuse a roomId that already has `RoomMember` rows.
3. **No rate limiting anywhere.** `@nestjs/throttler` is not a dependency.
   `verifyOtp` has no attempt counter — a 6-digit code with unlimited parallel
   guesses. `/api/username` enumerates the whole registry with ids attached.
4. **`/api/presence` is still unauthenticated** (same shape as `/api/knock`,
   returns `roomKey`/`writerKey`). Same one-file fix; I did knock only.
5. **Both JWT strategies use the same secret**, so `EmployeeAuthGuard` accepts an
   ordinary user token. Only `RolesGuard` stands between that and the admin
   surface, and every staff route does carry `@Roles` — so it is a loaded gun,
   not a fired one. Fix with an `aud` claim.
6. **Deleting an account leaves the session alive**: tokens valid till expiry,
   open sockets never re-checked, GroupMember/PushSubscription rows untouched.
7. **`fetchreq`/`fetchres` bypass the cursor hold** (`return void handle…`) and
   `handleFetchRes` clears its timer before awaiting, so a decrypt failure hangs
   the caller forever.
8. **`unwrapMeta` falls back to server cleartext** when the sealed copy fails to
   authenticate — the only place in the codebase a GCM tag failure does not drop
   the data. Attacker-chosen `id` can also pre-empt a real message via dedupe.
9. **No `navigator.storage.persist()`**, and the identity key is non-extractable
   with no backup. iOS evicts script-writable storage after ~7 days unused, which
   silently kills every conversation. Needs a product decision, not a patch.
10. **A device whose own published key was overwritten by the same account on
    another origin cannot self-heal.** Unchanged and still deliberate —
    republish-on-mismatch makes two live origins fight each launch.

### Blocked on the owner (I cannot do these)

- Handset test on @Justice12 / @mistry11.
- `cd spotme/backend && npm run deploy` (Railway CLI, not authenticated here).
- Purge ghost accounts `probedesk9`, `smoketest_desk`.
- **Rotate the R2 secret access key and the `cfat_…` Cloudflare token.**
- Decide whether to merge PR #2.

---

## 0000000. EARLIER (2026-07-31 night) — superseded by the section above

**`master` is `c5c9e07`. PRs #3 and #4 are MERGED. Vercel builds from master, so
the fixes are shipping. No Railway deploy is needed — both changes are
client-side only, so the Vercel-before-Railway rule does not bite this time.**

```
master  c5c9e07  Self-healing key re-fetch (#4)
        f09d49d  Hotfix: stop a keyless device poisoning every chat (#3)
PR #2   feature/centrifugo-transport — STILL OPEN, and now conflicts on THIS FILE
```

### READ THIS BEFORE TESTING ON THE HANDSETS

**The two merged PRs do NOT fix @vijay22 ↔ @ajith11 while that phone still
cannot persist its key.** This is the single most likely way to misread the next
test, so it is first. Walk the changes through that device:

1. It cannot write IndexedDB, so it mints a fresh keypair every launch.
2. PR #3 now makes it **refuse to publish** that ephemeral key. The server keeps
   the ORIGINAL key, V₁.
3. But the phone holds Vₙ's private half, not V₁'s. It derives a different room
   key than @ajith11 does. That pair stays broken.
4. PR #4 on @ajith11's side re-fetches @vijay22's CURRENT published key — and
   gets V₁ back, because #3 just froze it. Same key, so the repair cannot land.

That is not a bug in either PR. It is the deliberate trade in #3 (protect every
other chat at the cost of that one device's session), and #4 repairs the PEERS
of such a device, not the device itself. **Neither makes Safari store the key.**

What the merge does buy, today: every other chat @vijay22 is in stops being
poisoned on each launch; any conversation broken by an ORDINARY key rotation now
repairs itself on the first undecryptable frame; a failed send says so instead
of showing "✓ Sent"; and the moment that device does persist a key, @ajith11's
side self-heals on the first message and stays healed.

**Messages already dropped stay lost either way** — the cursor advances in
`dispatch`'s `finally` whether or not the frame opened. Those two chats need
recreating once the storage bug is fixed.

### TASK 3 IS NOW A ONE-LINE ANSWER, NOT AN INVESTIGATION

Connect @vijay22's iPhone to the Mac by cable, open Safari DevTools,
**hard-reload the PWA so the phone actually has the new bundle**, and read the
console:

- `spotme identity: NOT republishing — this device cannot persist its key`
  → the IndexedDB/Safari bug is still there, that chat will NOT heal, and this
  is the blocker. Everything else is downstream of it.
- **No warning** → the key persisted. Send one message; @ajith11's side should
  repair on that frame, and both directions then work.

The `persisted` flag from PR #3 is what makes this observable at all. Before it,
the failure was invisible by construction.

### What PR #4 added (`spotme/web`, 452 lines, one new test file)

`roomKeyForConvo(convo, fetchToken, opts)` takes `forceRefetch` — the stored
`convo.peerKey` was PREFERRED and only fetched when absent, which is what made a
stale key permanent. Evicting the transport's key cache alone fixes nothing; the
provider re-derives from the same stored value. `onPeerKeyChanged` reports a
recovered key back because this module must not import `db` (import cycle).

`refreshRoomKey(roomId)` in `socket-transport.js`, called from `dispatch` on
**`OperationError` only** — AES-GCM refusing to authenticate means the key is
wrong; a `SyntaxError` from `JSON.parse` means we DID decrypt and the sender
sent nonsense. Guardrails: one retry per frame, one re-fetch per room per 30s,
concurrent failures coalesce onto one fetch, v1 rooms never offered a repair.

The captured `keyPromise` had to go — it resolved once for the life of the page,
so a repaired room would have healed in the cache and stayed broken in the room.

`test/key-self-heal.test.js`, 15 checks, **fails 4/22 against the pre-fix tree**.
It drives the room's real `onFrame` (what `socket.on('action')` calls), not the
modules alone — deliberately, because this project's most expensive bug was a
V-19 cut with correct crypto that was never called and passed its module tests.

### The two test users — there IS a route, with a catch

`DELETE /api/users/me` exists but is **self-service**: it acts on the JWT's
subject. **`AdminController` has NO user-deletion route at all** (growth, health,
audit log, employees only) — that is why the admin dashboard could not do it.

So you need a token AS each user. `auth.service.ts:152` rejects a mismatched
claim secret, and `claimSecretHash` is set ONLY at creation. The web client
generates `claimSecret: randomHex(16)` (`db.js:139`) while the transport falls
back to `anon_<id>` (`socket-transport.js:307`) — so it depends on how the
probes were made:

```bash
API=https://api-production-0a4ca.up.railway.app
curl -sS -X POST $API/api/auth/guest -H 'content-type: application/json' \
  -d '{"id":"ed112d1b973ba7b860f471f01e3acc8d","username":"smoketest_desk","secret":"anon_ed112d1b973ba7b860f471f01e3acc8d"}'
# tokens -> curl -X DELETE $API/api/users/me -H "authorization: Bearer <accessToken>"
# 401    -> random claim secret, gone with the device; neither route can reach it
```

Same shape for `probedesk9` / `731ffdf1a5e30958`. It is a **soft** delete
(`deletedAt` set, email/phone nulled) — enough to drop them from username
search, key lookup, group member search and the admin counts; the row stays.
**If the 401 comes back, the real fix is adding an admin delete route.**

### Traps found this session — do not rediscover

- **A cloud session cannot reach `*.vercel.app` or `*.railway.app`.** The agent
  proxy answers 403 to CONNECT. Verifying a deploy or touching production has to
  happen from your own machine. Build locally and grep `dist/assets/index-*.js`
  instead — that proves the minifier kept the fix, which is most of the value.
- **`test/viewonce.test.js` is 17/21 on Linux/node 22**, failing the four checks
  that assert media reaches disk. Identical at `67bacf7`, `e8ee362`, `9c81ffd`
  and `a453b9e`, so it PREDATES PR #1 — not caused by any recent change. Not
  module mocking either: `media.test.js` uses the same flag and passes 41/41.
  Prior sessions measured on Windows. Flagged, not diagnosed.
- **The container's local `master` was a divergent 26-July line** (`c88c214`,
  57 ahead / 50 behind `origin/master`). Building or pushing from it would ship
  five-day-old code. Check `git rev-parse master origin/master` before trusting
  a local branch name in a fresh clone.
- A stop hook may offer to `--reset-author` unsigned commits onto Claude. Those
  50 commits are **Youvaraja's own work**; rewriting them would misattribute
  them, they are not on any remote, and changing an author email does not sign
  anything — "Unverified" is about GPG/SSH signing.

### Still blocked on the user

1. **Safari DevTools on @vijay22's iPhone** — task 3 above. Everything about
   those two chats is downstream of it.
2. **Rotate the R2 secret access key and the `cfat_…` Cloudflare token** — both
   were pasted into the 2026-07-31 transcript, which is on disk. Still not done.
3. Delete the two test users (see above).
4. **PR #2 is open and now conflicts with this file.** This section was written
   directly on master by agreement, accepting that. PR #2's branch carries its
   own `## 00000` section, which the section you are reading supersedes on every
   point they disagree.

---

## 000. LATEST (2026-07-31 morning) — READ THIS FIRST, IT SUPERSEDES 00

**Repo: `spotmemessenger-glitch/fable`, branch `master`, HEAD `ad0b123`, fully
pushed.** Git here is HTTPS + Windows Credential Manager — there is NO ssh key
on this machine and never was. On the Mac: `gh auth login` then
`gh repo clone spotmemessenger-glitch/fable`.

### What is live, and what is not

- **Vercel IS live with every fix.** Verified in the served bundle:
  `sends 'authorization' 1`, `view-once burn 3`, `'Storage full' 2`.
- **Railway is NOT deployed.** Server-side view-once deletion and the
  voice-note truncation guard are inert until
  `cd spotme/backend && npm run deploy`. Nothing is broken meanwhile: the new
  bundle sends a token, the old backend ignores it.
- **DEPLOY ORDER MATTERS: Vercel first, then Railway.** Railway-first makes the
  new backend demand a token from every user still on the old bundle → 401 on
  every call, and `lib/voice.js` throws on non-OK, so voice breaks visibly.

**TRAP THAT COST AN HOUR — read before writing any verification loop.** The
bundle path is `/assets/index-*.js`. A check that greps `index-*.js` without
the `/assets/` prefix fetches a 404 PAGE and reports 0 matches forever. That
produced 19 consecutive false "not deployed" readings against a deploy that
had already succeeded.

### The overnight audit — 12 agents, 12 reports in `.reports/`

8 auditors (T1 T2 TL1 TL2 V1 V2 P1 P2) then 4 fixers (voice, viewonce,
language, security). ~40 fixes in 17 commits. Gates on the combined tree:
web 11 suites / 241 checks, backend 34/34, both builds real.

**Two decisions are waiting on the user — neither is engineering:**

1. **V-19, the biggest open item.** DM room keys derive from
   `stableHash("spotme-dm-secret-v1:" + sorted user ids)` — cyrb53, a
   NON-cryptographic hash of two values the server already stores. The server
   can recompute any room key and decrypt everything. Four agents independently
   ranked this top; none touched it because changing the derivation makes every
   existing conversation permanently unreadable. Safe shape: VERSIONED
   derivation — old rooms keep the old scheme, new rooms get real entropy.
   **The onboarding screen says "no server reading your messages." That is
   currently false — change the copy even if the fix waits.**
2. **View-once in PUBLIC groups.** The server holds the room key there, and the
   composer offers the "Private photo" tile with no warning. Disable it in
   public groups, or warn unmissably.

### Environment changes made 2026-07-31

- `ANTHROPIC_API_KEY` + `READ_MODEL=claude-haiku-4-5-20251001` set on Railway
  AND Vercel. Haiku ~1.6s vs the old 3.7s read path. **Caveat:** on
  `"naan innaiku vetuku varen"` both Claude models said "hunting" where the
  chain says "coming home" — Anthropic is now the PRIMARY reader, so if
  quality dips that is why, and the fix is reordering one list in `llmRead`.
- **All 7 vendor keys were REMOVED from Vercel** (Anthropic/OpenAI/Gemini/
  Sarvam/ElevenLabs/Azure/Google) because both `/api/translate` and
  `/api/voice` were open, unauthenticated and unthrottled there. The app is
  unaffected — it calls Railway (`VITE_SPOTME_SERVER`), so those Vercel
  functions are vestigial. The code fix is deployed now too, but the keys are
  still absent: **restore them only if something is actually meant to serve
  from Vercel.**
- 260 shell-debris files deleted from the repo (names like `!(m.viewOnce`,
  `(4-n%4)%4`). List at the session scratchpad `deleted-junk.txt`. **Do not
  bulk-delete untracked entries**: real cloned tools (`MetaGPT/`,
  `OmniParser/`, `ClaudeDesktopCommander/`, `eas-cli/`) are untracked too.

### iPhone re-test list — EVERY measurement was Chromium on Windows

The reported bugs were iPhone Safari, where the codec (AAC/mp4 vs Opus/webm),
autoplay policy, storage limit and tab suspension all differ. Five minutes on
the phone, in order:
1. 30s voice note — sends fast? first tap makes sound?
2. Several notes, then reload — any "tap to load"? (that was bytes discarded)
3. Note while the other phone is locked — still "Not delivered"?
4. Plain English in a Tamil chat — stays English?
5. Private photo — countdown appears on the SENDER's side?

If 1 or 2 fail, the `audioBitsPerSecond: 24000` hint is being ignored by Safari
and the fix has to become a transcode, not a tweak.

### Still uncommitted, deliberately (predates the audit, separate track)

`spotme/admin-dashboard/`, `spotme/app/lib/{db,reach}.js`,
`spotme/app/screens/`, `spotme/app/theme.js`, and modifications to
`spotme/app/package.json` + `worklet/app.bundle.mjs`.

### TestFlight

Blocked on the Mac — Windows cannot build iOS. There is still no
`spotme/web/ios/`. Start with `cd spotme/web && npm install && npx cap add ios`,
then an APNs `.p8` uploaded to Firebase project `spot-messenger-48a74`.

---

## 00. LATEST (2026-07-30 late evening) — read this first

**The Vercel 404 had a root cause nobody had found, and it was not the code.**
The Vercel project is git-linked to `spotmemessenger-glitch/fable` with **no
Root Directory set**, so every push to master built the REPO ROOT: no app
there, empty `/vercel/output`, a 1-second "success", and that empty deployment
then took the production alias away from the good CLI deploy. That is why the
site went 404 within minutes of each `git push` — including right after the
"fix" commit `c76f097`. Root Directory is now set to `spotme/web` via the
Vercel API. A git-triggered deploy was then run and verified: root **200**,
real HTML, `api/*` lambdas built, `/api/translate` returning
`{"engine":"sarvam+azure/openai","confirmed":true}`.
**If the site 404s again, check that setting before touching any code.**

**Groups v2 P3 (web UI) is BUILT and verified** — see
`spotme/docs/GROUPS-BUILD.md` for the full record. New: `lib/groups-api.js`,
`lib/group-perms.js`, `views/group-new.js` (3-step wizard),
`views/group-manage.js`, rewritten `views/groups.js`, route `#/group/<id>`.
Driven in a real browser against the local backend: wizard create → 3 members
+ OWNER on the server, promote to ADMIN, permission toggle persisted, ban,
lift ban. Backend 26/26, web +11 new tests. Commit is local — **not pushed**.

**Three bugs found by building it, all fixed:**
1. `ui.js el()` wrote `disabled="false"`, which HTML reads as disabled — the
   wizard's Create button was dead from first paint.
2. **Un-banning was impossible**: `setBan` stamps `leftAt` too, `memberInclude`
   filtered on it and `requireTarget` rejected it, so banned members vanished
   from every payload and the unban route 404'd.
3. Lifting a ban cleared only `bannedAt`, leaving `leftAt` set and the
   `RoomMember` row deleted — restored to the roster but still receiving
   nothing.

**New trap — `nest build` can exit 0 and emit NOTHING.** `deleteOutDir: true`
wipes `dist/` while `incremental: true` makes tsc decide there is nothing to
emit, so you get an empty `dist` and a 0 exit code. Worse: a stale backend may
still hold :4000, so you are testing hours-old code. Delete
`tsconfig.build.tsbuildinfo` before building, and prove a route you just added
actually answers (404 on a new route = stale process).

**Google Maps was dead in production for the same class of reason.**
`VITE_GMAPS_KEY` lives only in `spotme/web/.env.local` (gitignored, correctly),
and it had never been added to Vercel — the only `VITE_*` var there was
`VITE_SPOTME_SERVER`. Vite inlines `import.meta.env.*` at BUILD time, so every
production bundle shipped `maps/api/js?key=` with nothing after it and Google
refused the script; the app fell back to its drawn map. Fixed by adding
`VITE_GMAPS_KEY` to the Vercel project (production+preview+development) and
redeploying; the live bundle now carries the real key and the Maps API
authenticates on the Vercel origin with no `gm_authFailure`. **Rule: any new
`VITE_*` var must be added to Vercel too — `.env.local` never travels.**

**Everything above is pushed and deployed.** Web is live; the backend ban/unban
fix was confirmed in production by running a real ban → unban round trip
(Railway served the PREVIOUS container for ~4 minutes after `npm run deploy`
reported success — a health check cannot tell the difference).

---

## 0a. IF YOU ARE ON THE MacBOOK — this is your task

The Windows PC cannot do iOS at all (verified: `MINGW64_NT-10.0-19045`, no
`/System/Library`, no `sw_vers`). Xcode is macOS-only, so everything iOS was
blocked until now. The user has a MacBook AND an Apple Developer account, and
both an Android and an iOS device connected **to the Mac**.

**There is no `spotme/web/ios/` directory yet.** First commands:

```bash
cd spotme/web && npm install && npx cap add ios && npx cap sync ios
```

Then, for iOS push:
1. Apple Developer → Keys → create an **APNs key** (`.p8`).
2. Upload it into the Firebase project **`spot-messenger-48a74`**
   (Project Settings → Cloud Messaging → APNs Authentication Key).
3. Build/run on the connected iPhone from Xcode.

**The server needs NO changes for iOS.** Already deployed and live: the `apns`
block (`apns-priority: 10`, `content-available`, `thread-id`),
`DeviceToken.platform` accepts `'ios'`, and the client's `registerNativePush()`
already reports `ios` via `Capacitor.getPlatform()`.

**Do not commit `.keys/`** — gitignored, and the Mac does not need it. Only the
server does, and Railway already holds it.

## 0b. THE ONE THING STILL UNPROVEN

**No real phone has ever received a push.** Production holds exactly ONE device
token (`@qa_probe_02`, the Android emulator) and ZERO web-push subscriptions.
The whole chain is verified on the emulator — real chat message → server → FCM
→ tray notification on an idle, screen-off device — but never on a real handset.
Getting one notification onto a real phone is the next milestone.

This route was IMPOSSIBLE until 2026-07-30 late evening — the site was 404, so
there was nothing to add to a Home Screen. It is live now (see section 00), and
the PWA prerequisites were checked on the live site: `display: standalone`,
`apple-mobile-web-app-capable`, `/sw.js` 200, `/api/push` reports
`enabled:true` with a VAPID public key.

Fastest route on iPhone, needing no build at all: open
https://spotme-messenger.vercel.app in Safari → **Add to Home Screen** → open
**from the icon** → allow notifications. iOS 16.4+ supports Web Push only for a
Home Screen install, and the first-run prompt now asks directly.

## 0c. What landed 2026-07-30 (6 commits, `8fe2753..47247d5`, pushed)

- **The Railway deploy had been silently failing for a DAY.** `.deploy/` was
  gitignored and `railway up` skips gitignored paths, so the staged `web/api`
  never reached the build context, the Dockerfile's own assert failed the
  build, and Railway kept serving the PREVIOUS container. Staging is now
  `deploy-api/` (untracked but NOT ignored). A `.railwayignore` does not help —
  it only ADDS exclusions. Production now returns
  `{"engine":"sarvam+azure/openai","confirmed":true}`.
- **The Vercel site had been 404 for days**, same class of bug: `spotme-core`
  was `"file:.."`, outside the only directory Vercel uploads. Now a real local
  package at `web/vendor/spotme-core` — which must NEVER be gitignored.
- **Azure Translator key was dead** (401 everywhere). Replaced; the new key
  works ONLY against the resource endpoint
  (`ytranslator-yuvraj-2026.cognitiveservices.azure.com`) — the global host
  `api.cognitive.microsofttranslator.com` 401s for every region. Do not
  "simplify" `azureBase()` to the global host.
- **Groups v2**: roles (OWNER/ADMIN/MODERATOR/MEMBER), granular grants,
  ban/mute, transfer, public groups with @username, 30-day soft delete. 26
  tests pass. **The rooms gateway previously authorised NOTHING** — knowing a
  roomId was the whole access model, so a ban was decorative; join/send are now
  policy-checked. Delete-permission is only partly enforceable (the target id
  is inside the ciphertext — clients must send cleartext `meta.owner`).
- **FCM push** built and verified on the emulator. Web Push can NEVER work in
  the packaged app: Capacitor's WebView has no `PushManager` and no
  `Notification` (verified on-device).
- Composer no longer zooms the app on mobile (16px floor on coarse pointers).

**Groups has NO web UI yet** — `groups.js` still says "no admin, no server".
The 3-step wizard, roles screens and chat-list integration are unbuilt.

---

## 0. LATEST (2026-07-30 overnight): Spot Me now runs on a server backend

**IT IS LIVE.** Web: https://spotme-messenger.vercel.app — Backend API +
`/rooms` socket: https://api-production-0a4ca.up.railway.app (Railway project
`spotme-backend`, services `api` + `Postgres`). Deploy commands and the reasons
behind them are in `spotme/web/DEPLOY.md`. Verified in production: username
availability + search, knock opens the chat on both devices, and a message sent
while the recipient's tab was CLOSED arrived on reopen. Note: a Railway "Deploy
Crashed" email refers to the FIRST attempt (Prisma/libssl), fixed in `8e734e2`.

**FIRST TASK NEXT SESSION (one command, then one check):**
```
cd spotme/backend && npm run deploy
curl -s -X POST https://api-production-0a4ca.up.railway.app/api/translate \
  -H "content-type: application/json" -d '{"q":"are you coming tonight?","target":"ta"}'
```
Expect a `"confirmed"` field. At the end of 2026-07-30 production was still
answering `{"engine":"azure"}` with no `confirmed` — the cross-confirmation
deploy had not taken effect. Code and keys are committed and set; it just needs
the deploy to land. **Never plain `railway up`** — `npm run deploy` stages
`web/api` into the image, and without it every /api/* route 404s.

**Also done 2026-07-30 (all committed):**
- **Push notifications** live: the server pushes when an event lands for
  someone not connected. Only msg/knock, never the sender, no text in the
  payload. Real-device delivery still unverified.
- **Translation + transliteration fixed** after five packaging faults —
  see the memory note `spotme-language-pipeline`. Engines now cross-confirm:
  Sarvam in parallel with Azure/Google, LLM adjudicates disagreements. User
  confirmed Google Input Tools should win transliteration disputes.
- **ybot**: voice loop (ElevenLabs streaming, real barge-in, ctrl+space
  push-to-talk) and a 3D saree avatar with 15-viseme lip sync, wired live to
  the voice service. Run: `python run.py --voice` plus
  `python -m ybot.avatar_server`. Never tested with a real microphone — that
  needs the user.
- Working keys: Sarvam `sk_w64e4low…`, OpenAI `sk-proj-OrZ…`. Gemini
  authenticates but its AI Studio project has no credit (429).

**What happened:** the web app's Trystero/BitTorrent-tracker transport was
replaced by a server-backed one. Commits `7aad447` (backend), `43cfc02` (web),
`9603543` (docs). The UI is UNTOUCHED (user: "stick to this UI").

**PROVEN by two-browser Playwright E2E** (screenshots in
`spotme/docs/verification/`): onboarding + username registry on the backend,
knock→chat both sides, live encrypted text, presence Online/Last-seen, Read
receipts, **offline text delivery via replay**, live photo (5 encrypted slices
+ binack), **offline photo (envelope replay + tap-to-load lazy fetch from the
server)** — the old P0 media-persistence bug is structurally fixed. Test
suites: web 24/24 + 32/32 + 21/21.

**How to run:**
```
docker start spotme-postgres                     # port 5433
cd spotme/backend && node dist/main.js           # :4000 (or npm run start:dev)
cd spotme/web && npx vite                        # :5173, proxies /api + /socket.io
```
Two isolated identities for testing: open localhost:5173 AND 127.0.0.1:5173
(different origins → different localStorage). `?fresh` resets a device.

**Architecture (see spotme/docs/02-SYSTEM-ARCHITECTURE.md):** rooms are
Socket.IO rooms on NestJS; persistent actions append to Postgres `RoomEvent`
(AES-GCM ciphertext, key derived client-side from the room secret — server
never sees plaintext); clients replay from a per-room cursor. Calls remain
true P2P (WebRTC, signalling relayed). `web/src/lib/socket-transport.js` is a
drop-in for the Trystero API; `localStorage['spotme.transport']='p2p'` reverts.

**Morning session (2026-07-30 ~10:30-11:30) — one serious bug found and fixed.**
Commit `8e1853c`. Symptom: chat silently stopped delivering. Cause: payloads
crossed the wire as Buffers, and socket.io frames each Buffer separately after
the JSON packet; when anything interleaves (a heartbeat, another emit) the
client decoder reads text where it expects binary and drops the socket with
`parse error`. A join replaying ~8-11 events did that every time, then sat in a
permanent reconnect loop — invisible because sends fail asynchronously.
Fix: base64 text payloads end to end, token minted per handshake (so a tab that
slept past the 15-min TTL can reconnect), one retry when a send beats its
room's rejoin, per-profile replay cursors (a stale cursor used to survive
Clear-all-data and start the next identity mid-history). Also moved the
Discovery lobby onto the same transport — it was still on BitTorrent trackers;
nearby peers now appear in ~1s instead of ~25s, and `hello` is ephemeral so no
replayed "I am nearby" can lie. **Backend now has its first 4 tests**
(`spotme/backend/test/rooms.gateway.e2e-spec.ts`), the first of which fails if
payload framing ever regresses to binary. `npx jest` in spotme/backend.
Additionally verified live: reaction, edit (with the "edited" label on the
receiver), delete-for-everyone, peer-to-peer history backfill, nearby discovery.

**UNPROVEN / open:** calls over the new signalling path (machinery written,
never dialed — needs fake media devices to test headless); **video** media
specifically (photos are verified both live and offline); groups/bluetooth
screens on server transport; multi-tab same-profile; knock payloads are
server-readable (Phase 2: seal to recipient publicKey — field already in
schema); RoomEvent retention/TTL job not written (disappearing messages are
still client-enforced only); translate/voice/push bridges return 400 locally
until their vendor env keys are set in backend/.env (client degrades
gracefully). One global lobby room is Phase-1 only — presence needs geo-
sharding before it scales.

**Deploy decision (deliberate):** spotme-messenger.vercel.app is still 404 and
was NOT redeployed — the new build needs a hosted backend first (Railway/Fly +
Neon per backend/README.md, then set VITE_SPOTME_SERVER at build). Deploying
the new web build to Vercel without that would ship a dead transport.

---

## 1. The one constraint that shapes every decision

**ybot runs Python 3.14. Every ML stack runs Python 3.11** — torch publishes no
3.14 wheels. They cannot share a process. Anything touching torch/whisper/
OmniParser must run in a 3.11 venv and talk to ybot over a socket.

| Interpreter | Path | Holds |
|---|---|---|
| ybot | `py -3.14` (system) | pyautogui, pywinauto, pynput, mss, watchdog, GitPython |
| vision | `~/.venvs/vision` | OmniParser, SAM 2, EasyOCR, OpenCV, **torch 2.13.0+cu126** |
| voice | `~/.venvs/voice` | whisper, piper-tts, kokoro, coqui-tts, sounddevice, webrtcvad |
| threed | `~/.venvs/threed` | cadquery, build123d, trimesh, open3d, usd-core, MaterialX, warp |
| others | `~/.venvs/` | metagpt, sweagent, langchain, crewai, mem0, browser-use, autogen |

---

## 2. ybot — CORRECTED 2026-07-31 night. The old text here was WRONG.

**What this section used to say, and why it must not be acted on:** *"ybot today
is 2057 lines that screenshot, ask a model, and click a guessed coordinate. It
never checks the click worked."* Read the code before believing that. ybot is
**4,288 lines across 30 files**; `agent.py` is 451. The
PERCEIVE → GROUND → ACT → VERIFY → RECOVER loop this section named as the TARGET
was already built — through the Windows accessibility tree, not OmniParser:

| Stage | Where it already lives |
|---|---|
| PERCEIVE | `ui_inspect` → numbered elements, ~336 tokens vs ~1,230 for a screenshot |
| GROUND | `ui_click(ref)` — "no coordinates involved", per the system prompt |
| ACT | `actions.execute` behind `guard.evaluate` + the kill switch |
| VERIFY | `_after()` → `screen.wait_change()` → "Screen unchanged after {what}" |
| RECOVER | that message says "Do not simply repeat it; call ui_inspect" |

Building the old §2 as written would have rebuilt working code. **Anyone who
plans ybot work from a brief instead of from the source will do it again.**

### What was actually missing, and what shipped tonight

`wait_change` hashes the frame, so it answered "did ANY pixel change" — not "did
the EXPECTED change happen". A click opening the WRONG menu, a mistyped
filename, an error dialog: all move pixels, all logged `✓`. A blinking cursor
moves pixels too.

Shipped: **`ybot/verify.py`** — a step declares `expect`, checked against the
accessibility tree. Four kinds: `appears:<text>`, `disappears:<text>`,
`title:<text>`, `changed` (the old weak default, still there and still the
fallback). Wired into `ui_click` and into every `batch_actions` step.

Three decisions worth keeping:
- **A malformed expectation is REFUSED, never downgraded to `changed`.** Silently
  falling back would reintroduce the weak check invisibly, on a typo.
- **An expectation that was ALREADY true before the step still passes but is
  flagged `proved_nothing`** and marked `⚠` in the batch log — it is not evidence
  the action did anything.
- **`UIA._enumerate()` was split out of `inspect()`** because verification reads
  the tree too, and a read that reassigned `_elements`/`_wrappers` would
  invalidate every ref the model holds, mid-batch, between the click and the
  check — clicking the wrong element by the right number.

**PROVEN:** `python3 tests/test_verify.py` → 28/28, and it runs anywhere because
`verify.py` imports no pywinauto, mss or ctypes and reads no clock.
**NOT PROVEN:** the `agent.py`/`uia.py` wiring is compile-checked only. ybot is
Windows-only and the cloud container is Linux with no `anthropic`, `mss` or
`pywinauto` installed, so `agent.py` cannot even be imported there. **First run
on the Windows box is the real test.**

### If you still want OmniParser, here is its actual niche

`_ui_inspect` already has the fallback: *"This window exposes no interactive
elements to the accessibility tree (common for canvas, game, or custom-drawn
UIs). Take a screenshot and work from pixels instead."* **That** branch is where
OmniParser earns its keep. Replacing `ui_inspect` with it on ordinary Windows UI
would be strictly worse — slower, inferred rather than exact, and 4 GB of VRAM
for something the tree answers exactly and for free.

Also still true: ybot has **no tests at all** outside `tests/test_verify.py`, and
`langgraph` 1.2.9 is installed as the intended fix for ybot having **no durable
state** (a crash loses everything).

---

## 3. Hard-won traps — do NOT rediscover these

- `uv pip install torch` on Windows silently installs **CPU-only**. Always
  `--index-url https://download.pytorch.org/whl/cu126`.
- **OmniParser v3 weights are broken** (TorchScript; `RecursiveScriptModule has
  no attribute 'fuse'`). Use `weights/icon_detect/model.pt` (v2) **and pin
  `ultralytics==8.3.70`** — 8.4.x cannot load them.
- **Import success proves nothing.** SAM 2 imported fine but shipped no
  checkpoints; trimesh imported fine but decimation needed
  `fast-simplification`; MetaGPT "installed" from PyPI as a v0.1 stub. Always
  run a functional check.
- **PyPI `metagpt` is v0.1**, unrelated to the real project. Install from GitHub.
- **UAC-elevated winget installers always fail** here (`0x800704c7`):
  Tesseract, FreeCAD, MeshLab. Per-user installs work fine.
- **Never install NVIDIA Kaolin** into `vision`/`threed` — it pins older torch
  and would break OmniParser + SAM 2 + Warp. Isolated venv only.
- `pyassimp` is installed but **dead** (missing native lib). Use trimesh.
- **graphify must be scoped to one project.** At fable root it swept
  node_modules: 134,090 nodes / **0 edges**. Scoped to spotme: 1627 / 2823.
- Blender: `len(obj.data.vertices)` reports the **pre-modifier** cage — use the
  depsgraph. `ng.interface.new_socket` is the 4.0+ API (Blender here is 5.2).
- **Redirect big install logs to a file and grep them.** Streaming pip output
  into context was the main driver of this session's $341.

---

## 3b. Git on this machine — already fixed, do not re-debug

`git push` / `git ls-remote` used to **hang forever** (exit 124), while `gh`
worked fine. Cause: the Windows credential helper blocking. Fixed with:

```bash
gh auth setup-git      # points git at gh's token
```

If git ever hangs again, that is the fix. Also: **never read a git exit code
through a pipe** — `git ... | head; echo $?` reports *head's* status, so a
hanging command looks successful. Redirect to a file and check `$?` directly.

Everything is committed and pushed to `origin/master`:
- `e4c8987` handoff docs + CLAUDE.md pointer
- `5035d7f` ybot voice subsystem (10 files, 8/8 self-checks passing)

`ybot/voice_memory/` is gitignored — it holds runtime conversation transcripts
and must not be committed.

## 4. Measured numbers (GTX 1050 Ti, 4 GB VRAM)

| Operation | Measured |
|---|---|
| OmniParser detect (warm, GPU) | **0.17 s, 222 elements** @1920x1080 |
| OmniParser cold start | ~7 s CUDA warmup — keep a long-running process |
| EasyOCR full screen | 4.4 s, 166 regions (25x slower — fallback only) |
| SAM 2 tiny segment | 0.54 s |
| OmniParser + SAM 2 co-resident | **0.75 GB / 4 GB** |

---

## 5. What exists now

**8 agents** (`~/.claude/agents/`): ceo-agent, planner-agent, vision-agent,
desktop-operator, browser-operator, memory-agent, recovery-agent,
optimization-agent. Coding/QA/Security/Research were deliberately NOT built —
~89 existing agents already cover them.

**8 3D skills** (`~/.claude/skills/`): blender-automation,
cad-parametric-modeling, mesh-optimization, usd-gltf-pipeline,
pbr-materials-openpbr, game-ready-3d-assets, physics-simulation-3d,
web3d-development. Every code sample was executed before being written.

**118 skills installed**: google/skills (93), android/skills (20),
compose-kotlin (4), modern-jetpack-compose (1). A Windows Scheduled Task
`AndroidSkillsDailyUpdate` refreshes the official Android set daily at 09:07;
log at `fable/android-skills/.update.log`. Google/community sets do NOT
auto-update.

**ybot voice subsystem** — `fable/ybot/ybot/voice/`, 1059 lines, 9 modules,
every one with a passing `demo()`:
`mic, vad, providers, style, memory, intent, orchestrator, service, bridge`
```bash
~/.venvs/voice/Scripts/python.exe -m ybot.voice.service --demo
```
`bridge.py` is stdlib-only, verified on 3.14 — it must never import
torch/numpy/sounddevice. Service emits newline-JSON on `127.0.0.1:8765`:
`{"type":"transcript|reply|error","text":..,"domain":..,"agent":..}`.
Long-term memory JSONL: `{"ts","role","text","tags"}`.

---

## 6. UNPROVEN / NOT DONE — never claim otherwise

- **Voice has never run with a real microphone.** Whisper needs a model
  download; Piper needs `YBOT_PIPER_VOICE` pointing at a `.onnx` voice.
- ElevenLabs TTS provider raises `NotImplementedError` (marked SCAFFOLD).
- **Orchestrator handlers are unregistered** — every route currently returns
  "No handler registered".
- Voice is **not wired into ybot `main.py`**. `Operator`, `Settings` and
  `main.py` were deliberately untouched; the package is additive/opt-in.
- Florence-2 captioner untested under VRAM pressure.
- The "study 40-70 repos and extract prompts" brief was **never done as a
  literal crawl**. The skills distil installed+verified tooling instead.
- `llama-cpp-python` failed to build (needs MSVC). Ollama covers local serving.
- Not installed by choice: vLLM (no Windows), Milvus/Qdrant/Prometheus/Grafana
  servers (daemons, no agent value), CUA (would replace ybot), Kaolin.

---

## 7. Blocked on the user — will stall work if forgotten

1. **`CEREBRAS_API_KEY` in `fable/.env` is EMPTY** (verified: length 0, API
   returns `Not authenticated`). Free signup at cloud.cerebras.ai, no card.
2. **Rotate the exposed OpenRouter keys** — still live.
3. **getlayers OAuth** — needs an interactive session.
4. MetaGPT `fable/MetaGPT/config/config2.yaml` still has `YOUR_API_KEY`.
5. OpenHands v1.6.1 at `:8000` is showing its onboarding wizard — needs an
   agent + LLM key chosen.
6. Tesseract / FreeCAD / MeshLab need installing from an **elevated** terminal.

---

## 8. Working style the user expects

- **Verify by running, not by exit code.** They said "registered isn't the same
  as working" and were right every time.
- **Say what failed.** Partial success reported as success is the thing to avoid.
- **Flag cost.** This session hit $341; they want to choose that spend.
- Terse prompts, wants end-to-end delivery, will course-correct directly.

See also memory note `ai-os-stack-2026-07-29` and `SESSION-2026-07-29.md`
in this folder for the full chronological log.
