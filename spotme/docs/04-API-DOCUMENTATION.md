# Spot Me — API Documentation

**Document 04 of 8 — Platform documentation package**
**Scope:** REST API (NestJS backend + Vercel edge functions) and the Socket.IO realtime protocol.
**Sources of truth:** `spotme/backend/src/**/*.controller.ts`, `spotme/backend/src/chat/chat.gateway.ts`, `spotme/web/api/*.js`, `spotme/web/src/lib/rooms.js`, `spotme/web/src/lib/reach.js`.

Every item is phase-tagged:

| Tag | Meaning |
|-----|---------|
| **P1** | Phase 1 (now): NestJS modular monolith, PostgreSQL, Socket.IO, WebRTC + Cloudflare TURN |
| **P2** | Phase 2 (100K–10M users): Redis adapter, LiveKit SFU, Passkeys/OAuth 2.1, Signal-protocol E2E |
| **P3** | Phase 3 (10M+): Go/Rust hot paths, Kafka/Pulsar backbone, multi-region |

Implementation status is stated honestly per section. Anything marked *in progress* is part of the current Phase 1 migration and must be verified against the code before being relied on.

---

## 1. Overview

Spot Me exposes three API surfaces:

1. **REST API** — NestJS backend (`spotme/backend/src/`). Account, profile, conversations, chat requests, groups, stories, moderation, staff/admin, telemetry ingest. JSON over HTTPS.
2. **Edge functions** — Vercel serverless (`spotme/web/api/`). Stateless utility endpoints the web client calls directly: TURN credential minting, translation/transliteration, username registry, voice clone, knock relay, push. **P1 migration note:** the username registry and knock relay are moving into the backend (User table and `/rooms` event log respectively); the Vercel functions remain documented here because the deployed web client still calls them.
3. **Realtime** — Socket.IO on the NestJS backend. Two namespaces: `/chat` (built and in the repo, `spotme/backend/src/chat/chat.gateway.ts`) and `/rooms` (the Phase 1 room-log transport that replaces the Trystero P2P layer; protocol specified in §6, client adapter at `spotme/web/src/lib/socket-transport.js`).

### Design invariants (product law — apply to every endpoint)

- **The server stores ciphertext, not messages.** Message payloads are AES-GCM-encrypted client-side with a key derived from the room secret. The room secret lives in URL fragments and local storage and is never sent to the server. `Message.cipherText` in the Prisma schema is opaque to the backend.
- **No location history.** Presence is a single overwritten row per user (`backend/prisma/schema.prisma`). Ghost mode suppresses it entirely.
- **No fake states.** Receipts are Sent and Read only — there is deliberately no "Delivered" tier.
- **Call media never touches the server.** Voice/video calls are peer-to-peer WebRTC; the server only relays signalling and mints TURN credentials.

### Known honest constraints

- Knock payloads currently contain the room secret and are therefore server-readable in transit through the relay. **P2** encrypts knocks to the recipient's `publicKey` (field already in the User schema).
- Push is dormant until five environment variables are set (see `spotme/web/PUSH.md`).
- OTP email delivery is not wired to a provider yet; in non-production the code is returned in the response for testing (`auth.controller.ts`).
- The production Vercel deployment currently returns 404 and needs a redeploy.

---

## 2. Authentication

### 2.1 Token model (P1)

All authenticated REST calls use a **JWT bearer token**:

```
Authorization: Bearer <accessToken>
```

Enforced by `JwtAuthGuard` (`backend/src/common/guards/jwt-auth.guard.ts`). The guard resolves the token to an `AuthenticatedPrincipal` (`backend/src/common/decorators/current-user.decorator.ts`), which controllers receive via `@CurrentUser()`. Staff routes use `EmployeeAuthGuard` plus `RolesGuard` with the `@Roles(...)` decorator (`backend/src/common/guards/`, `backend/src/common/enums/role.enum.ts`).

Socket.IO connections authenticate in the **handshake**, not per-message:

```js
const socket = io(`${API_BASE}/rooms`, { auth: { token: accessToken } })
```

The gateway verifies `client.handshake.auth.token` against `JWT_ACCESS_SECRET` and disconnects on failure — see `handleConnection` in `backend/src/chat/chat.gateway.ts`; the `/rooms` gateway uses the same pattern.

### 2.2 Guest auth (P1 — primary path for the web client, in progress tonight)

Spot Me's product promise is *no account, no password, no phone number*. Guest auth honors that: the device generates a stable id locally and trades it for a JWT.

```
POST /auth/guest
Body:    { "id": "<device-generated id>", "username": "priya_c", "name": "Priya" }
Returns: { "accessToken": "<jwt>", "user": { "id", "username", "name", ... } }
```

- `id` is generated on the device and becomes the stable `selfId` used across the realtime protocol (replacing Trystero's per-session ids).
- Usernames move from the Vercel Blob registry (`web/api/username.js`) into the backend `User` table; uniqueness is enforced by the database.
- No password, email, or phone is collected on this path.

### 2.3 Email OTP auth (P1 — built, `backend/src/auth/auth.controller.ts`)

An optional identity-upgrade path (used by the native/backend track):

| Method | Path | Body | Returns |
|--------|------|------|---------|
| POST | `/auth/signup` | `{ username, email, name }` | created user |
| POST | `/auth/otp/request` | `{ email }` | `{ sent: true }` (plus `devCode` outside production — email provider not yet wired) |
| POST | `/auth/otp/verify` | `{ email, code, deviceId, platform }` | token pair |
| POST | `/auth/refresh` | `{ refreshToken }` | new token pair |
| POST | `/auth/employee/login` | `{ email, password }` | staff token (dashboard) |

**P2:** Passkeys / OAuth 2.1 replace OTP as the upgrade path.

### 2.4 Roles (staff RBAC, P1)

`Role` enum: `SUPPORT`, `MODERATOR`, `OPS`, `ADMIN` (`backend/src/common/enums/role.enum.ts`). Route-level scoping is listed per endpoint in §4.7–4.8. Support sees metadata-level queues; content-bearing moderation actions are Moderator+; employee management and the audit log are Admin-only; health telemetry is Ops/Admin.

---

## 3. Conventions

### 3.1 Base URLs

| Surface | Base | Notes |
|---------|------|-------|
| Backend REST | `https://<backend-host>/` | Railway/Fly/Hetzner-class hosting (P1). Local dev: `http://localhost:3000` |
| Edge functions | `https://<vercel-app>/api/` | Same origin as the web app |
| Realtime | `wss://<backend-host>/rooms`, `/chat` | Socket.IO namespaces |

### 3.2 Error envelope (P1)

The backend uses the standard NestJS exception envelope. Clients must treat any non-2xx as this shape:

```json
{
  "statusCode": 404,
  "message": "no user with that username",
  "error": "Not Found"
}
```

- `message` is a string, or an **array of strings** for validation failures (class-validator DTOs in `backend/src/**/dto/`).
- Codes in use: `400` validation, `401` missing/invalid JWT, `403` role/ownership failure, `404` not found, `409` conflict (e.g. username taken), `500` unexpected.
- Edge functions (`web/api/*.js`) return ad-hoc `{ error: "<reason>" }` bodies with appropriate status codes; they predate the backend and will be normalized as each migrates (P1/P2).
- Error messages must never leak other users' data or internal identifiers beyond what the caller already knows.

### 3.3 Realtime acknowledgement convention

Socket.IO events that need a result use the built-in ack callback (`emit(event, payload, cb)`); the ack carries either the result object or `{ error }` in the same envelope spirit as REST.

### 3.4 Rate limiting (plan — not yet implemented in the repo)

| Layer | Mechanism | Phase |
|-------|-----------|-------|
| Edge | Cloudflare / Railway edge rules in front of the backend; primary defense for unauthenticated routes (`/ingest/*`, `/auth/*`). The comment in `backend/src/admin/ingest.controller.ts` records this decision explicitly. | P1 |
| App | `@nestjs/throttler` on auth-sensitive routes: OTP request (per-email + per-IP), guest signup (per-IP), username lookup (per-token), report filing (per-user) | P1 |
| Socket | Per-connection action budget in the `/rooms` gateway (drop + warn, never silent), Redis-backed counters once the Socket.IO Redis adapter lands | P2 |
| Global | API gateway (Envoy) quotas per user/device | P3 |

Until the app layer lands, the honest statement is: **only edge-level limits protect these endpoints.** Do not describe throttling as live in any user-facing material.

---

## 4. REST API — backend (`spotme/backend/src/`)

All routes below require `Authorization: Bearer <jwt>` unless marked otherwise.

### 4.1 Users (`users/users.controller.ts`)

| Method | Path | Body / Query | Returns | Notes |
|--------|------|--------------|---------|-------|
| GET | `/users/me` | — | own profile | |
| PATCH | `/users/me` | `UpdateProfileDto` (name, avatar, languages, visibility fields) | updated profile | |
| POST | `/users/me/presence` | `{ lat?, lon?, ghost? }` | ok | Single overwritten Presence row; `ghost: true` hides the user. No history is kept. |
| POST | `/users/me/uninstall` | — | ok | Marks uninstall for growth metrics |
| DELETE | `/users/me` | — | ok | Soft-deletes the account |
| GET | `/users/lookup?username=<name>` | query | public-safe user record | 404 `no user with that username`. Backs the start-chat-by-username flow in the web app. |

**Username availability & search (P1 migration).** Today the web client uses the Vercel Blob registry:

- `GET /api/username?check=<name>` → `{ available: boolean }`
- `GET /api/username?q=<prefix>` → `{ results: [{ username, id, name }] }` (max 8)
- `POST /api/username` `{ username, id, name, secret }` → `200 { ok: true }` | `409 { error: "taken" }`
- `POST /api/username` `{ op: "release", username, secret }` → `{ ok: true }` (release is gated by a locally-held secret; only its SHA-256 is stored — `web/api/username.js`)

These move to the backend User table under guest auth; `GET /users/lookup` is the first backend equivalent. Until cutover, treat the Blob registry as authoritative for the deployed web client.

### 4.2 Chat — REST side (`chat/chat.controller.ts`)

REST covers listing and history; sending is realtime (§6).

| Method | Path | Query | Returns |
|--------|------|-------|---------|
| GET | `/chat/conversations` | — | conversations for the caller |
| GET | `/chat/conversations/:id` | — | one conversation (participant-checked) |
| GET | `/chat/conversations/:id/messages` | `take?` (page size) | message history — `cipherText` opaque blobs; the server cannot render them |
| POST | `/chat/conversations/:id/read` | — | marks read (Sent + Read only; no Delivered tier) |

### 4.3 Chat requests (`chat-requests/chat-requests.controller.ts`)

The backend track keeps an accept gate **for NEARBY discovery only** (strangers found via map/radar). Meet-mode (username/invite link) chats open with no gate — a knock opens the chat on both sides, matching the live web app.

| Method | Path | Body | Returns |
|--------|------|------|---------|
| POST | `/chat-requests` | `{ toUserId, source, greeting? }` | created request (`source` distinguishes NEARBY from other flows) |
| GET | `/chat-requests/pending` | — | pending requests for the caller |
| POST | `/chat-requests/:id/respond` | `{ accept: boolean }` | resolution; accept creates the conversation |

### 4.4 Groups (`groups/groups.controller.ts`)

Groups are conversations with membership management. Invite links carry the group name (web app behavior).

| Method | Path | Body | Notes |
|--------|------|------|-------|
| POST | `/groups` | `{ name, memberIds }` | creator becomes owner |
| GET | `/groups` | — | caller's groups |
| GET | `/groups/:id` | — | membership-checked |
| POST | `/groups/:id/members` | `{ userId }` | add member |
| DELETE | `/groups/:id/members/:userId` | — | remove member |
| POST | `/groups/:id/leave` | — | self-removal |

**P2:** group calls via LiveKit SFU; group E2E upgrades with the Signal-protocol work.

### 4.5 Stories (`stories/stories.controller.ts`)

Text stories exist in the backend; the web app ships the rings UI with posting deferred to native.

| Method | Path | Body | Notes |
|--------|------|------|-------|
| POST | `/stories` | `{ kind, textContent }` | text kind in P1 |
| GET | `/stories/feed` | — | stories visible to the caller |
| POST | `/stories/:id/view` | — | records a view |
| GET | `/stories/:id/views` | — | owner-only viewer list |
| DELETE | `/stories/:id` | — | owner-only |

**P2:** media stories (requires R2/S3 media pipeline + NCMEC/CSAM scanning, which needs an API key before real media ships).

### 4.6 Moderation — end-user (`moderation/moderation.controller.ts`)

| Method | Path | Body | Notes |
|--------|------|------|-------|
| POST | `/moderation/reports` | `{ reportedUserId, reason, reportedContent?, contextNote? }` | Reported content is provided by the reporter (the server cannot decrypt messages) |
| POST | `/moderation/blocks` | `{ userId }` | block |
| POST | `/moderation/blocks/:userId/remove` | — | unblock |
| GET | `/moderation/blocks` | — | caller's blocked list (backs the Settings screen) |

### 4.7 Moderation — staff queue (`moderation/moderation.controller.ts`, `AdminReportsController`)

Guards: `EmployeeAuthGuard` + `RolesGuard`.

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| GET | `/admin/reports` | Support, Moderator, Admin | queue (Support sees metadata) |
| POST | `/admin/reports/:id/resolve` | Moderator, Admin | `{ resolution }`; audit-logged |
| POST | `/admin/reports/:id/escalate-csam` | Moderator, Admin | NCMEC escalation path with retention (schema support exists; the NCMEC API key is **not** wired yet — required before real media ships) |

### 4.8 Admin & staff (`admin/admin.controller.ts`)

Guards: `EmployeeAuthGuard` + `RolesGuard`. Sensitive actions write to the audit log (`backend/src/audit/audit.service.ts`).

| Method | Path | Roles | Returns |
|--------|------|-------|---------|
| GET | `/admin/growth/installs?days=` | Support, Moderator, Admin | installs over time |
| GET | `/admin/growth/active-users` | Support, Moderator, Admin | DAU/MAU |
| GET | `/admin/growth/demographics` | Support, Moderator, Admin | aggregate demographics |
| GET | `/admin/health/summary?days=` | Ops, Admin | health telemetry summary |
| GET | `/admin/health/crashes` | Ops, Admin | crashes grouped by signature |
| GET | `/admin/audit-log` | Admin | recent audit entries |
| GET | `/admin/employees` | Admin | staff list |
| POST | `/admin/employees` | Admin | `{ email, name, password, role }` → audit-logged |
| PATCH | `/admin/employees/:id/deactivate` | Admin | audit-logged |

### 4.9 Telemetry ingest (`admin/ingest.controller.ts`) — **unauthenticated by design**

A crash can happen before login and an uninstall ping fires during teardown; neither can carry a fresh JWT. Abuse control is delegated to edge rate limiting (§3.4).

| Method | Path | Body |
|--------|------|------|
| POST | `/ingest/crash` | `{ platform, message, signature, appVersion?, stackTrace? }` |
| POST | `/ingest/install-event` | `{ kind, platform, city? }` |

---

## 5. Edge functions (`spotme/web/api/`)

Called directly by the web client. All CORS-open, keys held server-side in env vars.

### 5.1 TURN credentials (`turn.js`) — P1, stays

```
GET /api/turn → { iceServers: [...], relay: true|false }
```

Mints short-lived Cloudflare TURN credentials (6-hour TTL, response cacheable for half that). If `CF_TURN_KEY_ID`/`CF_TURN_TOKEN` are unset or Cloudflare fails, degrades to STUN-only (`relay: false`) rather than failing the connection. A TURN relay forwards encrypted bytes and cannot read call content, but does observe that two addresses are exchanging data. **P2:** self-hosted coturn fleet behind the same response shape.

### 5.2 Translation & transliteration (`translate.js`) — P1, stays

| Call | Body | Returns |
|------|------|---------|
| `POST /api/translate` | `{ q, source?, target }` | `{ text, detected, engine: "google"\|"azure" }` |
| `POST /api/translate?op=translit` | `{ q, lang, toScript, fromScript? }` | `{ text }` (fromScript defaults `Latn`) |
| `POST /api/translate?op=read` | `{ q, hint? }` | `{ lang, script, english }` — one LLM call replacing detect+translit+translate |
| `POST /api/translate?op=detect` | `{ q }` | `{ language, score }` |

Engine order is deliberate: known source → Google then Azure; unknown source → Azure first (its detection handles romanized Indic text such as `ta-Latn`, which Google cannot), then Google. Both engines must fail before the client sees an error. Backs the split-bubble translation and 10-Indian-language transliteration features. Known state: the translation pipeline has 7 open issues (tracked in the repo). **P1 target stack** adds Sarvam/AI4Bharat for Indic languages behind this same interface.

### 5.3 Username registry (`username.js`) — P1, migrating to backend

Documented in §4.1. Being replaced by the backend User table under guest auth.

### 5.4 Voice clone (`voice.js`) — P1, stays with a documented exposure

Proxies voice cloning (~30s sample, one voice per profile) for cloned-voice messages. **Honest constraint:** the audio sample is sent in plaintext to the vendor — a GDPR/BIPA exposure. Mitigation (not marketing): explicit opt-in consent screen before sampling, vendor deletion on profile clear, and the feature is off by default. Do not represent cloned-voice audio as end-to-end encrypted.

### 5.5 Knock relay & push (`knock.js`, `push.js`, `presence.js`) — P1, superseded by `/rooms`

Upstash-Redis-backed durable knock relay and web push for the P2P transport. The `/rooms` event log (§6) makes knocks durable server-side, so these functions are retired at web-client cutover. Push remains **dormant until 5 Vercel env vars are set** (`spotme/web/PUSH.md`); the burned VAPID pair from a screenshot must be regenerated, never reused.

---

## 6. Realtime protocol — Socket.IO

### 6.1 `/chat` namespace (built — `backend/src/chat/chat.gateway.ts`)

The backend-track gateway. Handshake auth per §2.1; on connect the socket joins its own `user:<id>` room (the server-brokered mirror of the web app's "join your own inbox" pattern from `web/src/lib/reach.js`).

| Direction | Event | Payload | Notes |
|-----------|-------|---------|-------|
| client → server | `message:send` | `{ conversationId, cipherText, nonce?, kind?, mediaKey?, ttlSeconds? }` | Persists the ciphertext, fans out to every participant's `user:<id>` room; ack returns the stored message. `ttlSeconds` implements disappearing messages (10s–3mo per-chat timer). |
| server → client | `message:new` | stored message | |
| client → server / server → client | `typing` | `{ conversationId }` / `{ userId }` | ephemeral, never persisted |

### 6.2 `/rooms` namespace (Phase 1 migration — being implemented now)

**Purpose:** a drop-in server-backed replacement for the Trystero WebRTC room API. The client adapter `web/src/lib/socket-transport.js` exports the same `joinRoom`/`selfId` surface that `web/src/lib/net.js` (263 lines) currently wraps, so `rooms.js`, `reach.js`, and `discovery.js` keep working unchanged. `selfId` becomes the stable user id from guest auth instead of a per-session Trystero id.

**Persistence model:** every persistent action is appended to a per-room `RoomEvent` log (PostgreSQL) with a monotonically increasing `seq`. On join, the server replays events after the client's last seen `seq` — this is what turns the P2P prototype into true offline delivery and durable knocks, and is the fix for the P0 "photo/video kills chat" persistence bug of the P2P transport (fixed by design here; **must be re-verified live** before being claimed).

**Privacy model:** action payloads are AES-GCM-encrypted client-side with a key derived from the room secret; the secret travels only in URL fragments/local storage. The server stores and replays ciphertext it cannot read. (Exception, stated honestly: knock payloads currently include the room secret and are server-readable; P2 encrypts them to the recipient's `publicKey`.)

#### Client → server events

| Event | Payload | Ack / effect |
|-------|---------|--------------|
| `join` | `{ roomId, sinceSeq }` | Ack `{ peers: [<selfId>...], events: [<RoomEvent>...] }` — current occupants plus every persistent event with `seq > sinceSeq`, in order. Socket joins the Socket.IO room. `sinceSeq: 0` replays the full room log. |
| `action` | `{ roomId, type, cipher, meta?, target? }` | Persistent types: append to the `RoomEvent` log (assigning `seq`), then broadcast to the room. Ephemeral types: broadcast only, never stored. `target` (a `selfId`) restricts delivery to one peer — used for directed acks, history serving, and RTC signalling. `cipher` is the AES-GCM payload; `meta` is the small unencrypted routing envelope (action type, media slice counters). |
| `leave` | `{ roomId }` | Leaves the room; peers get `peer:leave`. |

#### Server → client events

| Event | Payload | Notes |
|-------|---------|-------|
| `peer:join` | `{ roomId, peerId }` | A peer joined (maps to Trystero's `onPeerJoin`) |
| `peer:leave` | `{ roomId, peerId }` | Maps to `onPeerLeave` |
| `action` | `{ roomId, type, cipher, meta?, from, seq? }` | Relayed action; `seq` present only on persistent events |

#### Action types (carried over from the P2P protocol in `web/src/lib/rooms.js` / `reach.js`)

| Class | Types | Persisted? |
|-------|-------|-----------|
| Messaging | `msg`, `react`, `del`, `edit`, `read`, `seen` | Yes |
| Profile/state | `profile`, `history` | Yes |
| Media transfer | `bin`, `binack`, `fetch` | `bin` yes; `binack`/`fetch` ephemeral |
| Knock protocol | `knock`, `knockAck` | Yes (durable knocks) |
| Ephemeral | `typing`, `locup` (live location), `call` (+ RTC negotiation) | No — relay only |

#### Binary media slices

Media (photos, private view-once photos, video, voice notes, documents) is encrypted client-side and sent as **128 KB slices** (`SLICE_BYTES = 128 * 1024`, `web/src/lib/rooms.js:43`) as `bin` actions, each acknowledged with `binack`. A receiver that detects a gap (or joins late) issues `fetch` to request retransmission — against the server log now, rather than a peer that may have gone offline. The slicing+ack design is what fixed the 2026-07-26 transport-truncation bug and is retained unchanged over the socket transport.

#### RTC signalling relay

Calls remain **peer-to-peer WebRTC — media never touches the server.** The `/rooms` socket replaces Trystero as the signalling channel only: SDP offers/answers and ICE candidates travel as ephemeral, `target`-directed `call` actions. ICE servers come from `GET /api/turn` (§5.1). Call flow (offer, ringing, accept, decline/busy, end, PiP, mute) is unchanged from the live web app.

#### Reconnection contract

Clients persist the highest `seq` seen per room. On reconnect: `join {roomId, sinceSeq}` → gap replay → resume. There is no server-side session to expire; the JWT in the handshake is the only credential.

### 6.3 Scaling phases for realtime

| Phase | Change |
|-------|--------|
| P1 | Single-node Socket.IO on the NestJS monolith; Postgres `RoomEvent` log |
| P2 | Redis 8 Socket.IO adapter (multi-node fanout), Redis presence, NATS/Kafka for cross-service fanout, LiveKit SFU for group calls |
| P3 | Dedicated Go/Rust presence + fanout services, Kafka/Pulsar event backbone, CRDT-style sync for multi-device |

---

## 7. Cross-cutting notes for client implementers

- **Never send plaintext message content to any backend endpoint.** The only sanctioned plaintext paths are the translation proxy (§5.2, user-visible text the user explicitly asked to translate) and the voice-clone sample (§5.4, explicit opt-in with a documented exposure).
- **Validate at the boundary.** Backend DTOs (`backend/src/**/dto/`) are the contract; the Phase 1 target stack standardizes on Zod-style schema validation for new surfaces.
- **Do not invent states.** If the server has not confirmed something (message persisted, knock delivered, push subscribed), the UI must not claim it. This is enforced product law (Sent/Read only, "What is actually private" honesty card, real notification-permission readouts).
- **Version note:** there is no `/v1` prefix yet. Introducing one is deferred until the first breaking change after the web client cutover (P2 at the earliest); until then, additive changes only.

---

*This document describes the API as of the Phase 1 migration. Sections marked "in progress" (guest auth, the `/rooms` namespace, username migration) specify the protocol being implemented and must be checked against `spotme/backend/src/` and `spotme/web/src/lib/socket-transport.js` before external use.*
