# Spot Me — Tech Stack

**Rewritten 2026-08-01, against `master` `0316275`** (PR #7 merged). Every entry
below was re-read from the manifests, the Prisma schema and the source on that
commit — not from recollection, and not from the previous version of this file,
which had gone internally inconsistent: §6 still called V-19 an open issue while
§11 already recorded it as fixed. A reader could take either. Where a dependency
is declared but never imported, this says so rather than implying it runs.

---

## 1. What is actually live

| Tier | Technology | Host |
|---|---|---|
| Web app | Vanilla JS + Vite 8 | **Vercel** — `spotme-messenger.vercel.app` |
| API + realtime gateway | NestJS 10 | **Railway** — `api-production-0a4ca.up.railway.app` |
| Database | PostgreSQL + Prisma 5 | Railway Postgres |
| Android shell | Capacitor 8 | sideload; not published |
| iOS | — | **does not exist**; no Xcode project generated |

The app talks to **Railway**. `API_BASE = VITE_SPOTME_SERVER` is baked into the
bundle at build time, with a hosted fallback added in #7 so an unset variable no
longer ships a build that loads and never connects. The `/api/*` serverless
functions that also exist on Vercel are vestigial — their vendor keys were
removed 2026-07-31 — but the same files are staged into the Railway image by
`npm run deploy`, which is what actually serves them.

---

## 2. Frontend — `spotme/web`

**There is no UI framework.** No React, no Vue, no Svelte. Views are hand-written
ES modules under `src/views/` that build DOM through a small `el()` helper and
route on the URL hash. There is no TypeScript, no ESLint config and no typecheck
script anywhere in `web/` — the only automated gate is the test suite.

| Purpose | Package | Version |
|---|---|---|
| Build tool | `vite` | ^8.1.5 |
| Realtime transport | `socket.io-client` | ^4.8.3 |
| Legacy P2P transport | `trystero`, `@trystero-p2p/torrent` | ^0.25.3 — still imported in 2 files |
| Room/identity core | `spotme-core` | local — `file:vendor/spotme-core` |
| Native push | `@capacitor/push-notifications` | ^8.1.2 |
| Android wrapper | `@capacitor/android`, `/core`, `/cli` | ^8.4.2 |
| Build-time images | `sharp` | ^0.35.3 |

**The transport is swappable.** `socket-transport.js` is a drop-in for the
Trystero API; `localStorage['spotme.transport']='p2p'` reverts to the original
peer-to-peer stack.

**`vendor/spotme-core` must never be gitignored.** It is a build-time copy of
`spotme/core`, made by `prebuild`, because Vercel only uploads the root
directory. It was once `"file:.."` — outside that directory — which 404'd the
site for days.

### Test tooling

Node's built-in runner — **no Jest, no Vitest**. 24 suites chained in
`package.json`'s `test` script, several needing
`--experimental-test-module-mocks`. A real-browser E2E harness lives at
`test/e2e/` (Playwright, two isolated Chromium contexts); it is **not** in
`npm test` and needs a backend on :4000 and Vite on :5173.

`test/viewonce.test.js` reports **17/21 on Linux** and has done since before any
recent work — verified pre-existing at four separate commits. Undiagnosed; it is
not a regression and should not be reported as one.

---

## 3. Backend — `spotme/backend`

NestJS 10, TypeScript, `tsc --noEmit` clean. Global route prefix is `api`, so
every controller path is served under `/api/...`.

**14 modules:** `admin` · `audit` · `auth` · `chat` · `chat-requests` ·
`common` · `groups` · `middleware` · `moderation` · `prisma` · `push` · `rooms` ·
`stories` · `users`

**14 controllers**, mounted at: `admin` · `admin/reports` · `auth` · `chat` ·
`chat-requests` · `groups` · `ingest` · `moderation` · `push` · `stories` ·
`username` · `users` · `users/me` · `v2/auth/keys`

| Purpose | Package | Version |
|---|---|---|
| Framework | `@nestjs/*` | ^10.4.6 |
| WebSockets | `@nestjs/websockets`, `socket.io` | ^10.4.6 / ^4.8.1 |
| Auth | `@nestjs/jwt`, `passport-jwt` | HS256 |
| Password hashing | `argon2` | ^0.41.1 — **in use**, employees only |
| ORM | `@prisma/client` | ^5.22.0 |
| Validation | `class-validator`, `class-transformer` | ^0.14.1 / ^0.5.1 |
| FCM (+ the iOS `apns` block) | `firebase-admin` | ^14.2.0 |
| Web Push | `web-push` | ^3.6.7 |
| Tests | `jest`, `ts-jest` | ^29.x |

### Declared but NEVER imported

Re-verified 2026-08-01 by grepping `backend/src` and `web/src` — **zero import
sites each**:

`bullmq` · `ioredis` · `prom-client` · `cuid` · `@parse/node-apn`

So there is **no job queue, no Redis, no metrics endpoint, and no direct APNs
path** — iOS push would ride `firebase-admin`'s `apns` block. Do not describe
Spot Me as having a queue, a cache or Prometheus metrics. They are manifest
entries only.

---

## 4. Database — PostgreSQL via Prisma

`provider = "postgresql"`, client `prisma-client-js`. **26 models, 8 enums.**

The models that matter to the live web app:

| Model | Holds |
|---|---|
| `User` | identity, `username`, `claimSecretHash`, `publicKey` (X25519), `deletedAt` |
| `RoomEvent` | the append-only ciphertext log — messages, reactions, edits, receipts |
| `RoomMember` | who is in which room, learned from joins; drives push fan-out |
| `ViewOnce` | burn state for private photos, checked before the envelope |
| `DeviceToken` / `PushSubscription` | the two push rails |
| `RefreshToken`, `Device`, `InstallEvent` | sessions and install telemetry |
| `Group`, `GroupMember` | roles, bans, mutes, visibility |
| `Employee`, `AuditLog`, `HealthSample`, `CrashReport` | staff dashboard |

`Conversation` / `Message` / `ConversationParticipant` belong to the **mobile
track**, not the web app — web rooms are `roomId` keys into `RoomEvent`.

`RoomEvent` stores **AES-GCM ciphertext only**; clients replay from a per-room
cursor. Payloads cross the wire as **base64 text, never Buffers** — socket.io
frames each Buffer separately after the JSON packet, and any interleaving drops
the socket with `parse error`.

**There is still no object storage.** Media rides `RoomEvent` payloads in
acknowledged slices. An S3/R2 storage seam exists on PR #2 and is unmerged.

---

## 5. Notifications — three independent rails

1. **FCM** (`firebase-admin`, project `spot-messenger-48a74`) — the only thing
   that wakes a closed Android app. Sent with both a `notification` and a `data`
   block at high priority; `data.tag` carries the roomId so a tap can route.
2. **Web Push** (`web-push`, VAPID) — browsers and installed PWAs.
   `public/sw.js` handles `push` and `notificationclick`.
3. **In-app** (`lib/notify.js`) — chime, haptic, and a system notification only
   when the document is hidden.

The server pushes only when a recipient is **not connected**, only for `msg` and
`knock`, never to the sender, and with **no message text** — payloads pass
through Apple and Google, which is exactly what the encryption exists to
withhold.

**Web Push can never work inside the packaged Android app** — Capacitor's WebView
exposes neither `PushManager` nor `Notification` (verified on-device). Native
builds must use FCM.

**Known broken on master, fixed in PR #9:** the web client sends only the
subscription `endpoint` while the server requires `keys.p256dh` / `keys.auth`, so
every browser registration is rejected — production has never held a single
web-push subscription. Nothing consumes `pushNotificationReceived` or
`pushNotificationActionPerformed` either, so a foreground push displays nothing
and a tray tap does not open the chat.

**Unproven:** no real handset has ever received a push. The chain is verified on
an Android emulator only.

---

## 6. Encryption

Browser **WebCrypto**. No crypto library on the web client.

| Primitive | Use |
|---|---|
| **X25519 ECDH → HKDF-SHA256** | `e2e_v2` DM room keys (ADR-001) |
| **AES-GCM 256** | every message and media payload |
| **PBKDF2 / SHA-256** | `e2e_v1` rooms only, salt `spotme-room-v1:${roomId}` |
| `crypto.getRandomValues` | IVs, room ids, room secrets |

### V-19 is FIXED for new rooms — the previous version of this file said otherwise

Every conversation carries an explicit `e2eVersion`:

- **`e2e_v2`** — the device generates a **non-extractable** X25519 identity kept
  in IndexedDB (localStorage cannot hold a `CryptoKey`, and an extractable key
  would mean any XSS walks off with it permanently). The public half goes to
  `User.publicKey`; the room key is ECDH + HKDF bound to the roomId and both
  public keys. **The server does not hold the inputs to derive it.**
- **`e2e_v1`** — the legacy `cyrb53` scheme, which the server *can* recompute.
  Kept because changing the derivation would make that history permanently
  unreadable, and **labelled as legacy in the UI** rather than presented as safe.

Supporting machinery: `identityStatus()` reports `ok` / `ephemeral` /
`unavailable` / `unknown`, so a device that cannot persist its key says so on its
own screen instead of only in a console nobody reads; `publishIdentity` refuses
to overwrite a good published key with an ephemeral one; `refreshRoomKey`
re-agrees a key when a frame fails to open with `OperationError`.

**Not achieved, and must not be claimed:** no forward secrecy (static pairs), and
no key authentication — the server hands out public keys, so it can MITM a *new*
conversation until out-of-band fingerprint comparison exists.

Group keys differ by visibility: a **PRIVATE** group's key rides the invite-URL
fragment and never reaches a server; a **PUBLIC** group hands its key to the
server so anyone can join by `@handle` — the one case where the server can read a
group.

`spotme/mobile` uses **tweetnacl** — different crypto, not interoperable.

---

## 7. Voice and video calls

**WebRTC**, true peer-to-peer, with signalling relayed over the Socket.IO gateway
as an ephemeral `rtc` action. Call media never touches Railway.

**There IS a TURN relay**, and it is easy to miss: `net.js` sets a STUN-only
config as its *initial* value, so grepping for literal `turn:` finds nothing. The
relay arrives at runtime — `readyRTC()` fetches `/api/turn`, which mints
short-lived Cloudflare TURN credentials (6-hour TTL). If `CF_TURN_KEY_ID` /
`CF_TURN_TOKEN` are unset it degrades to STUN only.

**Never dialled end-to-end.**

---

## 8. Language pipeline

Translation and transliteration cross-confirm: **Sarvam** in parallel with
**Azure Translator** / **Google**, an LLM adjudicating disagreements, and Google
Input Tools winning transliteration disputes. `READ_MODEL` is
`claude-haiku-4-5-20251001`. The Azure key works **only** against the resource
endpoint — the global host 401s for every region, so do not "simplify"
`azureBase()`.

---

## 9. Other tracks — built, not the live app

`spotme/mobile` (React Native, tweetnacl) · `spotme/admin-dashboard` ·
`ybot/` (Python desktop automation, unrelated to the messenger).

---

## 10. Deployment

**Vercel is automatic; Railway is manual; the order matters.**

```
# 1. merge to master  → Vercel builds automatically (root directory: spotme/web)
# 2. WAIT for that build to report Ready
# 3. then, and only then:
git checkout master && git pull origin master
cd spotme/backend && npm run deploy
```

**Vercel before Railway** is load-bearing whenever a change adds an auth guard:
a new bundle sends headers an old server ignores, but a new server rejects an old
bundle with 401 on every call. **Never plain `railway up`** — it skips staging
`web/api` (every `/api/*` route then 404s) and it uploads the working directory,
so a stale local tree silently deploys old code. `git pull` before deploying is
part of the procedure, not a nicety.

### Silent-deploy failures that have each cost about a day

- Vercel Root Directory unset → builds the repo root → an empty deployment steals
  the production alias.
- A gitignored staging directory → `railway up` skips it → the previous container
  keeps serving while the deploy reports success.
- `VITE_*` variables live only in `.env.local`; any new one must be added to
  Vercel or it ships as `undefined`.
- `nest build` can exit 0 and emit nothing if a stale `tsconfig.build.tsbuildinfo`
  survives — delete it, and prove a newly added route actually answers.

---

## 11. Known gaps — do not claim otherwise

| Area | Status |
|---|---|
| DM encryption — new chats | **Fixed** (ADR-001): X25519 ECDH + HKDF, device-held keys |
| DM encryption — existing chats | **Still v1** — cyrb53 secret, server-recomputable, cannot migrate without destroying history |
| DM room *authorisation* | **Hole open on master** — any authenticated user can join any DM room and replay its history; fix in PR #10 |
| Web push registration | **Broken on master** — the server rejects every subscribe; fix in PR #9 |
| Push payload handling | **Missing on master** — no foreground display, no tap routing; fix in PR #9 |
| Forward secrecy | **None.** One stolen device key opens that pair's whole v2 history |
| Key authentication | **None.** Server-supplied public keys are MITM-able for a new chat |
| Real-device push | **Never verified** — emulator only |
| Voice/video calls | **Never dialled** end-to-end |
| Rate limiting | **None anywhere** |
| JWT secrets | Both strategies share one secret |
| Account deletion | Leaves tokens and live sockets working |
| Presence scaling | One global lobby room; needs geo-sharding |
| Job queue / Redis / metrics | **Declared, never imported** — see §3 |
| Object storage | **Does not exist** — media rides `RoomEvent` (PR #2 unmerged) |
| iOS | No project generated; requires a Mac |
| RoomEvent retention/TTL | Not written — disappearing messages are client-enforced only |
| View-once in PUBLIC groups | Server holds the key; the composer offers it with no warning |

---

## 12. In flight

| PR | Branch | What |
|---|---|---|
| **#2** | `feature/centrifugo-transport` | transport seam, IndexedDB media, S3/R2 storage seam |
| **#9** | `fix/push-payload-handlers` | push subscription keys, listener race, foreground + tap handlers |
| **#10** | `fix/dm-room-authorisation` | the DM join gate |
| #8 | `claude/next-session-yol4aj` | ybot only — on hold, unrelated to the messenger |
