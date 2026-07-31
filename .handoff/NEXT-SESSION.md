# START HERE — pickup brief

## 00000. LATEST (2026-07-31 night) — SUPERSEDES EVERYTHING BELOW

**PR #1 IS MERGED AND DEPLOYED. Production has a live, reproduced, diagnosed
messaging bug. The fix that stops it spreading is written and pushed but NOT
deployed.**

```
master                       67bacf7   PR #1 merged (merge commit, not squash)
feature/centrifugo-transport 8ec62db   PR #2 OPEN (not draft), 14 commits
Vercel                       index-BmBst34F.js, verified serving the V-19 fix
Railway                      master, /api/v2/auth/keys live (404 -> 401 proved it)
```

### THE PRODUCTION BUG — read this before anything else

Two real handsets, @ajith11 (`3800d1531e8fcc87`) and @vijay22
(`15868af06346fd9f`). Symptom: sender sees **"✓ Sent"**, recipient gets a
**push notification**, and the message **never appears in the chat** — in BOTH
directions.

**Root cause: @vijay22's device cannot persist its X25519 identity, so it
generates and republishes a new one on every launch.** Measured: its published
key changed THREE times in one session (`5Q9M2sAu…` → `3yScLgOv…` →
`kVK/fsEr…`) while @ajith11's never moved. Each republish staleifies the
`convo.peerKey` every peer stored; both sides then derive different room keys,
and every frame is dropped undecryptable — permanently, because
`roomKeyForConvo` prefers the stored `peerKey` and only fetches when absent.

Why each symptom lied:
- **"Sent"** is `chat.js:1887`'s DEFAULT label (`read ? 'Read' : 'Sent'`).
  Nothing sets `failed` for text — only `deliverAttachment` does, for
  attachments. A text message that never left still reads "Sent".
- **The notification** is the SERVER's `pushForEvent`. It involves no
  decryption at all, which is exactly why it arrived when the message did not.
- **The empty chat** is `socket-transport.js:452`: an unopenable frame is
  dropped with only a `console.warn`.

The trigger is `identity-store.js`, which wrote the key as `.catch(() => {})`
under the comment *"Chatting beats failing."* True while a v1 room could fall
back to the password; false the moment ADR-001 made this identity the ONLY
source of a v2 room key. Safari is the usual reason — storing a non-extractable
CryptoKey in IndexedDB has long failed there, and it fails by REJECTING the
request, not by throwing anywhere visible.

### What is already fixed (pushed, NOT deployed)

- `8ec62db` — the identity write is verified by reading it back; `persisted` is
  reported honestly; **`publishIdentity` refuses to overwrite a good published
  key with an ephemeral one**, so one broken device stops taking down every
  chat it is in. Does NOT repair already-poisoned conversations and does NOT
  make Safari store the key.
- `c68c5f2` — `net.js`'s `msgSafe` no longer swallows outbound failures
  (`catch(() => {})`); it logs per channel and calls `handlers.onSendError`.

### THE NEXT THREE TASKS, in order

1. **Cherry-pick `8ec62db` + `c68c5f2` onto `master` and deploy.** Vercel
   BEFORE Railway. Until then the handsets see none of it.
2. **Self-healing re-fetch.** When `dispatch` cannot open a frame, evict the
   cached room key, re-fetch the peer's CURRENT public key, re-derive, retry
   once. Today a single stale key is permanent. Touch points:
   `socket-transport.js` `dispatch()` catch at :449, `roomKey()`'s cache, and
   `roomKeyForConvo` in `crypto/identity-store.js:147` (it prefers the stored
   `convo.peerKey` and only fetches when absent — that is what makes it stick).
3. **Why does the IndexedDB write fail on that iPhone?** Needs Safari devtools
   over a cable from a Mac. Do NOT guess — the `persisted` flag from `8ec62db`
   now surfaces it in the console, so look there first.

### Also found, unfixed, lower priority

- **A v2 room renders the v1 banner.** A convo confirmed as
  `e2eVersion: 'e2e_v2'` displayed *"Older chat — its key came from both
  account IDs, so the server could read it."* That is a lie about that room's
  security, in the UI.
- **`Start` on onboarding does nothing** if the inputs are filled
  programmatically without dispatching `input`/`change` — the button is not
  disabled, the app simply never sees the values. Real users type, so this is
  mostly a test-automation trap, but it cost time here.
- `smoketest_desk` (`ed112d1b973ba7b860f471f01e3acc8d`) and `probedesk9`
  (`731ffdf1a5e30958`) are **test users left in PRODUCTION** — they could not
  be deleted from here (prod Postgres is `postgres.railway.internal`,
  unreachable from this machine). Remove via the admin dashboard.

### PR #2 — open, and what it still says is unproven

14 commits. Item 2 (S3 adapter) is CLOSED — `S3StorageAdapter` moved its first
real byte against live Cloudflare R2, 13/13, including a non-member 403, a
view-once 403 and a burned-object 404. Still open:

1. **No physical-handset run of the MEDIA path.** The DM path has now been run,
   and it found the bug above.
2. **Half of item 3**: the send-retry ceiling is proven at 2 attempts per call
   (`test/send-retry.test.js`), so 8 attempts is NOT a loop — but why four
   invocations occurred for one `sendAttachment` is still unexplained.

### R2 is live and configured

Bucket **`spotme`** (not `spotme-media`). Credentials are in
`spotme/backend/.env`, gitignored, with `STORAGE_PROVIDER=local` deliberately —
Railway has NO storage config and must not get one until PR #2 ships, because
the default `local` on Railway means the container's ephemeral filesystem.

**ROTATE THE R2 SECRET ACCESS KEY** — it was pasted into the 2026-07-31
transcript, which is on disk. Same for the `cfat_…` Cloudflare API token, which
is account-scoped and was only ever needed for listing buckets.

### Traps learned this session — do not rediscover

- **`railway up` uploads the WORKING DIRECTORY.** Deploying while on a feature
  branch ships that branch. `git checkout master` first and verify the tree
  (`ls src/storage` should be empty for a PR #1-only deploy).
- **A presigned S3/R2 URL is signed for PUT.** The client sent POST and every
  local and mocked test passed, because the local adapter's route was
  `@Post()`. Only a real bucket catches this.
- **Express 4 here, not 5.** `@Get('x/*name')` registers, logs as `Mapped`, and
  matches NOTHING. Use `:param` with `encodeURIComponent`.
- **`emitWithAck` counts are attempts, not sends.** One `sendAction` can emit
  twice (one rejoin retry). Server-side stayed correct throughout.
- **Production Postgres is unreachable from this machine**
  (`postgres.railway.internal`). Observe production through the API instead —
  `GET /api/v2/auth/keys/:userId` is the best probe for key agreement.
- **Two-origin harness**: `.claude/launch.json` has `spotme-web-harness` (port
  5199, `--mode harness`, `--host`) pointing at `:4100` via the gitignored
  `spotme/web/.env.harness`. `.claude/` is gitignored, so BOTH must be
  recreated in a fresh clone. `npm --prefix X exec` ignores the prefix for cwd
  — use `run dev`, or vite serves the repo root and 404s.

### Blocked on the user

1. Cherry-pick + deploy the two fixes — production is broken until then.
2. Safari devtools on the iPhone, for task 3.
3. Rotate the R2 secret and the Cloudflare token.
4. Delete the two test users from production.

---

## 0000. EARLIER (2026-07-31 evening) — superseded by the section above

**Session cost ~$1,160. Two branches pushed, one PR open, nothing merged.**
`master` is untouched at `a453b9e` — deliberately, because merging triggers the
Vercel production deploy.

```
master                       a453b9e   (= origin, no Phase 1/2 work)
fix/v19-e2ee-key-agreement   e8ee362   PR #1, OPEN
feature/centrifugo-transport a57d2f5   stacked on the above, no PR yet
```

**PR #1 must merge first**, or the Phase 2 branch's diff reads wrong.
https://github.com/spotmemessenger-glitch/fable/pull/1

### Phase 1 — V-19 fixed AND wired (`fix/v19-e2ee-key-agreement`)

DM keys were `cyrb53(sortedUserIds)` — a non-cryptographic hash of two columns
the server already stores, so **the server could recompute every DM key**. New
rooms now agree a key: non-exportable X25519 identity per device → ECDH →
HKDF-SHA256, bound to roomId + both public keys. `e2e_v1` rooms keep their
history and are labelled legacy; a room is marked v2 **only if agreement
actually produced a key**.

**THE LESSON OF THIS SESSION.** The first cut had correct crypto that was
**never called**. A 145-agent adversarial review found it. My "verified
end-to-end" claim was false because I had tested the modules DIRECTLY and never
the app's wiring — two green halves each faking the half they did not own. Fixed:
`publishIdentity` now runs at `boot()`; `rooms.js` registers a **key provider**
so a v2 room has NO password path (it re-agrees or does not open); both sides
store `peerKey` = the OTHER side's key; `reach()` writes the convo before
returning; the knock relay passes `e2eVersion`/`senderKey` through.

**Pre-existing bug found on the way:** `isToken` in `api/knock.js` demanded pure
hex, but reach.js builds `dm-<hash>`. The relay had been **400ing every direct
-message knock**, silently (`relayStore` uses `safe()`). The durable offline
path for DMs has NEVER worked in production. Verify that on Railway after merge.

Verified by running: 16 web suites / 263 checks, backend 34/34, migration applied
and the column confirmed in Postgres, endpoints live (incl. a refused key
hijack), and **in a browser the app itself published its X25519 key at boot** and
re-derived a room key from the stored record after reload.

### Phase 2 — the SEAM, not the migration (`feature/centrifugo-transport`)

`ITransportAdapter` + `SocketIOAdapter` + `CentrifugoAdapter` in
`web/src/lib/transport/`, selected by `localStorage['spotme.transport']`.
ADR-002 written. 22 transport tests. Backend `/api/v2/realtime/token` works.

**`FORBIDDEN_KEY_SURFACE` is the important part:** the tests FAIL if any adapter
grows `roomKey`/`deriveKey`/`password`/`encrypt`. A transport rewrite is the
most likely way to silently undo Phase 1.

### NOT DONE — do not claim otherwise

1. **The app does not use the transport layer.** Zero app-code imports of
   `transport/`; `rooms.js` still calls `socket-transport.js` directly. This is
   the same shape as the Phase 1 defect — named here so it is not rediscovered.
2. **`POST /api/v2/realtime/centrifugo/publish` returns 501 on purpose.**
   `policy()`/`refuse()` are PRIVATE on `RoomsGateway` (`:110`, `:333`).
   Duplicating them would create a second authorisation path that drifts.
   **Prerequisite: extract them into `RoomsService`.** That is the next task.
3. **No two-device run, ever.** Everything was one browser + local backend.
4. `centrifuge` is NOT installed; Centrifugo is NOT deployed; server version NOT
   pinned (the clone is `--depth 1`, no tags).
5. **No lint/typecheck exists in `web`** — no eslint config, no script.
6. Performance targets (reconnect <2s, presence <500ms, zero dropped post-ack)
   are TARGETS, never measured.
7. The knock-relay round-trip test uses a **local Upstash-REST mock**; the real
   credentials live only on Vercel and were deliberately not borrowed.

### Traps learned this session — do not rediscover

- **`nest build` wipes `dist/` and emits nothing** when a stale
  `tsconfig.build.tsbuildinfo` survives. Delete it before every backend build.
  Symptom: `Cannot find module dist/main`.
- **Piping a long-running server through `Select-Object` kills it** — the closed
  pipe terminates node. Redirect to a file instead.
- **`git show <ref>:<path> | Set-Content` corrupts the file.** A "regression
  proof" done that way failed with `handler is not a function`, which proves
  nothing. Redirect via bash.
- **A test must be run against the PRE-FIX code before it is trusted.** The
  relay test only earned its keep when 9 of 12 checks failed against the old
  `knock.js` on real assertions.
- `gh auth status` hangs on this box (credential helper). Use the GitHub MCP.
- **~10 files of shell debris** (0-byte, named `{`, `c!`, `X`) get created by
  malformed PowerShell. Check `git status` before committing.

### Reference corpus cloned this session (~8 GB, all gitignored)

`whatsapp-oss/` (28) · `Telegram/` + `telegram-oss/` (20) · `msg-stack/` (17) ·
`geo-stack/` (9) · `ui-stack/` (16) · `scale-stack/` (11) · `messenger-refs/` (8)

**Licence traps:** Telegram clients are GPL-2.0/AGPL and `tgcalls` is GPL-3.0 —
read, never copy. `redpanda` (BSL) and `sentry` (FSL) are **source-available,
NOT open source**. `react-leaflet` is **Hippocratic-2.1, not OSI-approved**. The
permissive picks are TDLib, LiveKit, h3, MapLibre, and both sticker repos.

### Blocked on the user

1. Merge PR #1 (triggers the Vercel production deploy — Vercel BEFORE Railway).
2. Then verify on Railway that offline DM delivery works for the first time.
3. Decide whether Phase 3 starts before or after the `policy()`/`refuse()`
   extraction.

---


**Written:** 2026-07-29, end of session (~$341 spent).
**Updated:** 2026-07-30 late evening. Everything below was verified by RUNNING
it, not by exit codes.

---

## 00000000. LATEST (2026-07-31, late) — SUPERSEDES EVERYTHING BELOW

**Nothing is merged. Two PRs are open and both are green.**

```
master   bc4fd92   unchanged this session
PR #6    claude/next-session-b6ypc5   377372a   DRAFT, CI green, 8 commits
PR #2    feature/centrifugo-transport ad31fd2   OPEN, mergeable_state clean
```

### THE HEADLINE: the "notification but no message" bug is FOUND AND FIXED

It was never crypto. The opening line of a chat travels INSIDE the knock, and
both sides wrote it to the convo's `last` preview and fired `pushNote` with it —
and **never added it to the message store**. The notification quoted the text,
the inbox row quoted the text, the thread was empty. `inbox.js` states the
intent outright ("what both sides see as the first message once the chat
opens"), so this was a gap, not a decision. Fixed by `rooms.injectLocal` +
`msgId` in the knock payload (`8848bd5`).

**Found only by driving the real app in a real browser.** Every module test
passed against it, because no module was wrong.

### SEVEN defects fixed, then FIVE MORE found in those fixes

`377372a` is the important commit — it fixed five bugs introduced by the seven
before it, and two of those meant a shipped feature was inert:

- `emit({ type: 'undecryptable', ...info })` — `info` carries the FRAME's type,
  spread wins, event arrived as `{type:'msg'}`. **The room-broken banner was
  dead code.** `room-broken-alert.test.js` passed because it stops at the
  transport boundary and never crosses `rooms.js`.
- `deletedAt` is stamped by BOTH `softDeleteAccount` AND `releaseUsername` (which
  renames the row and deliberately keeps the user alive). The new auth gates read
  both as deletion = **permanent lockout of a live user**. `isDeletedAccount`
  now distinguishes them and fails safe.
- The replay-cursor hold could stick FOREVER on rooms with no key provider (v1,
  group, inbox) — a pinned inbox eventually stops delivering chat requests.
- `unopenedFloor = null` sat above `await currentKey()`, and `join` retries every
  2s on exactly that throw — burning one held frame per cycle.
- A dropped network request told users to delete their chat on both phones.

**Every one lived in a seam between two correct pieces.** That is this
codebase's dominant failure mode — same shape as the original bug.

### The other big one: messages were being DESTROYED

`dispatch`'s `finally` advanced the replay cursor whether or not the frame
opened, and the server replays strictly `id > since`. One undecryptable frame
burned its own place in the window, permanently, on both devices. **That is why
repairing a key never brought a chat back — there was nothing left to bring
back.** Fixed in `0ea0db5`. Messages lost before that fix are still lost.

### PROVEN by running, not by reading

Local Postgres + the real NestJS backend + two shipping web clients in separate
processes, and separately two Chromium contexts against the real UI:

| Scenario | Result |
|---|---|
| Server, protocol, crypto, key agreement | **all sound** — ruled out by measurement |
| Normal delivery / origin split / stale peer key | works / self-heals / self-heals |
| **Own published key overwritten by another origin** | **reproduced, unrecoverable** |
| Browser E2E (onboard → search → knock → both ways → reload) | **10/11** |

`refreshRoomKey` re-agrees the PEER's key, so it cannot help a device whose OWN
key was overwritten. **Not fixed — it is a product call.** Republish-on-mismatch
is the tempting fix and it is a trap: two live origins would fight, each
overwriting the other every launch.

### Harnesses that now exist — use them, do not rebuild them

- `spotme/web/test/e2e/browser-e2e.mjs` — real Chromium ×2 against the real UI.
  Needs backend on :4000 and vite on :5173. NOT in `npm test`.
- Postgres 16 binaries are installed in the cloud container even though the
  docker daemon is not running:
  `su postgres -c "/usr/lib/postgresql/16/bin/initdb -D <dir> -U postgres --auth=trust"`
  then `pg_ctl -o '-p 5433 -k /tmp'`. PGDATA must be somewhere the postgres user
  can write — /var/lib/postgresql, NOT the root-owned scratchpad.
- Chromium is at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`; the
  `playwright` npm package is not installed, install it with
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`.
- To run the shipping web modules under Node, `mock.module` `lib/api.js` — its
  `API_BASE` is inlined from `import.meta.env` at BUILD time and is '' in Node.

### MERGE RECIPE for #6 → then #2 (SIMULATED AND PROVEN, do not re-derive)

The whole sequence was run on throwaway local branches before anything was
merged. Result: **web 27 suites / 26 fully green, backend 10 suites / 86 tests,
both builds clean.** The simulation is gone with that container, but every
decision it made is below.

**The overlap is NINE files, not the four usually quoted.** `chat.js` is NOT one
of them:

```
.handoff/NEXT-SESSION.md   spotme/web/package.json
spotme/web/src/lib/reach.js   src/lib/rooms.js   src/lib/socket-transport.js
spotme/web/src/net.js
spotme/web/test/{media,requests,viewonce}.test.js
```

**Conflicts and how each was resolved:**

1. `package.json` — recurs on nearly every replayed commit. Both branches append
   suites to one `&&` chain. Resolve as a UNION, never by taking a side, or the
   dropped side's tests silently stop running. 26 suites is the correct total.
2. `rooms.js` import — PR #2 adds a rationale comment above the import; PR #6
   extends the import list with `clearRoomKey`/`clearRoomCursor` and adds a
   `media-transfer.js` import. Keep the comment, the extended list, and the
   extra import. **Watch for a duplicated `import { setRoomKeyProvider,
   freshTokens }` line** — that was caught only by `node --check`.
3. `socket-transport.js` — both sides add a new export inside a SHARED `/**`
   block, with the closing `}` also shared. Ours (`clearRoomCursor`) needs its
   own `}` and a fresh `/**` before theirs (`sealForRoom`/`openForRoom`).
4. `media/requests/viewonce.test.js` — purely additive stub entries, union them.
5. `.handoff/NEXT-SESSION.md` — take OURS. Master+#6 is strictly newer and
   already carries the superseding section.

**THE TRAP THAT ONLY EXISTS WHEN BOTH LAND.** A partial ESM `mock.module` is a
LINK-time SyntaxError. Two new test files each stub `socket-transport.js`
without knowing about the other branch's exports, and the combined suite dies at
12 of 27 suites:

- `send-failure-visible.test.js` (new in #6) needs `sealForRoom`/`openForRoom`
  — **already added on this branch**, since an extra stub name is harmless
  (verified) while a missing one is fatal.
- `transport-seam.test.js` (new in #2) needs `clearRoomCursor` — **still to do,
  during the merge.** It is the one remaining known break.

**Verify with `node --check` on every file you touch by hand.** It caught a real
mistake here that the eye did not.


### Blocked on the user

1. **Merge order matters.** #6 and #2 both touch `socket-transport.js`,
   `rooms.js`, `net.js`, `chat.js`. Whichever merges first, **the other needs
   rebasing again**. #2 was rebased this session; merging #6 undoes that.
2. **Two product decisions.** Should `guestAuth` refuse deleted accounts (a user
   who deletes their account then cannot return by reopening the app)? And what
   to do about an account open on two origins?
3. **Merging #6 needs a Railway deploy too** — `cd spotme/backend && npm run
   deploy`. Additive and admin-guarded, so no Vercel-first hazard.
4. Rotate the R2 secret and the `cfat_…` Cloudflare token. **Still not done.**
5. Delete `probedesk9` / `smoketest_desk`. `DELETE /api/admin/users/:id` now
   exists (admin-only, needs a STAFF login, not a user token). The API is on
   **Railway**, not Vercel.
6. **Safari DevTools may no longer be needed.** The device banner was dead code
   until `377372a`; once #6 ships, @vijay22's phone should say so on its own
   screen.

### Traps found this session

- **A cloud session still cannot reach `*.vercel.app` / `*.railway.app`** (403 at
  the proxy). But it CAN run the whole stack locally — see harnesses above.
- **`try { return f() } finally {}` runs the finally AT the return**, not when
  the returned promise settles. That silently broke the first cut of the cursor
  fix.
- **A partial ESM `mock.module` is a link-time SyntaxError.** Adding an export to
  `socket-transport.js` breaks four test files until their stubs list it.
- `test/viewonce.test.js` is still 17/21 on Linux — verified pre-existing at
  `origin/master` in the same container. Untouched, still undiagnosed.

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

## 2. THE NEXT TASK (agreed with the user)

**Bolt OmniParser + a verify-after-every-action loop onto ybot. Not a rewrite.**

Why this and nothing else: ybot today is 2057 lines that screenshot, ask a
model, and click a guessed coordinate. It never checks the click worked. The
single biggest cause of "autonomous agent failed" is a missing verification
step, not a wrong decision.

Target loop:
```
PERCEIVE (OmniParser -> numbered elements)
  -> GROUND (pick element id, never a bare coordinate)
  -> ACT
  -> VERIFY (re-capture; did the expected change happen?)
  -> RECOVER (retry with a DIFFERENT strategy, then escalate)
```

Read `ybot/ybot/agent.py` (420 lines) and `screen.py` / `uia.py` **before**
editing — target the real code paths, not assumed ones.

After that: `langgraph` 1.2.9 is installed and is the intended fix for ybot
having **no durable state** (a crash currently loses everything).

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
