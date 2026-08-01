# Spot Me — Testing Strategy

**Document 08 of the platform rebuild set.**
Spot Me is a proximity-first messenger (no account, password, or phone number) migrating from a pure P2P WebRTC prototype (`spotme/web`, Trystero transport) to a server-backed platform (`spotme/backend`, NestJS + Prisma + Postgres + Socket.IO) while preserving its end-to-end privacy promise: the server stores ciphertext only. This document defines how the platform is tested — what exists today, what each test layer must prove, the coverage targets, the live-verification ritual the project already relies on, and the CI plan. It stands alone; no other document is required to act on it.

Phase tags: **P1** = current migration (server-backed transport, single-node), **P2** = 100K–10M users (Redis, queues, SFU, native GA), **P3** = 10M+ (hot-path services, multi-region).

---

## 1. Guiding principles

1. **Test the privacy promise, not just the features.** The single most important invariant is that the server never sees plaintext message content or room secrets. Tests must assert server blindness directly (Section 6), because it is the claim users are trusting.
2. **Fake only the network boundary.** The existing web suites set the precedent (`spotme/web/test/requests.test.js` header comment): real `db.js`, real `push.js`, faked `fetch`/transport. Mocking application modules lets them drift from what ships without failing anything. Keep this rule.
3. **Delivery guarantees are properties, not scenarios.** "A knock stays owed until the recipient's device acknowledges it" and "an attachment either fully arrives or is retried" are the properties the current suites pin. Every new transport must re-prove them, not inherit them.
4. **No fake states in tests either.** The product forbids fake "Delivered" tiers and fake precision (honesty rules in `spotme/web/src/tokens.css`-era design law). Tests must not assert states the product does not actually have.
5. **A migration test suite is a safety harness, not a formality.** The server-backed transport (`spotme/web/src/lib/socket-transport.js`, Phase 1 deliverable, in progress) is a drop-in replacement for the Trystero API surface (`joinRoom`/`selfId`). The strongest possible test is running the *existing* property suites against the *new* transport.

---

## 2. Current state (verified in-repo)

### 2.1 Web test suite — `spotme/web/test/`

Run with `npm test` from `spotme/web` (Node's built-in test runner with `--experimental-test-module-mocks`; no framework dependency). Three suites exist:

| File | What it proves |
|---|---|
| `spotme/web/test/requests.test.js` | The direct-reach knock protocol (`spotme/web/src/lib/reach.js`): a chat request stays owed until the recipient's device acknowledges it; the `api/knock.js` relay persists knocks across the *sender* going offline; `checkRelay()` on resume picks up and clears relayed knocks. Transport and `fetch` are faked; `db.js` and `push.js` are real. |
| `spotme/web/test/media.test.js` | The attachment slicing protocol (128KB slices with acks): pins the P0 bug where one large photo silently killed a conversation (transport chunk-pause timeout resolved a half-finished send as success). Asserts full-delivery-or-retry and that text/receipts are not starved behind a transfer. |
| `spotme/web/test/push.test.js` | `api/push.js` signs a real, verifiable VAPID token (fresh keypair generated in-test; no private key touches the repo). |

These are regression suites for expensive, silently-failing bugs. They are the model for everything below.

### 2.2 Backend — `spotme/backend`

Jest is configured (`"test": "jest"` in `spotme/backend/package.json`, with `ts-jest`, `@types/jest`, and `@nestjs/testing` as devDependencies), but **no `*.spec.ts` files exist yet** under `spotme/backend/src/`. The backend was verified running against a local Docker Postgres on 2026-07-26 by manual/live verification only. Closing this gap is the core P1 testing work.

### 2.3 Live verification (the existing ritual)

The project's standing practice: every user-facing claim is proven in **two real browser contexts** (two peers) driving the actual app — discovery → knock → chat → translation → receipts — with **screenshot evidence** captured at the proving moment. Features that cannot be honestly verified are labeled as such (the product's own "cooperative-feature admissions" rule). This ritual is retained and formalized in Section 7 — automation supplements it, it does not replace it.

---

## 3. Unit tests (P1)

Fast, deterministic, no network, no database. Web tests continue on the Node test runner; backend unit tests use Jest.

### 3.1 Crypto layer — highest priority (P1)

The Phase 1 transport encrypts every persistent payload client-side with AES-GCM, using a key derived from the room secret (which lives in URL fragments/localStorage and is never sent to the server). This module (part of `spotme/web/src/lib/socket-transport.js` or a sibling under `spotme/web/src/lib/`) needs:

- **Round-trip:** encrypt → decrypt returns the original payload for every action type the room protocol carries (msg, react, edit, del, read, seen, history, bin/binack, etc. — the ~15 action types currently defined across `spotme/web/src/net.js` and `spotme/web/src/lib/rooms.js`).
- **Key derivation:** same room secret → same key, deterministically; different secrets → different keys; derivation matches on both peers without any server round-trip.
- **Tamper rejection:** flipping any ciphertext byte, truncating, or substituting the auth tag must throw, not return garbage plaintext (AES-GCM authentication is the point — assert it).
- **Nonce discipline:** no nonce reuse across messages under the same key (generate N messages, assert uniqueness).
- **Wrong-key behavior:** decrypting with another room's key fails cleanly and the failure is surfaced, not swallowed (per the project's no-silent-error rule).

### 3.2 Event replay (P1)

The server appends every persistent action to a per-room `RoomEvent` log (Postgres) and the client replays from its last sequence number on join. Client-side replay logic must be unit-tested with a faked event stream:

- Resume from `seq = N` yields exactly events `N+1 … latest`, in order.
- Duplicate delivery (server re-sends an already-applied event) is idempotent — applying the same event twice changes nothing.
- Out-of-order arrival within a batch is either rejected or reordered — never applied out of order.
- A gap (missing seq) triggers a re-fetch rather than silent skip. This is the offline-delivery guarantee in miniature; a silent gap is the new version of the lost-knock bug.
- Replay of ciphertext events the local key cannot decrypt (e.g., corrupted row) surfaces an explicit error state.

### 3.3 Reducers / store logic (P1)

`spotme/web/src/store.js` and the per-view state transitions:

- Message status transitions: pending → Sent → Read only. There is **no Delivered tier**; a test should assert the state machine cannot express one.
- Edit and delete-for-me / delete-for-everyone transitions, including edit-after-delete rejection.
- Disappearing-message timers: per-chat timer (10s–3mo) and the separate mandatory wheel for private view-once photos — expiry removes content, and a message created before a timer change keeps its original policy.
- Reaction add/remove/replace per emoji.
- Knock lifecycle in `reach.js` (already covered — keep `requests.test.js` green against the new transport).

### 3.4 Backend service units (P1)

Jest specs colocated with each module under `spotme/backend/src/`:

- `auth/` — guest auth: `POST /auth/guest` issues a JWT bound to the device-generated id; username uniqueness against the `User` table (this replaces the Vercel Blob registry).
- `chat-requests/` — the NEARBY-only accept gate: nearby-mode requests require accept; meet/invite knocks do not.
- `chat/chat.service.ts` — RoomEvent append assigns strictly increasing per-room sequence numbers; ephemeral actions (typing, call signalling, live location, RTC negotiation) are relayed and **never persisted**.
- `moderation/`, `groups/`, `stories/`, `users/` — service-level rules (report retention, group membership on invite-link join, presence as a single overwritten row with no location history).

Prisma is mocked at the service boundary for unit specs; real-database behavior belongs to the integration layer.

---

## 4. Integration tests — gateway protocol against real Postgres (P1)

The seam that matters most is `spotme/backend/src/chat/chat.gateway.ts` (Socket.IO `/rooms` namespace) plus Prisma against a **real Postgres** — the same Docker Postgres setup already used for the 2026-07-26 verification. Supertest-style HTTP tests cover the REST controllers; a real `socket.io-client` covers the gateway. No mocked database: schema constraints (unique usernames, per-room seq ordering, cascade rules in `spotme/backend/prisma/`) are part of what is under test.

Core scenarios (each is a Jest spec spinning up the Nest app via `@nestjs/testing` with a test database):

1. **Join + replay:** client A appends 5 events, disconnects; client B joins with `seq = 2` and receives exactly events 3–5. Restart the gateway between append and replay to prove durability, not in-memory echo.
2. **Offline delivery:** A sends while B is disconnected; B reconnects and receives the backlog. This is the headline improvement over the P2P transport — it gets the headline test.
3. **Durable knock:** knock appended while recipient offline; recipient's next join delivers it; acknowledgment clears it. (Mirror of `requests.test.js`, now against the real server.)
4. **Ephemeral non-persistence:** send typing/call-signal/live-location actions, then query `RoomEvent` directly — zero rows. A regression here is a privacy leak (live location history), not a functional bug.
5. **Auth enforcement:** socket connection without a valid guest JWT is refused; a JWT for user X cannot join or replay a room X has no membership in.
6. **Server blindness (see also Section 6):** after a full conversation, every persisted `cipherText` column is verified to be non-plaintext (entropy/marker check) and the room secret appears nowhere in the database.
7. **Accept gate:** NEARBY chat-request flow via `chat-requests` REST + gateway events, including decline and block.
8. **Media slice protocol over the socket:** 128KB slice/ack sequence completes; a dropped slice is re-requested; interleaved text is not blocked behind a transfer (the `media.test.js` properties re-proven server-side).

**Environment:** `docker compose` Postgres service; `prisma migrate deploy` before the suite; database truncated between specs. Runs locally and in CI identically.

---

## 5. End-to-end tests — Playwright two-context flows (P1 core, P2 breadth)

Playwright is the automation of the two-browser ritual: one Chromium instance, **two independent browser contexts** (two storage states = two devices), both driving the real Vite-built web app against a real backend + Postgres. Playwright is not currently a repo dependency; it is added under `spotme/web` as a devDependency with specs in `spotme/web/e2e/`.

P1 flows (in priority order):

1. **Knock → chat:** context A creates an invite link (meet mode), context B opens it, knock lands, chat opens on both sides with no accept gate; A sends text, B sees it; B's read flips A's tick to Read (and never to a Delivered state, which does not exist).
2. **Offline delivery:** B closes its page; A sends; B reopens and the message appears from replay. This E2E-proves the RoomEvent path through the actual client.
3. **Media:** A sends a photo (>1 slice); B receives and renders it; chat remains responsive during transfer; a private view-once photo enforces the mandatory timer wheel and disappears after viewing. **The video persistence bug that was P0 in the P2P transport must get a dedicated spec** — send video, receiver reloads, video still loads. It is believed fixed by server persistence but is unverified until this test passes.
4. **Calls (signalling-level):** A initiates a voice call, B sees the incoming UI, accepts; connection state reaches connected using Playwright's fake media device flags (`--use-fake-ui-for-media-stream`, `--use-fake-device-for-media-stream`). Media *quality* is out of scope for E2E; media *path* (peer-to-peer, never through the server) is asserted in Section 6. Decline and hang-up paths included.
5. **Translation split-bubble:** message in language X renders original + translation both visible (never a toggle), with the translate API stubbed at the network layer for determinism.

P2 additions: group flows (invite link carries group name), stories posting (once un-deferred from native), settings surfaces (ghost mode, last-seen, blocked list), disappearing-timer expiry, transliteration input, reduced-motion assertions, and the native app track (Capacitor build smoke via emulator).

Screenshots are captured at each assertion point (`expect(page).toHaveScreenshot` or explicit `page.screenshot`) and uploaded as CI artifacts — automation inherits the evidence habit, not just the checks.

---

## 6. Security tests (P1 baseline, P2 depth)

Security-relevant code paths get explicit tests, run in CI like any other suite:

**P1:**
- **Server-blindness suite** (the privacy promise as a test): after scripted conversations, assert (a) no plaintext message content in any `RoomEvent`/`Message` row, (b) room secrets absent from the database, server logs, and every request URL/body captured by a logging middleware in test mode (secrets travel only in URL *fragments*, which never reach the server), (c) WebRTC call media flows peer-to-peer — assert no media-sized payloads traverse the socket during an active call.
- **AuthZ matrix:** every REST controller (`chat`, `chat-requests`, `groups`, `stories`, `users`, `moderation`, `admin`, `audit`) tested with: no token, valid token/wrong user, valid token/right user. Admin/Employee endpoints reject non-staff JWTs.
- **Input validation:** `class-validator` DTOs (`spotme/backend/src/chat-requests/dto/` and siblings) rejected-input tests — oversized payloads, wrong types, injection strings. Validation failures must return clean errors, not stack traces.
- **Crypto negative tests:** the tamper/wrong-key/nonce assertions of Section 3.1.
- **Known-gap regression markers:** the knock payload is currently server-readable (it contains the room secret). A test documents this as *expected current behavior* with a P2 marker — when Phase 2 encrypts knocks to the recipient `publicKey` (field already in the Prisma schema), the test flips to asserting the opposite. Encoding known gaps as tests keeps them from being silently forgotten.

**P2:**
- Rate-limiting tests on auth, knock, and report endpoints.
- Dependency and image scanning in CI (Trivy, per the Phase 2 stack plan).
- Signal-protocol double-ratchet upgrade gets its own vectored test suite when built.
- Third-party pen test before native GA is a P2 budget line, not a P1 pretense.

The cloned-voice pipeline sends plaintext audio to the vendor (`api/voice`); no test can fix that — it is a documented data-flow exposure handled in the privacy/compliance doc. Tests here only assert the feature is opt-in and clearly labeled in the UI.

---

## 7. The live-verification ritual (all phases)

Automated suites prove properties; the ritual proves the product. It is retained as a release gate:

1. **Two real browser contexts** (or two physical devices for native), driving the deployed build — not localhost-only, once the prod deployment is restored (currently 404; re-deploy is a P1 prerequisite for ritual runs against prod).
2. **The canonical pass:** discovery/invite → knock → chat both directions → translation split-bubble → photo → read receipts → disappearing timer → call connect/hang-up.
3. **Screenshot evidence at the proving moment**, saved with the session record. A claim without a screenshot is treated as unverified.
4. **Honesty check:** anything that only works cooperatively (both clients must be this app) or approximately (~distances) is verified to *say so* in the UI.
5. **Never claim from the brief:** a feature marked working in a previous session's notes is re-verified before being claimed again — records are not live checks.

The ritual runs: before any production deploy (P1), on each release candidate (P2), and as a scheduled synthetic check against production (P2, automated Playwright against prod with alerting).

---

## 8. Load tests (P2)

Meaningful once the server transport is the live path and before the 100K-user phase. Single-node NestJS + Socket.IO limits are measured, not guessed:

- **Connection ramp:** sustained Socket.IO connections on one node (tool: Artillery with the `socket.io` engine, or k6 WebSockets) — find the connection ceiling and the JWT-handshake cost.
- **Fanout:** one room with N members; measure append→delivery latency at p50/p95 as N grows. Repeat for M rooms × small membership (the realistic proximity-chat shape).
- **Replay storm:** mass reconnect (deploy restart simulation) — all clients replaying simultaneously against Postgres; measures the RoomEvent read path and informs the P2 Redis adapter decision with data.
- **Media path:** concurrent slice transfers vs. text latency (the starvation property at scale).

Numbers from these runs — not assumptions — trigger the P2 adoptions (Redis socket.io adapter, NATS/Kafka fanout, presence in Redis). P3 load work (multi-region, Go/Rust hot paths, k6 at millions of connections) is out of scope until P2 metrics demand it.

---

## 9. Coverage targets

- **80% line/branch coverage on backend services and the transport layer.** Concretely: `spotme/backend/src/**` (services, gateway, controllers; generated Prisma client excluded) via `jest --coverage` with `coverageThreshold` set in the Jest config so CI fails below the bar; and the web transport modules — `spotme/web/src/lib/socket-transport.js` (including its crypto), `spotme/web/src/lib/reach.js`, `spotme/web/src/lib/rooms.js` — via `c8` wrapping the Node test runner.
- UI view code (`spotme/web/src/views/`) has **no numeric coverage target**; it is covered by Playwright flows and the ritual. Chasing line coverage on DOM glue produces brittle tests, not safety.
- Coverage is a floor, not a goal: the property suites of Sections 3–6 are the actual safety, and a PR that adds coverage while deleting a property assertion fails review.

---

## 10. CI — GitHub Actions

### 10.1 What actually runs today

`.github/workflows/ci.yml` exists and runs on every pull request and every push
to `master`. **Both jobs must be green to merge; no step is
`continue-on-error`, so a failure blocks rather than reports.**

| Job | Steps, in order |
|---|---|
| **backend** | `npm ci` → `prisma db push` against a `postgres:16` **service container** → `tsc --noEmit` → `nest build` → `jest` |
| **web** | `npm ci` → `eslint .` → `vite build` → the suite chain |

Ordered cheapest-first so an obvious break fails in seconds rather than minutes.

### 10.2 The same commands, locally

Run these before pushing; CI runs nothing else.

```bash
# web — lint, build, test
cd spotme/web
npm ci
npm run lint        # eslint . — correctness rules only, see eslint.config.mjs
npm run build
npm test

# backend — typecheck, build, test. Needs a Postgres.
cd spotme/backend
npm ci
export DATABASE_URL='postgresql://postgres@localhost:5432/spotme_test?schema=public'
npx prisma db push --skip-generate --accept-data-loss
npx tsc --noEmit
npm run build
npm test
```

**The backend suite requires a database.** Without one, every DB-backed test
fails with `PrismaClientInitializationError` — that is a missing dependency, not
a broken test, and it must not be mistaken for a baseline. With Postgres the
suite is fully green.

### 10.3 The lint gate

`npm run lint` is **correctness-only** — no stylistic rules, so nothing it
reports can be satisfied by reformatting. Verified to exit non-zero on a
deliberate violation (both `no-undef` and `no-unused-vars`) and zero on a clean
tree.

**There is no type-check gate for `web`.** It is plain ESM JavaScript with JSDoc
in a small minority of files; `tsc --allowJs --checkJs` reports over 1,600
errors, so adopting it would require mass annotation or blanket suppression.
The backend *is* type-checked. This asymmetry is deliberate and recorded in
`10-PRIORITY-0-AUDIT.md` §6.

### 10.4 Storage integration — two stages, on purpose

`test/s3-integration.spec.ts` drives `S3StorageAdapter` against a **real
S3-protocol server, moving real bytes**. `storage.spec.ts` exercises the same
adapter against a mocked SDK, which proves it issues the right commands and
proves nothing about a server accepting them.

| Stage | Where | Runs |
|---|---|---|
| **1 — MinIO** | `ci.yml`, started as a job step | Every PR, automatically, no external credentials |
| **2 — Cloudflare R2** | `r2-smoke.yml` | **Manually only**, gated on the `r2-staging` environment |

**Why both.** MinIO proves the protocol against a server that verifies
signatures. It does not prove *Cloudflare R2* accepts the same requests — R2 has
its own behaviour around path-style addressing, presigned query parameters and
error bodies, and "works against an S3-compatible server" is not the same claim
as "works against the provider we ship on".

**Why not R2 on every PR.** It needs real credentials against a real bucket, and
running that from an untrusted pull request would expose them to anyone who can
open one.

**Why MinIO is a step rather than a service container.** The official
`minio/minio` image needs `server /data` as its command, and Actions service
containers cannot specify one. A step also lets readiness be waited for
explicitly. The bucket is then created by `scripts/s3-ensure-bucket.mjs` —
`S3StorageAdapter` has no bucket-creation path and should not grow one, because
the R2 credentials the same suite runs under in stage 2 are deliberately
least-privilege and cannot create buckets.

**Why MinIO and not a lighter emulator — the subtle part.** Not every
S3-compatible server verifies signatures. `s3rver`, the obvious local stand-in,
**serves completely unsigned requests with 200** — measured, not assumed. On
such a server the two authorization assertions cannot fail, so running them
would report a green authorization test against a server that has no
authorization. The suite therefore probes the endpoint first and prints
`NOT EXERCISED` per test rather than passing them vacuously. MinIO and R2 both
verify, which is the entire reason those two are the servers used.

**The suite SKIPS LOUDLY when `S3_ENDPOINT` is unset**, and the R2 workflow
fails if any secret is missing — because a skipped suite that reports success is
evidence for a run that never happened.

Credentials for stage 2 must be newly rotated, least-privilege, scoped to one
isolated non-production bucket, and stored **only** as GitHub Actions secrets —
never in the repository, in chat, in code, in logs, in PR text or in
documentation. The suite uses a run-unique prefix and deletes what it created;
`scripts/s3-verify-clean.mjs` runs afterwards and fails if anything was left.

**Cleanup is verified in both stages, with `if: always()`.** The same script runs
in CI against MinIO, where nothing is at stake — the container is discarded
seconds later. It runs there so the `afterAll` path is exercised on every pull
request, rather than being trusted until a rare manual R2 run discovers it broke,
which is both the worst place to find out and the place where it has already
leaked. `always()` matters because a failing suite is the case most likely to
have skipped its own cleanup.

**The MinIO image is pinned by digest, not by tag.** `bitnami/minio:latest`
vanishing mid-project is why: CI infrastructure must not change because an
upstream tag moved. Upgrading it is a deliberate edit that CI then re-proves.

**This validates the existing storage seam. It is not authorization to begin the
Priority 2 media migration.**

### 10.5 Benchmarks — not in CI

`spotme/web/test/bench/idb-bench.mjs` drives real Chromium and is run on demand,
not per-PR. See `12-PRIORITY-1-BASELINE.md` for the commands, the baseline, and
its measured noise floor.

### 10.6 The fuller pipeline still to build

**P1 skeleton → P2 full**, the original plan:

| Job | Contents |
|---|---|
| `web-unit` | `cd spotme/web && npm ci && npm test` (the three existing suites + new crypto/replay/reducer suites), `c8` coverage on transport modules |
| `backend-test` | Postgres 16 as a GitHub Actions **service container**; `prisma migrate deploy`; `jest --coverage` (units + the Section 4 integration suite); 80% threshold enforced |
| `build` | `spotme/web`: `vite build`; `spotme/backend`: `nest build` + Docker image build (the existing `spotme/backend/Dockerfile`) |
| `e2e` | Boot backend + Postgres via compose, `vite preview` the web build, run Playwright two-context specs; upload screenshots/traces as artifacts on failure |

**P2 additions:** Trivy image + dependency scan job; load-test job on a schedule (not per-PR); deploy job to Railway/Fly gated on all jobs green; scheduled synthetic Playwright run against production with failure alerting into the existing crash/alert channel; native build lanes (Capacitor/React Native).

**Rules:** no merge to the default branch with a red pipeline; flaky tests are quarantined by name within 24h and fixed or deleted within a week — a flaky suite trains people to ignore red, which is worse than no suite.

---

## 11. Phase summary

| Item | Phase |
|---|---|
| Keep `spotme/web/test/` suites green against the new transport | P1 |
| Crypto layer unit suite (round-trip, tamper, nonce, wrong-key) | P1 |
| Event-replay + reducer unit suites | P1 |
| Backend Jest specs (auth, chat, chat-requests, moderation) — from zero today | P1 |
| Gateway integration suite vs. real Postgres (join/replay, offline, durable knock, ephemeral non-persistence, server blindness) | P1 |
| Playwright two-context E2E: knock, chat, offline delivery, media (incl. video-persistence regression), call signalling | P1 |
| Security baseline: authz matrix, validation rejection, blindness suite, known-gap markers | P1 |
| 80% coverage gates (backend services + transport) in CI | P1 |
| GitHub Actions skeleton (unit, integration, build, E2E) | P1 |
| Restore prod deployment so the ritual can run against prod | P1 (prerequisite) |
| Group/stories/settings E2E breadth; native build lanes | P2 |
| Load tests (connections, fanout, replay storm) driving Redis/queue adoption | P2 |
| Trivy scanning, rate-limit tests, scheduled synthetic prod checks | P2 |
| Encrypted-knock test flip (recipient `publicKey`), double-ratchet vectors, pen test | P2 |
| Multi-region/hot-path load and chaos testing | P3 |

---

## 12. Known gaps this strategy does not paper over

- The backend has **zero automated tests today**; its 2026-07-26 verification was live-manual. Until Section 3.4/4 lands, every backend change is unprotected.
- The **video persistence fix is unverified** — treated as broken until the Section 5 spec passes.
- Push is dormant (5 unset env vars) — `push.test.js` proves token signing, not delivery; delivery testing waits on configuration.
- Call E2E proves signalling and connection, not audio/video quality — quality remains a ritual/manual concern.
- The translation pipeline has 7 open issues; its E2E spec stubs the API and therefore does not cover them.
- Load numbers do not exist yet; every scaling decision before Section 8 runs is provisional.
