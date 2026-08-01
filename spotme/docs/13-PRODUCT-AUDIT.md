# 13 — Spot Me Complete Product Audit (reverse-engineered from source)

**Date:** 2026-08-01 · **Evidence commit:** `master` = `a934e11` (open PRs noted
explicitly) · **Method:** every claim comes from reading the tree — routes,
gateways, manifests, schema, env references — not from docs or memory. Counts
are from greps run against this commit. Where something was sampled rather than
exhaustively read, the caveat says so (§ Caveats).

**Legend:** ✅ Production Ready · 🟡 Implemented but Incomplete ·
🟠 Behind Feature Flag / Hidden · 🔴 Planned Only · ❌ Removed / Dead

---

## 0. Repository context

`fable` is a **monorepo of unrelated projects**. Spot Me is `spotme/`;
`ysnap/` is a separate Next.js/three.js site (it — not Spot Me — is what the
Vercel integration deploys); `ybot/` is the untouched #8; `desk/`, `jarvis/`,
`memebot/`, `obsidian-plugin/`, `research/` are unrelated.

`spotme/` contains **four product tracks**:

| Track | What it is |
|---|---|
| `web/` | the real product — no-framework Vite SPA + Capacitor Android shell |
| `backend/` | NestJS + Prisma + Postgres server tier |
| `web/api/` (+ `server/api/`) | 8 serverless bridge functions (knock, translate, voice, turn, push, presence, username, _auth), staged into backend deploys via `predeploy` |
| `app/` + `core/` | an Expo/React-Native **P2P client on Hypercore/Hyperswarm** — a separate, older architecture with its own identity scheme (bip39) |

---

## 1. Product Features

| Feature | Status | Evidence |
|---|---|---|
| Auth — guest accounts (client-chosen id/secret) | ✅ | `auth.controller.ts` (6 routes), argon2, JWT access+refresh |
| Auth — email OTP | 🟡 | `otp/request`, `otp/verify` + `OtpCode` model exist; **`RESEND_API_KEY` is in `.env.example` but nowhere in `src/`** — no mail provider wired, delivery unproven |
| Auth — employee/admin login | ✅ | `employee/login`, `Employee` model, seed script |
| Profiles (name, username, avatar, lang) | ✅ | `users.controller.ts` (6 routes), `views/profile.js` (1078 lines) |
| Username claim/release/search | ✅ | `username.controller.ts` + `web/api/username.js` |
| Contacts | 🟡 | `views/contacts.js` (241 lines); nav wired in the 07-31 fixes; thin |
| 1:1 messaging (text) | ✅ | `views/chat.js` (4599 lines), `rooms.gateway.ts`; retry + failure surfacing tested |
| Group chats (roles, permissions, bans, join by @handle) | ✅ | `groups.controller.ts` (**16 routes**), `lib/group-perms.js`, wizard views, permission tests |
| Communities / Channels / Broadcast | 🔴 | no code anywhere |
| Stories / Status | 🟡 | full backend (post, feed, view, views, delete; `Story`+`StoryView`) but `views/stories.js` is 107 lines — minimal UI |
| Nearby discovery + map | 🟡 | `views/discovery.js` (750 lines), **Google Maps JS** via `VITE_GMAPS_KEY`, `locup` presence; H3/PostGIS from the plan absent |
| Bluetooth LE discovery | 🟡 | `views/bluetooth.js` (303 lines), Web Bluetooth; entry point fixed 07-31; hardware-unproven |
| Voice notes | ✅ | MediaRecorder path + voice review bar in chat.js, binary transfer |
| Voice / video calls | 🟡 | WebRTC in `net.js` — offer/accept/decline/end with `video:bool`, STUN + per-session **Cloudflare TURN** (`/api/turn`); no ICE restart; device-unproven |
| Screen sharing / live streaming | 🔴 | no `getDisplayMedia` anywhere |
| Photos + editor (crop, draw) | ✅ | `photoedit.js`, `crop.js`, `photos.js` |
| File sharing | ✅ | attachment slicing (8 MB), real progress, lazy re-fetch |
| View Once | ✅ | `ViewOnce` model + migration, live + unit tests, backlog exclusion |
| Reactions | ✅ | `sendReact` (chat.js:2479), `react` event, ghost-click armour |
| Replies | ✅ | replybar; 29 refs in chat.js |
| Edit / delete | ✅ | `edit`/`del` both directions; ordering race fixed 07-31 |
| Forward | ✅ | 8 refs |
| Mentions / threads / polls / bookmarks | 🔴 | zero code |
| Typing, read receipts, presence | ✅ | `typing`/`seen`/`read`/`peer`; "Last seen & online" wired 07-31 |
| In-chat search | 🟡 | single reference; no global search |
| Disappearing messages (per-chat timer) | ✅ | timer control messages, TTL both sides, composer chip |
| Location messages | ✅ | `kind:'location'` |
| Push — web (VAPID) | ✅ | `web-push`, `PushSubscription` model |
| Push — Android (FCM) | ✅ | `firebase-admin` (`FIREBASE_SERVICE_ACCOUNT`), poke path tested |
| Push — iOS (APNs) | ❌ | `@parse/node-apn` installed, **0 imports** |
| Block / report / moderation | ✅ | 7 routes, `Block`+`Report`; **NCMEC CyberTipline client is an explicit stub** awaiting an ESP account |
| Archive | 🟡 | 1 ref; minimal |
| Device wipe | ✅ | clears localStorage + `spotme-e2e` + media DB + `spotme-identity-pins`; returns `{ok, failures}` |
| Backup / restore | 🔴 web · 🟡 native | web: none (ADR-008 rules out key backup deliberately); `core/` has a bip39 24-word identity for the Hypercore track |
| Translation (per-message + whole-chat) | ✅ | §10 |
| Transliteration + English guard | ✅ | `translit.js`, `english.js`, tests |
| Read aloud / dictation | 🟡 | wired 07-31; ElevenLabs-dependent |
| E2EE | 🟡 by design | §7 |
| QR verification screen | ✅ | `views/verify.js` + `lib/qr-scan.js` (#28); camera device-unproven |
| Admin APIs | ✅ | 10 admin + 2 ingest routes (growth, user delete, crash reports, health) |

## 2. AI Features

| Capability | Provider | Where | Status |
|---|---|---|---|
| Speech-to-text (dictation) | **ElevenLabs** | `web/api/voice.js` proxy → `api.elevenlabs.io/v1`; client `lib/voice.js` | 🟡 wired; needs server-side key; bearer-gated since 07-31 |
| Text-to-speech (read aloud) | ElevenLabs | same proxy | 🟡 |
| Voice cloning | ElevenLabs | experimentation evidence only (stray debug file referencing `voice_id`); no product UI | 🔴 |
| Text translation | unofficial Google `gtx` → MyMemory → backend `/api/translate` | `lib/translate.js` | ✅ working; ⚠️ primary endpoint is unofficial/ToS-fragile |
| LLM / OCR / image generation / AI moderation / assistants | — | none in product code | 🔴 |

## 3. Third-Party Services

| Service | Installed | Wired | Used by | Env | Status |
|---|---|---|---|---|---|
| PostgreSQL | ✅ | ✅ | everything (Prisma) | `DATABASE_URL` | ✅ |
| S3-compatible storage (R2/MinIO/AWS) | ✅ `@aws-sdk/*` | ✅ `s3-storage.adapter.ts` + local-disk adapter | media | `STORAGE_PROVIDER`, `S3_*`, `STORAGE_LOCAL_*`, `STORAGE_URL_SECRET` | ✅ MinIO in CI; R2 workflow gated; local default |
| Cloudflare TURN | n/a | ✅ `/api/turn` mints per-session creds | calls | serverless key | 🟡 |
| Google Maps JS | ✅ | ✅ | discovery | `VITE_GMAPS_KEY` | ✅ |
| ElevenLabs | ✅ proxy | ✅ | voice | serverless key | 🟡 |
| Firebase FCM | ✅ | ✅ | Android push | `FIREBASE_SERVICE_ACCOUNT` | ✅ |
| web-push / VAPID | ✅ | ✅ | web push | `VAPID_*` | ✅ |
| APNs | ✅ dep | ❌ | — | `APNS_*` unused | ❌ dead |
| Centrifugo | ✅ adapter + backend module | ✅ | alt realtime | `VITE_CENTRIFUGO_URL`, `CENTRIFUGO_*` | 🟠 opt-in flag |
| Resend | ❌ no dep | ❌ | OTP email | `RESEND_API_KEY` example-only | 🔴 |
| NCMEC | stub | ❌ | moderation | `NCMEC_API_KEY` | 🔴 stub |
| Railway | deploy script | — | backend hosting | — | 🟠 **blocked by owner** |
| Vercel | — | serves `ysnap` + `web/api` functions | — | — | ✅ |
| Redis/DragonflyDB, LiveKit, Twilio, Stripe/Razorpay, Sentry, OpenAI, Anthropic, Mapbox | — | — | — | — | ❌ absent (ioredis/bullmq installed but unused → §13) |

## 4. Packages (12 manifests read; signal only)

- **backend prod (27):** Nest core, Prisma, socket.io, argon2, JWT/passport
  (used, 4 files), firebase-admin, web-push, AWS SDK, class-validator,
  `@nestjs/schedule` (used: storage cleanup cron).
  **Dead:** `bullmq`, `ioredis`, `prom-client`, `@parse/node-apn` (zero imports
  each); `cuid` unverified.
- **web prod (7):** socket.io-client, `jsqr` (Apache-2.0), `qrcode-generator`
  (MIT), `@capacitor/push-notifications`, and `trystero` +
  `@trystero-p2p/torrent` + vendored `spotme-core` — the last three serve only
  the hidden `p2p` transport (§11). Non-AGPL constraint holds; the lockfile is
  the audit trail.
- **app track:** Expo + react-native-bare-kit + spotme-core (hypercore,
  hyperswarm, autobase, bip39, sodium-universal) — a second architecture.
- **e2e:** `@playwright/test` only. **ysnap:** Next/Three/GSAP — unrelated.

## 5. APIs

- **REST: 72 routes / 14 controllers** — groups 16, admin 10, moderation 7,
  auth 6, users 6, media 5, stories 5, chat 4, chat-requests 3, keys 2,
  username 2, realtime 2, push 2, ingest 2.
- **WebSocket (server): 4 inbound messages** — `join`, `leave`, `action`,
  `fetch`; `action` is a multiplexed relay envelope. **~21 client-handled event
  types:** `msg bin binack edit del react seen read typing action profile peer
  locup history fetch fetchreq fetchres rtc call connect disconnect`.
- **Serverless bridge: 8 functions** (`_auth`, `knock`, `presence`, `push`,
  `translate`, `turn`, `username`, `voice`).
- **Jobs:** 1 cron (`storage-cleanup.service.ts`). **No queues in use** despite
  bullmq being installed.

## 6. Database

**25 Prisma models:** `User Presence Device InstallEvent OtpCode RefreshToken
Conversation Group GroupMember Story StoryView ConversationParticipant Message
ChatRequest Report Block Employee AuditLog HealthSample RoomEvent ViewOnce
PushSubscription DeviceToken RoomMember CrashReport`. **10 migrations**
(init → view-once → conversation key-version). Client-side storage: bounded
localStorage message store + three IndexedDBs (`spotme-e2e` identity, media
blobs, `spotme-identity-pins`). Indexes exist per migration files (sampled).

## 7. Encryption — the honest ledger

| Piece | Status |
|---|---|
| e2e_v1 (PBKDF2 over a server-recomputable secret) | ❌ **known-broken by design (V-19)** — legacy rooms only, kept as a tested negative control |
| e2e_v2: X25519/P-256 ECDH → HKDF → AES-GCM, non-extractable keys | ✅ shipped, reload-proven, mutation-tested |
| Identity pinning — 5-state machine, own DB | ✅ A1–A4 merged (#24–#26) |
| QR verification + safety numbers (Signal construction, 60 digits, v2 bound payload) | ✅ merged (#26, #28); camera unproven on hardware |
| Server availability axis (structurally cannot touch trust) | ✅ A6a (#27) |
| Send enforcement (Changed/Revoked block) | 🟠 **PR #31, flag OFF, unmerged** |
| Signing identity + PoP bindings (A7) | ✅ foundation merged (#29) — **deliberately unreachable; `signing-not-shipped.test.js` fails the build if wired** |
| Secure signing-key storage | 🔴 designed (ADR-008); **implementation blocked by the ADR-008 §12 rollback hard stop** |
| X3DH, prekeys, Double Ratchet, forward secrecy, break-in recovery | 🔴 designed (ADR-004 family + vectors + decision package); zero implementation |
| Multi-device | 🔴 normative minimum in ADR-006; blocked on the safety-number design question (ADR-008 §BLOCKING) |
| Media encryption | ✅ AES-GCM via room key; per-attachment random keys (plan B8) 🔴 |

## 8. Media

Client-side encrypt → 8 MB slicing with receiver-confirmed progress → binary
over socket, or presigned S3 path (`/v2/media`, 5 routes) with MinIO CI
coverage; IndexedDB blob store with quota handling; lazy backlog fetch (>4 KB
detached); view-once deletion; cleanup cron. **Missing (all plan items):**
thumbnails, SHA-256 dedup, malware-scan hooks, CDN configuration. Local-disk
storage is the default provider.

## 9. Voice

Notes ✅. Calls 🟡 (1:1 WebRTC with video flag, Cloudflare TURN; no ICE
restart, no added noise suppression/echo cancellation, no group calls,
device-unproven). ElevenLabs STT/TTS 🟡 behind the authed proxy. Voice cloning
🔴. Voice translation 🔴.

## 10. Translation

Per-message + whole-chat ✅. Provider chain: unofficial Google `gtx` →
MyMemory → backend proxy, with guard tests (`english-guard`,
`translate-guards`); transliteration ✅. Streaming/live translation 🔴;
provider abstraction with quality scoring (Priority 7) 🔴. **Risk: the primary
provider is an unofficial endpoint.**

## 11. Feature Flags

| Flag | Default | Purpose / files |
|---|---|---|
| `localStorage['spotme.transport']` = `socketio`·`centrifugo`·`p2p` | `socketio` | transport seam — `lib/transport/select.js`; deliberately survives wipe |
| `VITE_CENTRIFUGO_URL` | unset | enables the Centrifugo option (build-time) |
| `ENFORCING` (`identity-enforcement.js`) | `false` | **PR #31 only** — verdicts always computed, never bite while off |
| demo seed flag (`lib/demo.js`) | one-shot | seeds demo conversations once |
| `RESET_EPOCH` (`main.js`) | constant | one-time storage reset gate |
| `VITE_SPOTME_SERVER` / `VITE_GMAPS_KEY` | build-time | API base / maps key |

## 12. Hidden Features (exist; users cannot reach them)

P2P Trystero/WebTorrent transport (flag-only) · Centrifugo transport (flag +
env) · A5 enforcement (flag, unmerged) · A7 signing foundation (merged,
structurally unreachable, test-enforced) · NCMEC client (stub) · the entire
Hypercore native track (`app/` + `core/`).

## 13. Dead Code & Junk

- **Dead backend deps:** `bullmq`, `ioredis`, `prom-client`, `@parse/node-apn`
  — installed, zero imports. No metrics endpoint exists despite prom-client.
- **Declared-but-unused env:** `AGE_VERIFY_PROVIDER`, `AGE_VERIFY_API_KEY`,
  `RESEND_API_KEY`, `OTP_FROM_EMAIL`, `APNS_KEY_ID`, `APNS_TEAM_ID`,
  `JWT_REFRESH_SECRET` (both JWT strategies read `JWT_ACCESS_SECRET` — finding
  R5).
- **~25 shell-accident junk files committed** across `spotme/`, `web/`,
  `web/src/views/`, `server/`, `app/`, `ysnap/` — literal filenames such as
  `'`, `created`, `openBundle(original.vaultKey`, `Clear`, `DRAG_SLOP_PX)`,
  `{,`, `console.log('suriya50…`, `console.log(String(n).padEnd(30)…`, and one
  leaking a debug session shape (`…voice_id…`). **Delete them all.**
- Deliberate keepers: `deriveV1SecretForContrast` (negative control),
  `demo.js` inert-net.

## 14. Environment Variables

**Backend, used in `src/` (27 distinct):**
required — `DATABASE_URL`, `JWT_ACCESS_SECRET` (≥32 chars enforced at boot),
`PORT`; storage — `STORAGE_PROVIDER`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`,
`STORAGE_LOCAL_DIR`, `STORAGE_LOCAL_BASE_URL`, `STORAGE_URL_SECRET`;
push — `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`,
`FIREBASE_SERVICE_ACCOUNT`; realtime — `CENTRIFUGO_API_URL`,
`CENTRIFUGO_API_KEY`, `CENTRIFUGO_TOKEN_HMAC_SECRET_KEY`;
misc — `JWT_ACCESS_TTL`, `NODE_ENV`, `WEB_API_DIR`, `SEED_ADMIN_EMAIL`,
`SEED_ADMIN_NAME`, `SEED_ADMIN_PASSWORD`, `NCMEC_API_KEY`.
**Declared-but-unused:** the §13 list. **Web (build-time):**
`VITE_SPOTME_SERVER`, `VITE_GMAPS_KEY`, `VITE_CENTRIFUGO_URL`.
**E2E:** `E2E_API_PORT`, `E2E_WEB_PORT`, `E2E_DATABASE_URL`, `E2E_RUN_ID`,
`E2E_CHROMIUM` (no secrets). **Planned:** `SPOTME_E2E_CONTROL` (seam, unbuilt).

## 15. Architecture

**Frontend** — no-framework Vite SPA, hash routing, hand-rolled views; state in
bounded localStorage + three IndexedDBs; 500-line file rule (chat.js is the
standing violation). **Backend** — NestJS modular monolith, Prisma/Postgres,
socket.io gateway with a 4-message surface and a multiplexed `action` relay;
the serverless bridge functions are mounted into the same Express app in
production. **Realtime** — socket.io primary; `ITransportAdapter` seam with
Centrifugo and P2P implementations behind a flag; key material deliberately
never crosses the adapter (ADR-002). **Media** — client-encrypted, sliced,
storage-adapter (local | S3) with a presigned v2 path. **Security** —
zero-trust direction: v2 ECDH, TOFU pinning + verification, signing foundation,
enforcement dark; the server is the adversary in the ADR threat models.
**AI/Voice/Translation** — thin authed proxies (ElevenLabs, translate chain);
no LLMs. **Database** — single Postgres; no Redis in practice.
**Infrastructure** — CI with three jobs including a real-browser e2e suite,
MinIO in CI, Railway deploy (blocked), Vercel bridge; **no observability
stack** (no Sentry, no metrics, no tracing — only `AuditLog`/`HealthSample`/
`CrashReport` tables).

## 16. Investor Summary

| Area | Status | Demo-ready | Production-ready |
|---|---|---|---|
| 1:1 + group messaging (text/media/voice notes, reactions, edit/delete, timers, view-once) | ✅ | **Yes** | Near — needs observability + load testing |
| E2EE with verified identity (QR / safety numbers / pinning) | ✅ v2 | **Yes** | Yes for v2 scope; ratchet pending |
| Signal-grade crypto (X3DH / ratchet / multi-device) | 🔴 designed | No | No |
| Nearby discovery + map | 🟡 | Yes (with key) | No — privacy/battery work open |
| Voice/video calls | 🟡 | Careful demo | No |
| Stories | 🟡 | Barely | No |
| Push web + Android | ✅ | Yes | Yes; **iOS ❌** |
| Translation / transliteration | ✅ | **Yes** | Provider risk |
| Voice AI (STT/TTS) | 🟡 | Yes (with key) | Cost/limits unmodeled |
| Admin / moderation | ✅ APIs | Yes | NCMEC/CSAM pipeline is a stub |
| Native P2P track | 🟡 separate | Separate story | No |

## 17. Recommendations

**Quick wins:** delete the ~25 junk files; remove the 4 dead backend deps and
dead env vars; fix R5 (distinct refresh-token secret); add `/metrics` +
`/health` (prom-client is already installed); delete stale merged branches.
**Missing for MVP parity:** iOS push, message search, mentions, media
thumbnails, an account-recovery story.
**High-risk:** unofficial Google translate endpoint; the calls path unproven on
real networks; the serverless bridge duplicated between `web/api` and backend
staging; one secret signing both token types.
**Technical debt:** `chat.js` at 4599 lines (~9× the repo's own limit); two
parallel architectures with no stated disposition for the Hypercore track;
unrelated projects sharing the product repo.
**Security gaps beyond the planned crypto:** no rate limiting evident on
auth/OTP; the owner-ordered formal security review is still open; the NCMEC
stub is a legal-exposure item before any public launch.
**Cost:** ElevenLabs and TURN are the only metered services; neither is
usage-capped in code.

## Totals

| # | Metric | Value |
|---|---|---|
| 1 | User-visible features audited | ~45 — **22 ✅ · 12 🟡 · 11 🔴/❌** |
| 2 | Backend capabilities | 14 controllers · 25 models · 1 gateway · 1 cron · 8 bridge functions |
| 3 | AI capabilities | 3 live (STT, TTS, translation) + 1 experimental (cloning) |
| 4 | Third-party integrations | 8 active · 3 configured-but-dead · rest absent |
| 5 | REST endpoints | **72** |
| 6 | WebSocket events | 4 server messages / ~21 client event types |
| 7 | Database models | **25** (10 migrations) |
| 8 | Feature flags | **6** |
| 9 | Implementation vs the migration plan's full scope | **~45–50%** (estimate; messaging core ~90%, crypto programme ~55% through A7 foundation, Priorities 2–12 largely 🔴) |
| 10 | Differentiators vs WhatsApp/Signal/Telegram | verified-identity UX designed as one system (TOFU + QR + enforcement) before scale; first-class in-chat translation + transliteration; proximity-first discovery (map + BLE); a transport seam that can drop to serverless P2P; and an auditable engineering trail — ADRs, mutation-tested suites, licence-auditable lockfile — which is itself a diligence asset |

## Caveats — what was sampled, not exhaustively read

`chat.js` internals (capability greps, not a line-by-line read); Prisma index
completeness; the `app/` native track; `cuid` usage. Anything
hardware-touching (camera, BLE, calls on real networks) is UNPROVEN per
`.handoff/NEXT-SESSION.md`, which also carries the standing constraints this
audit does not restate.
