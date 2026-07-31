# Spot Me — Tech Stack

**Authored 2026-07-31.** Every entry was read from the actual manifests, the
Prisma schema and the source — not from recollection. Where a dependency is
declared but never imported, this document says so rather than implying it runs.

---

## 1. What is actually live

| Tier | Technology | Host |
|---|---|---|
| Web app | Vanilla JS + Vite 8 | **Vercel** — `spotme-messenger.vercel.app` |
| API + realtime gateway | NestJS 10 | **Railway** — `api-production-0a4ca.up.railway.app` |
| Database | PostgreSQL + Prisma 5 | Railway Postgres |

The app talks to **Railway**. `API_BASE = VITE_SPOTME_SERVER` is baked into the
bundle at build time. The `/api/*` serverless functions that also exist on
Vercel are vestigial — their vendor keys were removed 2026-07-31.

---

## 2. Frontend — `spotme/web`

**There is no UI framework.** No React, no Vue, no Svelte. Views are hand-written
ES modules that build DOM through a small `el()` helper and route on the URL
hash. This is deliberate and the bundle is ~348 kB (113 kB gzipped).

| Purpose | Package | Version |
|---|---|---|
| Build tool | `vite` | ^8.1.5 (target `es2020`) |
| Realtime transport | `socket.io-client` | ^4.8.3 |
| Legacy P2P transport | `trystero`, `@trystero-p2p/torrent` | ^0.25.3 |
| Room/identity core | `spotme-core` | local — `file:vendor/spotme-core` |
| Native push | `@capacitor/push-notifications` | ^8.1.2 |
| Android wrapper | `@capacitor/android`, `/core`, `/cli` | ^8.4.2 |
| Build-time images | `sharp` | ^0.35.3 |

**The transport is swappable.** `socket-transport.js` is a drop-in for the
Trystero API; `localStorage['spotme.transport']='p2p'` reverts the app to the
original peer-to-peer stack.

**`vendor/spotme-core` must never be gitignored.** It was once `"file:.."`,
outside the only directory Vercel uploads, which 404'd the site for days.

### Test tooling

No framework. Plain `node test/*.test.js` files with a hand-rolled
`check`/`checkAsync` reporter, some using `--experimental-test-module-mocks`.
**12 suites, 213 checks** at time of writing.

---

## 3. Backend — `spotme/backend`

| Purpose | Package | Version |
|---|---|---|
| Framework | `@nestjs/common`, `/core`, `/platform-express` | ^10.4.6 |
| WebSockets | `@nestjs/websockets`, `/platform-socket.io`, `socket.io` | ^10.4.6 / ^4.8.1 |
| Config | `@nestjs/config` | ^3.3.0 |
| Auth | `@nestjs/jwt`, `@nestjs/passport`, `passport`, `passport-jwt` | HS256 |
| Password hashing | `argon2` | ^0.41.1 — **in use** (`auth.service`, `admin.service`) |
| ORM | `@prisma/client` | ^5.22.0 |
| Validation | `class-validator`, `class-transformer` | ^0.14.1 / ^0.5.1 |
| ID generation | `cuid` | ^3.0.0 |
| Reactive | `rxjs` | ^7.8.1 |
| Language | `typescript` | ^5.6.3 |
| Tests | `jest`, `ts-jest` | ^29.x — 34 backend tests |

Global route prefix is `api` (`app.setGlobalPrefix('api')`), so every controller
path is served under `/api/...`.

### Declared but NEVER imported

Grepped across `backend/src`, `web/src` and `web/api`:

| Package | Imports found | Reality |
|---|---|---|
| `bullmq` ^5.81.3 | **0** | no job queue exists |
| `prom-client` ^15.1.3 | **0** | no metrics endpoint exists |
| `ioredis` ^5.11.1 | 1 stray reference | **no Redis client is constructed anywhere** |

Do not describe Spot Me as having a queue, a cache or Prometheus metrics. It has
none of the three. They are manifest entries only.

---

## 4. Database — PostgreSQL via Prisma

`datasource db { provider = "postgresql" }`, client `prisma-client-js`,
**8 migrations**.

**25 models:**
`User` · `Presence` · `Device` · `InstallEvent` · `OtpCode` · `RefreshToken` ·
`Conversation` · `Group` · `GroupMember` · `Story` · `StoryView` ·
`ConversationParticipant` · `Message` · `ChatRequest` · `Report` · `Block` ·
`Employee` · `AuditLog` · `HealthSample` · `RoomEvent` · `ViewOnce` ·
`PushSubscription` · `DeviceToken` · `RoomMember` · `CrashReport`

**8 enums:**
`Role` · `RequestSource` · `RequestStatus` · `ReportReason` · `ReportStatus` ·
`Sex` · `GroupRole` · `GroupVisibility`

`RoomEvent` is the durable message log. It stores **AES-GCM ciphertext only**;
clients replay from a per-room cursor. Payloads cross the wire as **base64 text,
never Buffers** — socket.io frames each Buffer separately after the JSON packet,
and any interleaving drops the socket with `parse error`.

### There is no object storage

No R2, no S3, no blob bucket. Media travels the encrypted `RoomEvent` path in
slices with acknowledgement.

---

## 5. Notifications — three independent rails

| Rail | Package | Target |
|---|---|---|
| FCM | `firebase-admin` ^14.2.0 | Android — Firebase project `spot-messenger-48a74` |
| APNs | `@parse/node-apn` ^8.1.0 | iOS — `apns-priority: 10`, `content-available`, `thread-id` |
| Web Push | `web-push` ^3.6.7 | Browser / PWA, VAPID |

The server pushes only when a recipient is **not connected**. Only `msg` and
`knock` events, never to the sender, and **no message text in the payload**.

`DeviceToken.platform` accepts `'ios'`; the client reports platform via
`Capacitor.getPlatform()`.

**Web Push can never work inside the packaged Android app** — Capacitor's WebView
exposes neither `PushManager` nor `Notification` (verified on-device). Native
builds must use FCM/APNs.

**Unproven:** no real handset has ever received a push. The chain is verified
end-to-end on an Android emulator only.

---

## 6. Encryption

Browser **WebCrypto**. No crypto library on the web client.

| Primitive | Use |
|---|---|
| **AES-GCM 256** | every message and media payload |
| **PBKDF2 / SHA-256** | key derivation, salt `spotme-room-v1:${roomId}` |
| `crypto.getRandomValues` | IVs, room ids, room secrets |

Group key handling differs by visibility: a **PRIVATE** group's room key never
leaves the device — it rides in the invite-URL fragment, which browsers do not
send to servers. A **PUBLIC** group hands its key to the server so anyone can
join by `@handle`; that is the one case where the server can read a group.

### ⚠ OPEN ISSUE — V-19

DM room keys derive from `stableHash("spotme-dm-secret-v1:" + sorted user ids)`
in `web/src/lib/reach.js`. `stableHash` is **cyrb53 — a non-cryptographic hash**,
its algorithm ships in the public bundle, and its entire input is two ids the
server already stores. That value is the PBKDF2 password, so **the server can
recompute any DM key and decrypt everything.**

The onboarding screen currently says "no server reading your messages." That is
false for DMs today. Fixing the derivation makes every existing conversation
permanently unreadable, so the safe shape is a **versioned** derivation: old
rooms keep the old scheme, new rooms get real entropy. This is a product
decision, not an engineering one.

Note `spotme/mobile` uses **tweetnacl** instead — different crypto from the web
app. The two are not interoperable as written.

---

## 7. Voice and video calls

**WebRTC**, true peer-to-peer, with signalling relayed over the Socket.IO
gateway.

ICE servers are **STUN only**:
`stun:stun.cloudflare.com:3478` and `stun:stun.l.google.com:19302`.

**There is no TURN server.** Calls between peers behind symmetric NAT or
restrictive corporate firewalls will fail to connect, with no relay fallback.

Calls remain **unproven** — the machinery is written but has never been dialled;
testing it headless needs fake media devices.

---

## 8. Language pipeline

Multi-engine with cross-confirmation rather than a single provider.

| Stage | Engines |
|---|---|
| Translation | **Sarvam** in parallel with **Azure Translator** / **Google** |
| Adjudication on disagreement | **Gemini**, **OpenAI**, **Anthropic** |
| Transliteration | **Google Input Tools** wins disputes |
| Voice (STT/TTS/clone) | **ElevenLabs** — `api.elevenlabs.io/v1` |

A healthy response looks like
`{"engine":"sarvam+gemini/openai","confirmed":true}`.

**Never rewrite `api/translate.js` casually** — it is corpus-tuned against real
Tamil/English mixed input. The Azure key works ONLY against the resource
endpoint `ytranslator-yuvraj-2026.cognitiveservices.azure.com`; the global host
`api.cognitive.microsofttranslator.com` returns 401 for every region.

Both `/api/translate` and `/api/voice` sit behind a bearer-token gate
(`web/api/_auth.js`, `gateVendorProxy`) with per-user rate limiting. Deployed and
verified 2026-07-31: an unauthenticated call returns
`401 {"error":"sign in required"}`.

---

## 9. Other tracks — built, but NOT the live app

| Project | Stack | Status |
|---|---|---|
| `spotme/mobile` | Expo + React Native, `expo-router`, `expo-secure-store`, `socket.io-client`, **tweetnacl** | separate track |
| `spotme/app` | Expo + `react-native-bare-kit`, `expo-sqlite`, `b4a`, `spotme-core` | separate track |
| `spotme/admin-dashboard` | React + `react-router-dom` + `recharts` | separate track |

The Android build of the **live web app** is a Capacitor wrapper around
`spotme/web`, signed with a release keystore at `fable/.keys/spotme-release.jks`.
`JAVA_HOME` must point at Android Studio's bundled JBR (JDK 21), not system Java.

iOS has never been built — there is no `spotme/web/ios/` directory, and Windows
cannot produce it.

---

## 10. Deployment

**Order matters: Vercel FIRST, then Railway.** Railway-first stands up a backend
demanding a token in front of every user still on the old bundle, and
`lib/voice.js` throws on a non-OK response, so voice breaks visibly for the gap.

```bash
# 1. Web — Vercel builds on push (Root Directory MUST be spotme/web)
git push origin master

# 2. Backend — never plain `railway up`; predeploy stages web/api into the image
cd spotme/backend && npm run deploy
```

### Verification that does not lie

The bundle lives at `/assets/index-*.js`. A check that greps `index-*.js`
**without** the `/assets/` prefix fetches a 404 page and reports zero matches
forever — that produced 19 consecutive false "not deployed" readings. Verify by
**content**, and prove new behaviour by exercising it: a health check cannot
distinguish a fresh container from the previous one, and Railway has served the
old container for ~4 minutes after reporting success.

### Silent-deploy failures that have each cost about a day

1. `.deploy/` was gitignored and `railway up` skips gitignored paths.
2. The Vercel project had **no Root Directory**, so it built the repo root and an
   empty deployment stole the production alias on every push.
3. `nest build` exited 0 and emitted an **empty `dist/`** because `deleteOutDir`
   met a stale `tsconfig.build.tsbuildinfo`.

All three exited 0.

**Any new `VITE_*` variable must be added to Vercel.** Vite inlines
`import.meta.env.*` at build time; `.env.local` never travels. `VITE_GMAPS_KEY`
was missing for weeks, so every production bundle shipped `maps/api/js?key=`
with nothing after it.

---

## 11. Known gaps — do not claim otherwise

| Area | Status |
|---|---|
| DM end-to-end encryption | **Broken by design (V-19)** — server can recompute every DM key |
| Onboarding privacy copy | **Currently false** — says the server cannot read messages |
| Real-device push | **Never verified** — emulator only, production holds 1 device token |
| Voice/video calls | **Never dialled**; no TURN server |
| Presence scaling | One global lobby room; needs geo-sharding (h3 + Citus is the candidate) |
| Job queue / cache / metrics | **Do not exist** — see §3 |
| Object storage | **Does not exist** — media rides `RoomEvent` |
| iOS | No project generated; requires a Mac |
| RoomEvent retention/TTL | Not written — disappearing messages are client-enforced only |
| View-once in PUBLIC groups | Server holds the key; composer offers it with no warning |
