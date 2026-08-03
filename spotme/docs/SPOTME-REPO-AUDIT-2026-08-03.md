# READ-ONLY REPOSITORY AUDIT — spotmemessenger-glitch/fable

**Audited:** 2026-08-03 · **Subject:** `origin/master` (default branch) · **Method:** git history, `git archive` extraction to scratchpad, live GitHub API. No file in the repository was created, modified, or deleted; no branch, commit, push, or PR action was performed.

---

## 1. REPO SNAPSHOT — Verified

| Item | Value |
|---|---|
| Default branch | `master` |
| HEAD | `31e1894` — `docs: owner amendment 2026-08-01 — execution order + AI provider principle (#37)` |
| HEAD date | 2026-08-01 21:43:43 +0530 |
| Total commits on master | **85** |
| First commit | 2026-07-31 01:06:30 +0530 — **the entire master history spans ~2 days** |
| Contributors | 3 — spotmemessenger-glitch (34), Claude (30), Youvaraja (21) |

---

## 2. BRANCHES — Verified (69 remote branches)

Format: `name | behind/ahead vs master | last commit | base-of` (base-of from live PR metadata).

```
chore/web-lint-gate                      16/2   2026-08-01
ci/real-checks                           21/1   2026-08-01
claude/enterprise-ai-engineer-pack-…     85/59  2026-07-30   (unrelated experiment)
claude/next-session-b6ypc5               36/0   2026-07-31
claude/next-session-yol4aj               35/2   2026-08-01   (head of open PR #8, ybot)
claude/omniparser-verify-loop-ybot-…     85/63  2026-07-29   (unrelated experiment)
claude/session-handoff-aug-2-7vv7pz       0/0   2026-08-01   (== master)
claude/snap-camera-kit-repos-65c88r       0/17  2026-08-02   (head of #53)
claude/start-aen86m                      85/57  2026-07-26   (unrelated experiment)
cleanup/priority-1-high                   0/7   2026-08-01   (head of #46)
design/priority-1-forward-secrecy        17/5   2026-08-01
docs/discovery-platform-architecture      0/8   2026-08-03   (head of #65)
docs/engineering-handbook-v1              0/2   2026-08-03   (head of #62; BASE of #63)
docs/exchange-prd                         0/5   2026-08-03   (head of #64; BASE of #65)
docs/execution-order-2026-08-01           1/1   2026-08-01
docs/handoff-2026-08-01                   6/2   2026-08-01
docs/owner-amendment-2                    0/1   2026-08-01   (head of #38)
docs/platform-adrs                        0/1   2026-08-01   (head of #40; BASE of #47)
docs/pr2-migration-audit                 22/2   2026-08-01
docs/priority-0-audit                    25/0   2026-08-01
docs/priority-1-completion                0/7   2026-08-01   (head of #44)
docs/priority-1-review                    0/11  2026-08-01   (head of #45)
docs/priority-2-planning                  0/6   2026-08-02   (head of #47)
docs/product-audit-2026-08-01             0/4   2026-08-01   (head of #34)
docs/product-roadmap-v2                   0/3   2026-08-03   (head of #63; BASE of #64)
docs/roadmap-v2                           5/2   2026-08-01
docs/session-handoff-2026-08-02           0/2   2026-08-02   (head of #57)
docs/tech-stack-refresh                  34/0   2026-08-01
feat/a5-enforcement                       3/3   2026-08-01
feat/a5-matrix                            6/2   2026-08-01
feat/adaptive-transport-scaffold          0/7   2026-08-02   (head of #50)
feat/ai-vision                            0/18  2026-08-02   (head of #58)
feat/ar-beauty                            0/17  2026-08-02   (head of #59)
feat/camera-engine                        0/13  2026-08-02   (head of #56; BASE of #58,#59)
feat/creative-studio                      0/12  2026-08-02   (head of #55)
feat/discovery-v2-map-foundation          0/1   2026-08-02   (head of #60; BASE of #61)
feat/double-ratchet                       0/5   2026-08-01   (head of #42; BASE of #43)
feat/e2e-foundation                       8/3   2026-08-01
feat/identity-availability               10/1   2026-08-01
feat/identity-pin-state                  13/2   2026-08-01
feat/identity-propose-not-adopt          12/3   2026-08-01
feat/identity-verify-persist             11/1   2026-08-01
feat/live-nearby-events                   0/2   2026-08-02   (head of #61)
feat/live-voice-platform                  0/7   2026-08-02   (head of #54)
feat/live-voice-scaffold                  0/1   2026-08-02   (head of #49; BASE of #54)
feat/media-core-contracts                 0/1   2026-08-02   (NO PR — verified, §3)
feat/multi-device                         0/6   2026-08-01   (head of #43; BASE of #44,#45,#46)
feat/push-notification-sdks               0/1   2026-08-02   (head of #48; BASE of #52)
feat/push-platform                        0/3   2026-08-02   (head of #52)
feat/safety-numbers                      27/0   2026-08-01   (merged content)
feat/signing-identity                     7/4   2026-08-01
feat/signing-key-publication              0/3   2026-08-01   (head of #39; BASE of #41)
feat/signing-key-storage                  2/1   2026-08-01   (merged content)
feat/translation-abstraction              0/2   2026-08-02   (head of #51)
feat/verify-scanner-ui                    9/1   2026-08-01
feat/verify-screen                       25/0   2026-08-01   (merged content)
feat/x3dh-prekeys                         0/4   2026-08-01   (head of #41; BASE of #42)
feature/centrifugo-transport             47/14  2026-07-31   (abandoned — 47 behind)
fix/dm-room-authorisation                33/0   2026-08-01   (merged content)
fix/key-self-heal                        64/0   2026-07-31   (merged content)
fix/push-payload-handlers                34/0   2026-08-01   (merged content)
fix/v19-e2ee-key-agreement               66/0   2026-07-31   (merged content)
perf/idb-media-baseline                  15/4   2026-08-01
phase/a-transport-seam                   20/1   2026-08-01
phase/b-media-indexeddb                  19/1   2026-08-01
phase/c-storage-seam                     18/1   2026-08-01
test/s3-integration                      15/4   2026-08-01
wip/ai-vision-docscan-unreviewed          0/14  2026-08-02   (no PR)
```

---

## 3. PULL REQUESTS

**Open: 30** (verified live 2026-08-03). All are **draft except #39**, which is an open **non-draft** PR (`feat: signing-key publication + executable rollback`).

| # | Title (short) | Head | Base | Draft |
|---|---|---|---|---|
| 65 | Discovery Platform Architecture Spec | docs/discovery-platform-architecture | docs/exchange-prd | yes |
| 64 | SpotMe Exchange PRD | docs/exchange-prd | docs/product-roadmap-v2 | yes |
| 63 | Product Roadmap v2.0 | docs/product-roadmap-v2 | docs/engineering-handbook-v1 | yes |
| 62 | Engineering Handbook v1.0 | docs/engineering-handbook-v1 | master | yes |
| 61 | Live Nearby Events foundation | feat/live-nearby-events | feat/discovery-v2-map-foundation | yes |
| 60 | Discovery V2 + precise-GPS privacy fix | feat/discovery-v2-map-foundation | master | yes |
| 59 | AR & Beauty (CAM-3) | feat/ar-beauty | feat/camera-engine | yes |
| 58 | AI Vision (CAM-2) | feat/ai-vision | feat/camera-engine | yes |
| 57 | Handoff rewrite | docs/session-handoff-2026-08-02 | master | yes |
| 56 | Camera Engine (CAM-1) | feat/camera-engine | master | yes |
| 55 | Creative Studio (CAM-4) | feat/creative-studio | master | yes |
| 54 | Live Voice platform | feat/live-voice-platform | feat/live-voice-scaffold | yes |
| 53 | AR research reports | claude/snap-camera-kit-repos | master | yes |
| 52 | Push platform foundation | feat/push-platform | feat/push-notification-sdks | yes |
| 51 | Translation abstraction | feat/translation-abstraction | master | yes |
| 50 | Adaptive transport scaffold | feat/adaptive-transport-scaffold | master | yes |
| 49 | Live voice scaffold | feat/live-voice-scaffold | master | yes |
| 48 | Push SDKs (packages only) | feat/push-notification-sdks | master | yes |
| 47 | Priority 2 planning | docs/priority-2-planning | docs/platform-adrs | yes |
| 46 | Priority-1 HIGH cleanup | cleanup/priority-1-high | feat/multi-device | yes |
| 45 | Priority-1 review board | docs/priority-1-review | feat/multi-device | yes |
| 44 | Priority-1 completion evidence | docs/priority-1-completion | feat/multi-device | yes |
| 43 | Multi-device + ADR-013 | feat/multi-device | feat/double-ratchet | yes |
| 42 | Double Ratchet | feat/double-ratchet | feat/x3dh-prekeys | yes |
| 41 | X3DH + prekeys | feat/x3dh-prekeys | feat/signing-key-publication | yes |
| 40 | Platform ADRs 009–012 | docs/platform-adrs | master | yes |
| **39** | **Signing-key publication + rollback** | feat/signing-key-publication | master | **NO — not draft** |
| 38 | Owner amendment 2 | docs/owner-amendment-2 | master | yes |
| 34 | Product audit | docs/product-audit-2026-08-01 | master | yes |
| 8 | ybot step success criteria | claude/next-session-yol4aj | master (old base `0316275`) | yes |

**Merged: 34 PRs**, all merged 2026-07-31 → 2026-08-01:

| # | Title | Merged |
|---|---|---|
| 1 | Fix(E2EE): V-19 Key Agreement & Knock Relay Fixes | 2026-07-31 |
| 3 | Hotfix: stop a keyless device poisoning every chat it is in | 2026-07-31 |
| 4 | Self-healing key re-fetch: repair a chat whose peer rotated its identity | 2026-07-31 |
| 5 | docs(handoff): brief the next session on what shipped | 2026-07-31 |
| 6 | Fix the message loss, and make the failures that cause it visible | 2026-07-31 |
| 7 | Fix message loss, close five unauthenticated holes, make the shipped build work | 2026-08-01 |
| 9 | fix(spotme): push registers what the server accepts, and reads what it sends | 2026-08-01 |
| 10 | fix(spotme): a DM room id was never proof of belonging in it | 2026-08-01 |
| 11 | docs(spotme): rewrite the tech stack against the current architecture | 2026-08-01 |
| 12 | feat(spotme): safety numbers — Priority 1, phase 1a | 2026-08-01 |
| 13 | docs(spotme): Priority 0 repository audit | 2026-08-01 |
| 14 | feat(spotme): a screen for comparing safety numbers | 2026-08-01 |
| 15 | ADR-004 — forward secrecy: decisions recorded, e2e_v3 specified, vectors delivered | 2026-08-01 |
| 16 | docs(spotme): PR #2 migration audit and decision record — split into three | 2026-08-01 |
| 17 | Phase A — transport seam: one authorisation path for both transports | 2026-08-01 |
| 18 | Phase B — media lives in IndexedDB, not localStorage | 2026-08-01 |
| 19 | Phase C — storage seam, and attachments go client → bucket | 2026-08-01 |
| 20 | CI: make a green check mean something, and fix the viewonce race | 2026-08-01 |
| 21 | chore(web): a lint gate that catches defects, not formatting | 2026-08-01 |
| 22 | perf(web): IndexedDB and media-path baseline for Priority 1 | 2026-08-01 |
| 23 | test(spotme): move real bytes through S3StorageAdapter — MinIO in CI, R2 on demand | 2026-08-01 |
| 24 | feat(web): identity trust state machine and its persistence (A1) | 2026-08-01 |
| 25 | feat(web): a changed peer key is proposed, never adopted (A2 + A3) | 2026-08-01 |
| 26 | feat(web): a scanned safety number is bound before it is believed (A4) | 2026-08-01 |
| 27 | feat(web): the server gets an availability axis, and only that one (A6a) | 2026-08-01 |
| 28 | feat(web): wire the QR scanner into the verify screen | 2026-08-01 |
| 29 | feat(web): a signing identity, and bindings that prove possession (A7) | 2026-08-01 |
| 30 | test(web): mechanise the A5 device matrix, and fix the race it found | 2026-08-01 |
| 31 | feat(web): send enforcement, computed always and switched off (A5) | 2026-08-01 |
| 32 | test(e2e): Playwright foundation, and the silent backend build it uncovered | 2026-08-01 |
| 33 | docs(handoff): rewrite the pickup brief for the post-#29 state | 2026-08-01 |
| 35 | docs: Master Roadmap V2 saved as the engineering control document | 2026-08-01 |
| 36 | feat(web): signing-key storage per ADR-008 (Roadmap V2 Phase 2, first half) | 2026-08-01 |
| 37 | docs: owner amendment 2026-08-01 — execution order + AI provider principle | 2026-08-01 |

**#2 was closed UNMERGED** (2026-08-01). **Nothing has merged since #37 on 2026-08-01** — every change of the last two days exists only in open drafts. `feat/media-core-contracts` is pushed (0/1) with **no PR in any state** (verified: all-state query returns empty).

**UNVERIFIABLE (this section):** per-PR mergeable state, files-changed/+/− counts, and CI check status — the list API omitted those fields and 30 per-PR reads were not performed. CI *configuration* (§11) is verified; per-PR check *results* are not.

---

## 4. DIRECTORY STRUCTURE (master, depth 3, dirs)

```
.handoff/{agents,skills-3d}      config/   cryptobot/{bot,state}   desk/{desk/agents,office/static}
jarvis/{scripts,src/jarvis,tests,ui/assets}   memebot/state   obsidian-plugin/src
research/{App-Reviews,UI-Research,tools}      ysnap/          ybot/
ybot-assistant/{creations/*,plugins/crypto_desk_lib}
spotme/
  app/{assets,lib,worklet}       backend/{prisma,scripts,src,test}   core/   design/
  docs/{adr,verification}        e2e/{lib,tests}    server/api    test/
  web/{android,api,public,src,test,vendor}
```

No empty tracked directories. `spotme/design` contains junk-named files (`({`, `0`) alongside HTML mockups. `spotme/web/src/b.ts` is a 0-line stray file. Three 0-byte junk files at `spotme/`: `'`, `created`, `openBundle(original.vaultKey`.

---

## 5. ACTUAL DEPENDENCIES — Verified (12 package.json files, none in node_modules)

| Path | dependencies | devDependencies |
|---|---|---|
| `package.json` (root) | @gsap/react ^2.1.2, framer-motion ^12.42.2, gsap ^3.15.0, lenis ^1.3.25 | — |
| `spotme/package.json` | autobase ^7.28.1, b4a ^1.8.1, bip39 ^3.1.0, corestore ^7.11.1, hypercore ^11.34.1, hypercore-crypto ^3.7.0, hyperswarm ^4.17.0, sodium-universal ^5.0.1 | — |
| `spotme/web/package.json` | @capacitor/push-notifications ^8.1.2, @trystero-p2p/torrent ^0.25.3, jsqr ^1.4.0, qrcode-generator ^2.0.4, socket.io-client ^4.8.3, spotme-core (file:vendor), trystero ^0.25.3 | @capacitor/android+cli+core ^8.4.2, eslint ^9.39.1, globals ^16.5.0, sharp ^0.35.3, vite ^8.1.5 |
| `spotme/backend/package.json` | @aws-sdk/client-s3 + s3-request-presigner ^3.1100.0, @nestjs/{common,core,config,jwt,passport,platform-express,platform-socket.io,schedule,websockets} ^10.x/^3.x/^6.x, @parse/node-apn ^8.1.0, @prisma/client ^5.22.0, argon2 ^0.41.1, bullmq ^5.81.3, class-transformer ^0.5.1, class-validator ^0.14.1, cuid ^3.0.0, firebase-admin ^14.2.0, ioredis ^5.11.1, passport ^0.7.0, passport-jwt ^4.0.1, prom-client ^15.1.3, reflect-metadata ^0.2.2, rxjs ^7.8.1, socket.io ^4.8.1, web-push ^3.6.7 | @nestjs/{cli,schematics,testing}, @types/*, dotenv ^17.4.2, jest ^29.7.0, prisma ^5.22.0, socket.io-client, ts-jest, ts-node, typescript ^5.6.3 |
| `spotme/e2e/package.json` | — | @playwright/test ^1.50.0 |
| `spotme/app/package.json` | b4a, expo ~57, expo-*, react 19.2.3, react-native 0.86.0, react-native-bare-kit, spotme-core (file:..) | bare-pack ^2.2.1 |
| `spotme/server/api/package.json` | — | — |
| `spotme/web/vendor/spotme-core/package.json` | — | — |
| `ysnap/package.json` | next 15.5.20, react 19.1.0, three, @react-three/*, tailwind, gsap, framer-motion, lenis | typescript ^5, playwright, eslint-config-next, tailwindcss ^4 |
| `ybot/avatar/package.json` | three ^0.180.0 | — |
| `obsidian-plugin/package.json` | — | esbuild, obsidian, typescript ^5.8.3, eslint |
| `research/tools/package.json` | google-play-scraper ^10.1.3 | — |

**Explicit checklist:**

| Item | Verdict |
|---|---|
| NestJS | **Present** — backend ^10.4.6 |
| Prisma | **Present** — @prisma/client + prisma ^5.22.0 |
| Socket.IO server / client | **Present** — socket.io ^4.8.1 (+@nestjs/platform-socket.io) / socket.io-client ^4.8.3 (web) |
| Centrifugo client | **Absent as a dependency.** A hand-written adapter exists: `spotme/web/src/lib/transport/centrifugo-adapter.js`; backend `POST /v2/realtime/centrifugo/publish` throws 503 unless configured |
| Trystero | **Present** — trystero ^0.25.3 + @trystero-p2p/torrent (web) |
| Capacitor | **Present** — web (push-notifications dep; android/cli/core dev) |
| Vite | **Present** — web dev ^8.1.5 |
| TypeScript | **Present in backend only** (^5.6.3). Web is untyped JS |
| Redis/Dragonfly client | **Present** — ioredis ^5.11.1 (backend) |
| Queue library | **Present** — bullmq ^5.81.3. No NATS/Kafka |
| Search-engine client | **Absent** (no Meilisearch/Typesense/OpenSearch) |
| S3/object-storage SDK | **Present** — @aws-sdk/client-s3 + presigner (backend) |
| Crypto beyond WebCrypto | sodium-universal + hypercore-crypto (`spotme/package.json`, the legacy P2P core); argon2 (backend). **No libsignal** |
| AI/LLM SDK | **Absent as npm dependency.** Raw REST calls exist in `spotme/web/api/translate.js` (Google Translate, Azure, Sarvam URLs) and voice/dictation paths (ElevenLabs, referenced `web/src/views/chat.js:4160` and documented in PRD/roadmap) |
| Geospatial library | **Absent** (no H3/turf/PostGIS client; the only "h3" grep hits are HTML headings) |
| docker-compose / infra manifest | **Not Found.** Only `spotme/backend/Dockerfile` exists. No compose file, no service declarations, no Terraform |

---

## 6. LANGUAGE AND SIZE (spotme, master, excluding vendor)

| Area | .js files | js LOC | .ts files | ts LOC |
|---|---|---|---|---|
| web src | 57 | 22,226 | 1 (`b.ts`, empty) | 0 |
| web tests | 51 | 12,013 | 0 | 0 |
| web api (Vercel) | 8 | 2,176 | 0 | 0 |
| backend src | 0 | 0 | 68 | 5,956 |
| backend tests | 0 | 0 | 14 | 2,241 |
| shared core | 6 | 1,118 | 0 | 0 |
| e2e | 5 | 474 | 0 | 0 |
| **Total** | **134** | **38,938** | **83** | **8,197** |

**TypeScript share of Spot Me source LOC: 17.4%** — entirely the backend. The web app has **0% TypeScript**. The "TypeScript-first monorepo" of the canonical target architecture does not exist on master.

---

## 7. DATABASE — Verified

`spotme/backend/prisma/schema.prisma` — **25 models**: User, Presence, Device, InstallEvent, OtpCode, RefreshToken, Conversation, Group, GroupMember, Story, StoryView, ConversationParticipant, Message, ChatRequest, Report, Block, Employee, AuditLog, HealthSample, RoomEvent, ViewOnce, PushSubscription, DeviceToken, RoomMember, CrashReport.

**9 migrations**; most recent `20260731153000_add_conversation_key_version` (2026-07-31).

---

## 8. BACKEND REALITY CHECK — Verified: a real NestJS app exists on master

**15 modules**: app, admin, audit, auth, chat, chat-requests, groups, moderation, prisma, push, realtime, rooms, storage, stories, users. **2 WebSocket gateways**: `rooms.gateway.ts`, `chat.gateway.ts`. **14 controllers / routes**:

- `/auth`: signup, guest, otp/request, otp/verify, refresh, employee/login · `/v2/auth/keys`: POST, GET :userId · `/username`: GET, POST
- `/users/me` + `/users`: GET, PATCH, presence, uninstall, DELETE, lookup
- `/chat`: conversations, conversations/:id, /:id/messages, /:id/read · `/chat-requests`: POST, pending, :id/respond
- `/groups`: 16 routes (CRUD, members, roles, grants, ban, mute, transfer, join-by-username)
- `/stories`: POST, feed, :id/view, :id/views, DELETE · `/moderation` + `/admin/reports`: reports, blocks, resolve, escalate-csam
- `/v2/media` (+local): presign, download-url, POST/PUT/GET · `/v2/realtime`: token, centrifugo/publish (503 unless configured)
- `/push`: GET, POST · `/admin`: growth, health, audit-log, employees, users delete · `/ingest`: crash, install-event

---

## 9. MESSAGING AND SECURITY CLAIMS (master only)

| Claim | Verdict |
|---|---|
| X3DH | **Not Found on master.** Real implementation exists only on branch `feat/x3dh-prekeys` (open PR #41) |
| Double Ratchet | **Not Found on master.** Branch `feat/double-ratchet` (PR #42) only |
| Prekeys | **Not Found on master.** PR #41 branch only |
| Key rotation | **Verified, working** — `web/src/lib/crypto/identity-store.js` (self-heal re-fetch), `signing-key-store.js` (rotate/forget; reachable from app only via the wipe path in `db.js:135`) |
| Identity pinning | **Verified, working** — `crypto/identity-pin.js`, `identity-pin-store.js`; tested (`identity-pin*.test.js`) |
| QR safety numbers | **Verified, working** — `crypto/safety-number.js`, `views/verify.js`, `lib/qr-scan.js` (jsqr) |
| Device trust | **Verified, working logic, gate OFF** — `crypto/identity-enforcement.js`: verdict computed always; `enforcing` defaults `false` (line 77) |
| Multi-device sync | **Not Found on master.** PR #43 branch only |
| Disappearing messages | **Verified, working** — `msgTtl` in `db.js`/`rooms.js`/`chat.js` |
| View-once media | **Verified, working** — `ViewOnce` Prisma model, rooms/store paths, `viewonce.test.js` |
| Voice notes | **Verified, working** — MediaRecorder capture (`chat.js:3904–3909`), `lib/voice.js` (audio as base64 data URLs) |
| WebRTC calling | **Verified, working** — call state + `srcObject` rendering in `chat.js`, media streams via `conn.net.addStream` (`rooms.js:589,754`) over Trystero-managed WebRTC; no bare RTCPeerConnection code |
| TURN/STUN | **Verified** — `net.js:54` (Cloudflare/Google STUN), TURN credentials fetched at runtime; `web/api/turn.js` exists |
| Push notifications | **Verified, working code paths** — web `lib/push.js` (Capacitor + web push registration), backend `push.service.ts` (web-push + firebase-admin FCM; @parse/node-apn dependency present) |

---

## 10. FEATURE FLAGS (master)

**One feature flag exists**: send enforcement — `web/src/lib/crypto/identity-enforcement.js:77` `let enforcing = false`, runtime setter `setEnforcement()` (line 83), read via `isEnforcing()`. Mechanism: module-local runtime variable, **default `false`**; nothing in the app calls `setEnforcement(true)`. **No flag anywhere on master defaults to true.** The layered compile-time flag systems (discovery-v2, live-events, camera) exist **only on unmerged branches**. User settings (`showOnMap`, `lastSeen`, `msgTtl`) are preferences, not feature flags.

---

## 11. TESTS AND CI — Verified

- **Web**: 45 test files, all 45 wired into `web/package.json`; custom `check()` harness (541 check-cases) + 10 files using `node:test`. **Suite run during this audit: PASS (exit 0)** — run in a working tree whose `spotme/web` + `spotme/core` are byte-identical to `origin/master` (verified by `git diff --quiet`). `.handoff`'s "936/936" figure could not be reproduced by any counting method used here.
- **Backend**: Jest; 10 `.spec.ts` files, 112 `it()` cases. **Not run** (requires PostgreSQL; runs in CI).
- **e2e**: Playwright; 3 specs. **Not run** (requires a running backend).
- **Workflows**: `ci.yml` — on PR + push to master; jobs: `backend` (tests vs real Postgres 16 + MinIO, typecheck, build), `web` (suite), `e2e` (real browser vs real backend + Postgres). `r2-smoke.yml` — manual `workflow_dispatch` with a "staging" confirm input; S3/R2 storage smoke.

---

## 12. DOCUMENTATION INVENTORY

**299 markdown files** on master. By area: **ybot-assistant 231** (assistant "creations" — unrelated to Spot Me), **spotme 35**, **.handoff 21**, research 4, ybot 3, obsidian-plugin 2, ysnap 1, jarvis 1, root 1. The table lists the root file and all Spot Me docs; the full 299-row listing is reproducible with `git ls-tree -r origin/master --name-only | grep '\.md$'`.

| Path | First H1 | Lines | Last mod |
|---|---|---|---|
| CLAUDE.md | Ruflo — Claude Code Configuration | 237 | 2026-08-01 |
| .handoff/NEXT-SESSION.md | START HERE — pickup brief | 368 | 2026-08-01 |
| spotme/AUDIT_2026-07-26.md | SPOT ME MESSENGER — Technical Audit Report | 743 | 2026-07-31 |
| spotme/app/AGENTS.md | Expo HAS CHANGED | 3 | 2026-07-31 |
| spotme/app/CLAUDE.md | (no H1) | 1 | 2026-07-31 |
| spotme/backend/README.md | Spot Me — backend (server-tier rewrite) | 93 | 2026-07-31 |
| spotme/docs/01-PRD.md | Spot Me Messenger — PRD | 268 | 2026-07-31 |
| spotme/docs/02-SYSTEM-ARCHITECTURE.md | Complete System Architecture | 500 | 2026-08-01 |
| spotme/docs/03-DATABASE-SCHEMA.md | Database Schema | 323 | 2026-07-31 |
| spotme/docs/04-API-DOCUMENTATION.md | API Documentation | 502 | 2026-08-01 |
| spotme/docs/05-DESIGN-SYSTEM.md | UI/UX Design System | 130 | 2026-07-31 |
| spotme/docs/06-ROADMAP.md | Development Roadmap | 287 | 2026-07-31 |
| spotme/docs/07-SECURITY-PLAN.md | Security Plan | 472 | 2026-07-31 |
| spotme/docs/08-TESTING-STRATEGY.md | Testing Strategy | 355 | 2026-08-01 |
| spotme/docs/09-TECH-STACK.md | Tech Stack | 311 | 2026-08-01 |
| spotme/docs/10-PRIORITY-0-AUDIT.md | Priority 0 — Repository Audit | 186 | 2026-08-01 |
| spotme/docs/11-PR2-MIGRATION-AUDIT.md | PR #2 — migration audit | 147 | 2026-08-01 |
| spotme/docs/12-PRIORITY-1-BASELINE.md | IndexedDB and media-path baseline | 127 | 2026-08-01 |
| spotme/docs/14-ROADMAP-V1-TO-V2-MAPPING.md | V1→V2 Roadmap Mapping | 177 | 2026-08-01 |
| spotme/docs/GROUPS-BUILD.md | Groups v2 — build progress | 140 | 2026-07-31 |
| spotme/docs/MASTER-ENGINEERING-ROADMAP-V2.md | Engineering Master Roadmap V2 | 572 | 2026-08-01 |
| spotme/docs/MIGRATION-PLAN-V1.md | Migration Plan (V1) — HISTORICAL | 338 | 2026-08-01 |
| spotme/docs/adr/001…008 (11 md files) | ADR-001 … ADR-008 + 004a–d | 140–458 ea. | 2026-07-31/08-01 |
| spotme/web/CONTRACT.md | web — view module contract | 124 | 2026-07-31 |
| spotme/web/DEPLOY.md | Deploying the Spot Me web app | 48 | 2026-07-31 |
| spotme/web/PUSH.md | Push notifications | 121 | 2026-07-31 |

Note: **the handbook, product authority, roadmap v2.0, Exchange PRD, DPAS, and ADRs 014–023 are NOT on master** — they exist only in open draft PRs #62–#65.

### CLAUDE.md (master, quoted in full — 237 lines)

````markdown
# Ruflo — Claude Code Configuration

## ⭐ Resuming a previous session — READ FIRST

When the user says **"recall previous session"**, "pick up from where you left
off", "continue from last session", or `/pickup`:

**Read `.handoff/NEXT-SESSION.md` before doing anything else.** It is the
authoritative pickup brief — current state, the agreed next task, known traps,
measured numbers, what is unproven, and what is blocked on the user.

Also in `.handoff/`:
- `SESSION-<date>.md` — full chronological log with evidence
- `ai-os-stack-2026-07-29.md` — technical facts (venvs, versions, gotchas)
- `pickup-SKILL.md` — the skill definition; copy to `~/.claude/skills/pickup/`
  to get the `/pickup` command locally (`.claude/` is gitignored, so it cannot
  travel with the repo)

**Why this lives in the repo:** cloud/remote sessions run in a fresh clone.
Anything under `~/.claude/` (skills, memory notes) does NOT travel. Only
committed files do. Keep `.handoff/` updated in place and commit it at the end
of any substantial session, or the next remote session starts blind.

**Never claim something works because the brief says so** — the brief is a
record, not a live check. Anything marked UNPROVEN stays unproven until re-run.

## ⭐ Controlling engineering document — consult before ANY coding

**`spotme/docs/MASTER-ENGINEERING-ROADMAP-V2.md` is the engineering control
document for Spot Me. Read it (at minimum §2 rules, §5 priorities, §8
checklist, §10 instructions) before changing code, and check every change
against it.** The owner's instruction: refer to it each time you code.

- **V2 is APPROVED and controlling (owner directive, 2026-08-01).** The V1→V2
  mapping is `spotme/docs/14-ROADMAP-V1-TO-V2-MAPPING.md`; V1
  (`spotme/docs/MIGRATION-PLAN-V1.md`) is historical, and where V1 is stricter
  the stricter gate still holds (V2 Appendix B). The A1–A7 labels are retired
  wherever they conflict with V2. **Owner execution order (amended 2026-08-01
  — roadmap "Owner Amendment" section):** ① push notifications (Android+iOS,
  background/terminated/foreground, production-grade) → ② translation
  platform (provider abstraction over the existing multi-provider engine) →
  ③ live voice translation (flagship; dedicated architecture, NOT an
  extension of voice notes; MVP < 2.5 s end-to-end) → ④ adaptive
  communication layer (automatic transport switching incl. native Bluetooth
  offline; users never pick a transport) → ⑤ remaining Priority 1 crypto
  (X3DH → Double Ratchet → multi-device → completion evidence) — **still
  mandatory before Priority 1 is declared complete**. AI Communication ADRs
  may proceed as planning. New standing principle: every AI feature
  optimises accuracy + latency + privacy simultaneously; no provider may
  become a hard dependency — route/fall back on quality, availability, cost,
  response time.
- **V1/V2 priority numbers differ.** Owner blocks were issued against V1
  numbers — the mapping §1 restates them under V2 numbering. Never treat a
  renumbering as an unblock.
- The **ADR-008 §12 hard stop** (no signing-key generation/persistence/
  publication, prekeys, X3DH, ratchet, or multi-device until
  rollback-after-publication is executable or separately authorized) is
  unchanged by V2.

## Rules

- Do what has been asked; nothing more, nothing less
- NEVER create files unless absolutely necessary — prefer editing existing files
- NEVER create documentation files unless explicitly requested
- NEVER save working files or tests to root — use `/src`, `/tests`, `/docs`, `/config`, `/scripts`
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files
- NEVER add a `Co-Authored-By` trailer to user commits unless this project's `.claude/settings.json` has `attribution.commit` set (#2078). The Claude Code Bash tool may suggest one in its default commit-message template — ignore it. `Co-Authored-By` is semantic authorship attribution under git/GitHub convention; the tool is the facilitator, not a co-author.
- Keep files under 500 lines
- Validate input at system boundaries

## Agent Comms (SendMessage-First Coordination)

Named agents coordinate via `SendMessage`, not polling or shared state.

```
Lead (you) ←→ architect ←→ developer ←→ tester ←→ reviewer
              (named agents message each other directly)
```

### Spawning a Coordinated Team

```javascript
// ALL agents in ONE message, each knows WHO to message next
Agent({ prompt: "Research the codebase. SendMessage findings to 'architect'.",
  subagent_type: "researcher", name: "researcher", run_in_background: true })
Agent({ prompt: "Wait for 'researcher'. Design solution. SendMessage to 'coder'.",
  subagent_type: "system-architect", name: "architect", run_in_background: true })
Agent({ prompt: "Wait for 'architect'. Implement it. SendMessage to 'tester'.",
  subagent_type: "coder", name: "coder", run_in_background: true })
Agent({ prompt: "Wait for 'coder'. Write tests. SendMessage results to 'reviewer'.",
  subagent_type: "tester", name: "tester", run_in_background: true })
Agent({ prompt: "Wait for 'tester'. Review code quality and security.",
  subagent_type: "reviewer", name: "reviewer", run_in_background: true })

// Kick off the pipeline
SendMessage({ to: "researcher", summary: "Start", message: "[task context]" })
```

### Patterns

| Pattern | Flow | Use When |
|---------|------|----------|
| **Pipeline** | A → B → C → D | Sequential dependencies (feature dev) |
| **Fan-out** | Lead → A, B, C → Lead | Independent parallel work (research) |
| **Supervisor** | Lead ↔ workers | Ongoing coordination (complex refactor) |

### Rules

- ALWAYS name agents — `name: "role"` makes them addressable
- ALWAYS include comms instructions in prompts — who to message, what to send
- Spawn ALL agents in ONE message with `run_in_background: true`
- After spawning: STOP, tell user what's running, wait for results
- NEVER poll status — agents message back or complete automatically

## Swarm & Routing

### Config
- **Topology**: hierarchical-mesh (anti-drift)
- **Max Agents**: 15
- **Memory**: hybrid
- **HNSW**: Enabled
- **Neural**: Enabled

```bash
npx @claude-flow/cli@latest swarm init --topology hierarchical --max-agents 8 --strategy specialized
```

### Agent Routing

| Task | Agents | Topology |
|------|--------|----------|
| Bug Fix | researcher, coder, tester | hierarchical |
| Feature | architect, coder, tester, reviewer | hierarchical |
| Refactor | architect, coder, reviewer | hierarchical |
| Performance | perf-engineer, coder | hierarchical |
| Security | security-architect, auditor | hierarchical |

### When to Swarm
- **YES**: 3+ files, new features, cross-module refactoring, API changes, security, performance
- **NO**: single file edits, 1-2 line fixes, docs updates, config changes, questions

### 3-Tier Model Routing

| Tier | Handler | Use Cases |
|------|---------|-----------|
| 1 | Agent Booster (WASM) | Simple transforms — skip LLM, use Edit directly |
| 2 | Haiku | Simple tasks, low complexity |
| 3 | Sonnet/Opus | Architecture, security, complex reasoning |

## Memory & Learning

### Before Any Task
```bash
npx @claude-flow/cli@latest memory search --query "[task keywords]" --namespace patterns
npx @claude-flow/cli@latest hooks route --task "[task description]"
```

### After Success
```bash
npx @claude-flow/cli@latest memory store --namespace patterns --key "[name]" --value "[what worked]"
npx @claude-flow/cli@latest hooks post-task --task-id "[id]" --success true --store-results true
```

### MCP Tools (use `ToolSearch("keyword")` to discover)

| Category | Key Tools |
|----------|-----------|
| **Memory** | `memory_store`, `memory_search`, `memory_search_unified` |
| **Bridge** | `memory_import_claude`, `memory_bridge_status` |
| **Swarm** | `swarm_init`, `swarm_status`, `swarm_health` |
| **Agents** | `agent_spawn`, `agent_list`, `agent_status` |
| **Hooks** | `hooks_route`, `hooks_post-task`, `hooks_worker-dispatch` |
| **Security** | `aidefence_scan`, `aidefence_is_safe`, `aidefence_has_pii` |
| **Hive-Mind** | `hive-mind_init`, `hive-mind_consensus`, `hive-mind_spawn` |

### Background Workers

| Worker | When |
|--------|------|
| `audit` | After security changes |
| `optimize` | After performance work |
| `testgaps` | After adding features |
| `map` | Every 5+ file changes |
| `document` | After API changes |

```bash
npx @claude-flow/cli@latest hooks worker dispatch --trigger audit
```

## Agents

**Core**: `coder`, `reviewer`, `tester`, `planner`, `researcher`
**Architecture**: `system-architect`, `backend-dev`, `mobile-dev`
**Security**: `security-architect`, `security-auditor`
**Performance**: `performance-engineer`, `perf-analyzer`
**Coordination**: `hierarchical-coordinator`, `mesh-coordinator`, `adaptive-coordinator`
**GitHub**: `pr-manager`, `code-review-swarm`, `issue-tracker`, `release-manager`

Any string works as a custom agent type.

## Build & Test

- ALWAYS run tests after code changes
- ALWAYS verify build succeeds before committing

```bash
npm run build && npm test
```

## CLI Quick Reference

```bash
npx @claude-flow/cli@latest init --wizard           # Setup
npx @claude-flow/cli@latest swarm init --v3-mode     # Start swarm
npx @claude-flow/cli@latest memory search --query "" # Vector search
npx @claude-flow/cli@latest hooks route --task ""    # Route to agent
npx @claude-flow/cli@latest doctor --fix             # Diagnostics
npx @claude-flow/cli@latest security scan            # Security scan
npx @claude-flow/cli@latest performance benchmark    # Benchmarks
```

26 commands, 140+ subcommands. Use `--help` on any command for details.

## Setup

```bash
claude mcp add claude-flow -- npx -y ruflo@latest mcp start
npx ruflo@latest doctor --fix
```

> The background `daemon` is optional. It runs interval workers that each spawn
> a headless `claude` session, so it consumes tokens continuously. Start it only
> if you want those sweeps: `npx ruflo@latest daemon start` (self-stops after 12h
> by default; `--ttl 0` to disable, `daemon status --all` to audit running daemons).

**Agent tool** handles execution (agents, files, code, git). **MCP tools** handle coordination (swarm, memory, hooks). **CLI** is the same via Bash.
````

---

## 13. CONTRADICTIONS — Verified

1. **`web/src/lib/discovery.js` lies about itself.** Its header (lines 9–13) claims "positions are rounded to ~110 m and offset with a stable per-person jitter before they ever leave the device." The code broadcasts the **raw high-accuracy GPS fix** (`lat: position.lat` at lines 69–70, sourced from `fix.coords.latitude` at line 87, `enableHighAccuracy: true`). The `coarse()` helper (line ~246) exists but is never applied to the broadcast. The fix exists only in unmerged draft PR #60.
2. **`spotme/docs/09-TECH-STACK.md §2`** states web has "no ESLint config and no typecheck script" — `spotme/web/eslint.config.mjs` exists on master and `npm run lint` is wired (merged PR #21). The doc's own header admits it was written against older master `0316275`.
3. **`CLAUDE.md` (master)** declares `.handoff/NEXT-SESSION.md` the authoritative bootstrap; that brief's "Repository state" section lists `fb02b99` as master head (now one commit stale) and claims "web 936/936" tests — a figure not reproducible from the current suite (45 files / 541 `check()` cases). Four open PRs (#62–#65) retire this mechanism, but on master it is still the instruction.
4. **ADR-002 (Centrifugo behind a transport interface)** vs reality: the adapter file and a backend `centrifugo/publish` endpoint exist, but the endpoint throws 503 "not configured", no Centrifugo client library is a dependency anywhere, and `feature/centrifugo-transport` is abandoned 47 commits behind. The live realtime path is Socket.IO.
5. **CLAUDE.md rule "NEVER save working files or tests to root"** vs a root `package.json` carrying animation libraries (gsap/framer-motion/lenis) unrelated to any root project, plus junk files inside `spotme/` (§14).
6. **Code no doc mentions:** the entire non-Spot-Me half of the repo (ybot-assistant's 231 markdown "creations", cryptobot, memebot, desk, jarvis, ysnap, obsidian-plugin) appears in no Spot Me doc; `spotme/app` (Expo/bare RN client) is absent from 09-TECH-STACK's tier table beyond the Capacitor line; `spotme/test/{identity,room}.test.js` (legacy P2P core tests) are wired into no runner.

---

## 14. DEAD OR LEGACY CODE — Verified

| Path | Evidence |
|---|---|
| `ybot-assistant/`, `ybot/`, `cryptobot/`, `memebot/`, `desk/`, `jarvis/`, `obsidian-plugin/`, `ysnap/`, `research/`, `config/` | Non-Spot-Me projects sharing the repo; 231 of 299 md files are ybot-assistant creations |
| Root `package.json` | gsap/framer-motion/lenis at repo root; no root src using them |
| `spotme/package.json` | Hyper-stack deps (hypercore, hyperswarm, autobase, corestore, sodium) — the pre-migration P2P core; only `spotme/core` + `spotme/app` reference this world |
| `spotme/app/` | Expo/bare RN experiment (react-native 0.86, bare-kit); AGENTS.md is 3 lines; not the shipped client |
| `spotme/test/` | 2 legacy core tests wired into no test script |
| `spotme/server/` | Deploy scripts plus garbled filenames (`console.log(String(n).padEnd(26)` etc. committed as files) |
| `spotme/design/` | HTML mockups plus junk files `({` and `0` |
| `spotme/'`, `spotme/created`, `spotme/openBundle(original.vaultKey` | Three 0-byte shell-accident files |
| `spotme/web/src/b.ts` | Empty stray file |
| `spotme/web/api/` | Vercel serverless functions with live vendor URLs (Google/Azure/Sarvam translate) — 09-TECH-STACK calls them vestigial yet the same files are staged into the Railway image |
| Branches: `feature/centrifugo-transport` (47 behind), `claude/enterprise-ai-engineer-pack-*`, `claude/omniparser-*`, `claude/start-*` (85 behind, 57–63 ahead) | Abandoned/unrelated experiment branches |

---

## UNVERIFIABLE

- Per-open-PR mergeable state, changed-files/additions/deletions, and CI check results (API list omitted the fields; 30 per-PR queries not executed).
- Whether the deployed Vercel/Railway instances currently run master (no deployment access; Vercel MCP connector unauthenticated in this session).
- Backend and e2e test pass/fail right now (require Postgres/running backend; not executed — CI configuration verified instead).
- The `.handoff` "936/936" historical test figure.

---

## WHAT IS ACTUALLY RUNNABLE TODAY

**From a fresh clone of `master`, a developer gets:** a working vanilla-JS web messenger (`spotme/web`: `npm install && npm run dev`) that talks to a hosted Railway API by default; a real NestJS backend (`spotme/backend`) that runs if you supply PostgreSQL and env secrets; a green 45-suite web test run (verified in this audit, exit 0); ESLint; a Vite build; a Playwright e2e harness that needs the backend up. There is no docker-compose, so local backend setup is manual. Half the repository is unrelated projects.

**A user of the deployed app can, today:** chat 1-1 and in groups (roles/bans server-enforced), by username, invite link, nearby discovery, or Bluetooth preview; send media (IndexedDB + bucket uploads), voice notes, view-once media, disappearing messages; make P2P voice/video calls (Trystero/WebRTC with STUN/TURN); translate/transliterate messages; verify contacts via QR safety numbers with a real identity-pinning trust machine; receive push notifications; post stories (minimal UI).

**What a user does NOT get, bluntly:** forward secrecy — there is no X3DH, no Double Ratchet, no prekeys on master (e2e-v2 only; the ratchet stack sits in unmerged PRs #41–#43 behind the ADR-008 §12 hard stop). Send-enforcement is computed but switched off. **Nearby discovery broadcasts the user's precise high-accuracy GPS position to a public lobby while the code's own comment claims it is coarsened — the privacy fix exists only in unmerged draft PR #60.** Everything announced in the last two days — camera suite, Discovery V2, Live Nearby Events, Exchange, push platform, live voice, translation abstraction, the Engineering Handbook, product roadmap, and all governance ADRs 014–023 — exists **only in 30 open draft PRs (plus one PR-less branch)**. Nothing has merged since 2026-08-01. The product on master is a capable proximity messenger with strong identity verification, a real backend, honest tests — and a live location-privacy defect its own documentation denies.
