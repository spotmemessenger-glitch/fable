# Spot Me — Database Schema

**Document 03 of the platform documentation set.**
Source of truth: `spotme/backend/prisma/schema.prisma` (NestJS 10 + Prisma 5 + PostgreSQL), plus the Phase 1 event-log models (`RoomEvent`, `RoomBlob`) being added for the server-backed transport (`spotme/web/src/lib/socket-transport.js`). This document stands alone; where behavior depends on other code, the real repo path is cited.

Phase tags: **P1** (now — modular monolith, single Postgres), **P2** (100K–10M users — Redis, queues, object storage), **P3** (10M+ — dedicated hot-path services, analytics stores).

---

## 1. Design constraints

These constraints are written into the schema itself (see the header comment in `spotme/backend/prisma/schema.prisma`) and are non-negotiable:

1. **The server never stores message plaintext and never holds a key that can decrypt it.** `Message.cipherText` and `RoomEvent.payload` are opaque ciphertext. Room keys are derived client-side from the room secret, which lives in URL fragments and local storage and is never sent to the server.
2. **No location history.** `Presence` is a single row per user, overwritten on every update. There is no table that accumulates coordinates over time.
3. **Public keys only.** `User.publicKey` is an X25519 public key (base64) used for NaCl box E2E encryption. It is safe to store and hand out; the secret key never leaves the device.
4. **The only plaintext path is user-initiated reporting.** `Report.reportedContent` is attached by the reporter's own client at report time. Nothing is decrypted server-side.
5. **Honest metadata.** The server unavoidably sees metadata (who talks to whom, when, message sizes). The product's "What is actually private" card in Settings states this; the schema must never quietly widen it.

Known deviation (documented, not hidden): knock payloads currently contain the room secret and are server-readable in transit. **P2** encrypts knocks to the recipient's `publicKey` (field already present on `User`).

---

## 2. Enums

Defined in `spotme/backend/prisma/schema.prisma`:

| Enum | Values | Used by |
|---|---|---|
| `Role` | `USER`, `SUPPORT`, `MODERATOR`, `ADMIN`, `OPS` | `User.role`, `Employee.role` |
| `RequestSource` | `NEARBY`, `USERNAME`, `LINK`, `CONTACT`, `BLUETOOTH` | `ChatRequest.source` |
| `RequestStatus` | `PENDING`, `ACCEPTED`, `REJECTED`, `EXPIRED` | `ChatRequest.status` |
| `ReportReason` | `HARASSMENT`, `SPAM`, `CSAM`, `IMPERSONATION`, `OTHER` | `Report.reason` |
| `ReportStatus` | `OPEN`, `ACTIONED`, `DISMISSED`, `ESCALATED_NCMEC` | `Report.status` |
| `Sex` | `MALE`, `FEMALE`, `OTHER`, `UNSPECIFIED` | `User.sex` |

---

## 3. Identity and auth models

### 3.1 `User` — P1

The account record. Spot Me is account-light: no password or phone is required. Guest auth (`POST /auth/guest` with a device-generated id, username, and display name) creates a `User` row and issues a JWT; `selfId` in the web client becomes this stable user id, replacing per-session Trystero peer ids. Usernames move here from the legacy Vercel Blob registry (`spotme/web/api/`).

Key fields:

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (cuid) PK | Stable identity across sessions/devices. |
| `username` | `String @unique` | The `@username` handle used by meet-mode discovery. |
| `email`, `phone` | optional, `@unique` | Only set if the user adds them (OTP channels). |
| `publicKey` | `String?` | X25519 public key, base64. Lookup endpoint hands this out for E2E. |
| `city`, `area`, `age`, `sex` | optional | Self-reported, aggregate analytics only; never joined to a location history (none exists). |
| `ageVerified`, `ageVerifiedAt`, `ageVerifyRef` | | Third-party age verification; only the provider's reference id is stored. Vendor not yet wired (honest constraint). |
| `passwordHash` | `String?` | Unset for OTP-only accounts. |
| `role` | `Role` default `USER` | |
| `deletedAt` | `DateTime?` | Soft-delete marker; a hard-delete job purges after a grace period (§9). |
| `uninstalledAt` | `DateTime?` | Analytics/lifecycle marker. |

Indexes: `@@index([city])`, `@@index([createdAt])`.
Relations: devices, OTP codes, refresh tokens, sent/received chat requests, conversation participations, reports (filed and against), blocks (made and received), presence, install events, groups owned, stories, story views.

### 3.2 `Device` — P1

One row per install. `platform` (`ios | android | web`), optional `pushToken`, `appVersion`, `installedAt`, `lastSeenAt`. Cascade-deletes with the user. Index on `userId`. Push delivery is dormant until the five env vars in `spotme/web/PUSH.md` are set.

### 3.3 `OtpCode` — P1

Hashed one-time codes (`codeHash`, never the code itself), `channel` (`email | sms`), `expiresAt`, `consumedAt`. Index `[userId, expiresAt]` supports the validity check and the expiry sweep (§9).

### 3.4 `RefreshToken` — P1

Hashed refresh tokens (`tokenHash @unique`), optional `deviceId`, `expiresAt`, `revokedAt`. Index on `userId`. Rotation: issue new + revoke old inside one transaction.

### 3.5 `Employee` and `AuditLog` — P1

Staff accounts for `spotme/admin-dashboard` are deliberately a separate table from end users, sharing only the `Role` enum. `AuditLog` records every sensitive dashboard action (`action` strings such as `report.view`, `report.action`, `employee.create`, with `targetType`/`targetId`/`metadata Json?`). Indexes `[employeeId, createdAt]` and `[action, createdAt]` serve the two review paths: "what did this employee do" and "who performed this action class." This is the accountability control GDPR expects in exchange for any staff access to user-adjacent data.

---

## 4. Presence and lifecycle models

### 4.1 `Presence` — P1

One row per user (`userId` is the PK), overwritten on every update: `lat`, `lon` (nullable), `ghost` flag (ghost mode hides the user from nearby discovery), `updatedAt`. This is the **entire** location footprint the server keeps. Nearby/map discovery reads live rows only.

**P2:** presence moves to Redis (hot path, TTL-expired keys) with Postgres as the durable fallback snapshot. **P3:** dedicated presence service (Go/Rust) per the target stack in `SpotMe_Complete_Tech_Stack_2026.md`.

### 4.2 `InstallEvent` — P1

Append-only lifecycle analytics: `kind` (`install | uninstall | first_open`), `platform`, coarse `city` (IP or self-reported at signup — never GPS-derived), `ts`. `userId` is nullable with `onDelete: SetNull` so analytics survive account deletion without identifying anyone. Index `[kind, ts]`.

### 4.3 `HealthSample` and `CrashReport` — P1

`HealthSample` is the zero-dependency ops floor polled by the admin dashboard (`uptimeOk`, `errorCount`, `p95LatencyMs`, indexed on `ts`); Sentry/OpenTelemetry layer on top in **P2**. `CrashReport` groups crashes by `signature` (top stack frame or error message), indexed `[signature, ts]`; the ybot crash bridge consumes the same shape.

---

## 5. Conversation models

### 5.1 `Conversation` and `ConversationParticipant` — P1

`Conversation` is the minimal container: `kind` (`dm | group`), optional `title`, `createdAt`. `ConversationParticipant` is the membership row: `joinedAt`, `archived` (per-user archive, matching the swipe-archive UX), `lastReadAt` (read-receipt watermark). Unique `[conversationId, userId]`, index on `userId` (the "my chats" list query).

### 5.2 `Group` — P1

A metadata layer on top of a `kind:"group"` conversation: `name`, `avatarUrl`, `ownerId`, unique `conversationId`. Membership is just `ConversationParticipant` rows — there is no separate member table, so the existing chat gateway/history/read-receipt code, which already fans a message out to every participant, works for groups with zero changes (see the comment in the schema). Group invite links carry the group name (product requirement).

### 5.3 `Message` — P1

Ciphertext plus minimal metadata:

| Field | Notes |
|---|---|
| `cipherText` | Base64 NaCl box ciphertext, opaque to the server. |
| `nonce` | Base64 box nonce — public by design, not secret. |
| `mediaKey` | R2 object key; the object itself is encrypted client-side before upload. |
| `kind` | `text | image | voice | video | file | location`. |
| `ttlSeconds`, `expiresAt` | Disappearing-message support, mirroring the app's per-chat timer (10s–3mo) and the mandatory wheel for private photos. |
| `sentAt` | Server receive time. |

Index `[conversationId, sentAt]` — the only read path is "messages in this conversation, in order."

### 5.4 `ChatRequest` — P1

The accept-gate model. `source` (`RequestSource`) records how contact happened; only `NEARBY` requests use the accept gate — the web app's knock flow (`spotme/web/src/lib/reach.js`) opens the chat on both sides with no gate, which maps to auto-accepted requests. `status`, `greeting`, optional linked `conversationId` (unique, `SetNull` on conversation delete), `respondedAt`, `expiresAt` (expiry sweep, §9). Indexes `[toUserId, status]` (inbox) and `[fromUserId, status]` (outbox).

### 5.5 `Story` and `StoryView` — P1

24-hour-expiry stories. `kind` is `text | photo`, but **photo stays unwired until the R2 upload pipeline exists** — `mediaKey` remains unpopulated rather than faking a photo path with no storage behind it (see the schema comment and the backend README). `expiresAt` is indexed for the TTL sweep; `[authorId, createdAt]` serves the author's story ring. `StoryView` is unique per `[storyId, viewerId]`. The web app currently ships the rings UI with posting deferred to native.

---

## 6. Trust and safety models

### 6.1 `Report` — P1

The moderation intake. `reason` (`ReportReason`), `status` (`ReportStatus`), `reportedContent` (plaintext supplied by the reporter's client — the only readable-content path in the system), `contextNote`, resolution fields, and the NCMEC block:

- `retainUntil` — 18 U.S.C. § 2258A requires preserving reported material and metadata for 90 days (180 if law enforcement requests). Enforced by the retention job (§9), not by hand.
- `ncmecReportedAt`, `ncmecReportId` — set when escalated. The NCMEC pipeline needs a real API key before user media ships (honest constraint).

Indexes `[status, createdAt]` (moderation queue) and `[reportedUserId]` (pattern-of-abuse lookup).

### 6.2 `Block` — P1

`blockerId`/`blockedId`, unique pair. Enforced at the gateway: blocked users cannot knock, message, or see the blocker in nearby discovery.

---

## 7. Event-log models (added tonight) — P1

These two models are the persistence layer behind the server-backed transport. `spotme/web/src/lib/socket-transport.js` exports the same `joinRoom`/`selfId` surface as Trystero 0.25, so `spotme/web/src/net.js` (263 lines), `reach.js`, and `rooms.js` keep working unchanged; rooms become Socket.IO rooms on the NestJS backend (`/rooms` namespace).

### 7.1 `RoomEvent`

Per-room **append-only** log. Every persistent action a client sends is appended here and broadcast; on join, the client sends its last seen `seq` and the server replays everything after it — this is what turns the P2P prototype's "both online or nothing" into true offline delivery and durable knocks.

```prisma
model RoomEvent {
  seq       BigInt   @id @default(autoincrement()) // global, monotonic
  roomId    String   // opaque room identifier (hash of the room name, not the secret)
  senderId  String   // User.id of the author
  action    String   // action type: msg | react | del | edit | read | seen | profile | knock | knockAck | bin
  payload   String   // AES-GCM ciphertext, base64 — key derived client-side from the room secret
  createdAt DateTime @default(now())
  expiresAt DateTime? // set for disappearing content; TTL sweep deletes past-due rows

  @@index([roomId, seq])
  @@index([expiresAt])
}
```

Design decisions:

- **Global autoincrement `seq`, indexed per room.** A single `BIGINT` sequence is simpler and faster than a per-room counter (no per-room lock, no gap bookkeeping). Clients only ever compare `seq` values *within* one room, so global monotonicity is sufficient; `@@index([roomId, seq])` makes the replay query (`WHERE roomId = ? AND seq > ? ORDER BY seq`) an index range scan.
- **Ciphertext only.** `payload` is AES-GCM-encrypted client-side with a key derived from the room secret. The secret travels in URL fragments/local storage and never reaches the server, preserving the privacy promise in §1. The server can route and store but not read.
- **Append-only.** Edits and deletes are new events (`edit`, `del` tombstones), exactly as the P2P protocol already models them in `spotme/web/src/net.js`. The log is never updated in place; "delete for everyone" appends a tombstone that clients apply, and the original row is physically removed only by the TTL/retention sweeps (§9).
- **`roomId` is not a foreign key** in P1. Rooms are client-named (secret-derived); they do not need a `Conversation` row to exist. The `Conversation`/`Message` models (§5) remain the account-backed track used by the NestJS chat gateway; the event log is the transport-compatible track. Converging them is a **P2** decision, made deliberately rather than forced by a constraint tonight.

### 7.2 `RoomBlob`

Media bodies, kept out of the event log so replay stays cheap. The P2P transport moved media as 128 KB slices with per-slice acks (`bin`/`binack` in `spotme/web/src/net.js`) because that was a transport-truncation fix; server-side, the slices are reassembled into one ciphertext blob and the corresponding `RoomEvent` carries only the blob reference.

```prisma
model RoomBlob {
  id        String   @id @default(cuid())
  roomId    String
  senderId  String
  bytes     Bytes    // ciphertext blob (client-encrypted before upload)
  size      Int      // ciphertext size in bytes
  mime      String?  // declared type; server never inspects content
  createdAt DateTime @default(now())
  expiresAt DateTime? // follows the referencing event's TTL

  @@index([roomId, createdAt])
  @@index([expiresAt])
}
```

- **P1:** blobs live in Postgres (`Bytes`). This is deliberately the lazy correct choice for one developer on Railway/Fly-class hosting — one datastore, one backup, transactional with the event row.
- **P2:** blob bodies move to Cloudflare R2 (chosen over S3 for egress cost, per `spotme/docs` architecture notes and the media-transfer analysis); `RoomBlob` shrinks to a metadata row holding the R2 object key, matching how `Message.mediaKey` already works. The event-log API does not change.
- Server-side persistence is also what fixes the P0 "video kills chat" class of bug from the P2P transport — but that must be **re-verified** against the new transport, not assumed fixed.

### 7.3 Ephemeral vs. persistent actions

The action inventory comes from the real P2P surface: `spotme/web/src/net.js` (msg, react, profile, history, bin, binack, fetch, call, locup, del, edit, typing, read, seen), `spotme/web/src/lib/reach.js` (knock, knockAck), `spotme/web/src/lib/discovery.js` (hello).

| Action | Source file | Class | Server behavior |
|---|---|---|---|
| `msg` | `web/src/net.js` | Persistent | Append `RoomEvent`, broadcast, replay on join. |
| `react` | `web/src/net.js` | Persistent | Append + broadcast. |
| `edit` | `web/src/net.js` | Persistent | Append (new event referencing the original), broadcast. |
| `del` | `web/src/net.js` | Persistent | Append tombstone, broadcast; clients hide the original. |
| `read` | `web/src/net.js` | Persistent | Append + broadcast — read receipts must survive offline gaps (product ships Sent + Read only; there is deliberately no Delivered tier). |
| `seen` | `web/src/net.js` | Persistent | Append + broadcast (view-once opened — must be durable). |
| `profile` | `web/src/net.js` | Persistent | Append + broadcast; clients keep the latest. |
| `bin` / `binack` | `web/src/net.js` | Persistent (as `RoomBlob`) | Slices reassembled server-side into a `RoomBlob`; one `RoomEvent` references it. Acks are transport-level, not logged. |
| `knock` / `knockAck` | `web/src/lib/reach.js` | Persistent | Appended to the recipient's personal inbox room — durable knocks replace the Upstash knock relay in `spotme/web/api/`. |
| `typing` | `web/src/net.js` | Ephemeral | Relay to room members, never stored (4s client-side expiry in `web/src/lib/rooms.js`). |
| `call` | `web/src/net.js` | Ephemeral | WebRTC signalling relay only. **Call media never touches the server** — calls stay peer-to-peer via Cloudflare TURN (`spotme/web/api/turn`). |
| `locup` | `web/src/net.js` | Ephemeral | Live-location relay, never stored — storing it would create the location history §1 forbids. |
| `hello` | `web/src/lib/discovery.js` | Ephemeral | Nearby-discovery presence ping; superseded server-side by `Presence` (§4.1). |
| `history` / `fetch` | `web/src/net.js` | Superseded | Peer-to-peer backfill protocol; the server replay-from-`seq` path replaces it. Kept in the client for P2P fallback, never persisted. |

The rule of thumb encoded here: **an action is persistent iff a user who was offline when it happened would notice its absence.** Everything else is relay-only.

---

## 8. Read paths

The queries the schema is shaped around, in rough order of frequency:

| Read path | Query shape | Index used | Phase |
|---|---|---|---|
| Room replay on join | `RoomEvent WHERE roomId = ? AND seq > :lastSeq ORDER BY seq LIMIT n` | `[roomId, seq]` | P1 |
| Live fanout | No query — Socket.IO broadcast to the `/rooms` namespace room; DB write happens first for persistent actions | — | P1 |
| Chat list | `ConversationParticipant WHERE userId = ?` joined to conversations | `[userId]` | P1 |
| Conversation history | `Message WHERE conversationId = ? ORDER BY sentAt DESC LIMIT n` (keyset pagination on `sentAt`, never OFFSET) | `[conversationId, sentAt]` | P1 |
| Nearby discovery | `Presence` rows within a bounding box, `ghost = false` | PK scan; **P2** adds a geospatial strategy (Redis GEO or PostGIS) when row counts justify it | P1→P2 |
| Username lookup | `User WHERE username = ?` | `@unique` | P1 |
| Public-key lookup | `User.publicKey` by id/username | PK / `@unique` | P1 |
| Knock inbox | Replay of the personal inbox room (same path as room replay) | `[roomId, seq]` | P1 |
| Moderation queue | `Report WHERE status = 'OPEN' ORDER BY createdAt` | `[status, createdAt]` | P1 |
| Audit review | `AuditLog` by employee or action class | `[employeeId, createdAt]`, `[action, createdAt]` | P1 |
| Story rings | `Story WHERE authorId IN (contacts) AND expiresAt > now()` | `[authorId, createdAt]` | P1 |
| Crash triage | `CrashReport GROUP BY signature` over a window | `[signature, ts]` | P1 |
| Blob fetch | `RoomBlob WHERE id = ?` on demand (lazy — clients fetch blobs referenced by replayed events, not during replay) | PK | P1 |

Replay responses are paginated (bounded `LIMIT`, client asks again from the new high-water mark) so a device offline for months cannot make the server assemble an unbounded result set.

---

## 9. Retention, TTL jobs, and deletion

All retention is enforced by scheduled jobs, not by hand. **P1** runs these as NestJS `@Cron` tasks inside the monolith; **P2** moves them to a queue worker (BullMQ on Redis) so a slow sweep cannot block the API.

| Job | Target | Rule | Phase |
|---|---|---|---|
| Disappearing-content sweep | `RoomEvent`, `RoomBlob`, `Message` | Delete rows where `expiresAt < now()`. Runs frequently; the `[expiresAt]` indexes make it a range delete. | P1 |
| Story expiry | `Story` (+ cascaded `StoryView`) | Delete where `expiresAt < now()` (24h TTL). | P1 |
| Event-log horizon | `RoomEvent` | Even non-disappearing events get a maximum retention horizon once delivered to all known devices — the log is a delivery buffer, not an archive; clients hold their own history locally. Horizon length is a product/ops decision to be set explicitly, not silently unlimited. | P1 |
| Blob orphan sweep | `RoomBlob` | Delete blobs whose referencing events are gone. | P1 |
| OTP / token expiry | `OtpCode`, `RefreshToken` | Delete expired/consumed codes and expired/revoked tokens. | P1 |
| ChatRequest expiry | `ChatRequest` | `PENDING` past `expiresAt` → `EXPIRED` (kept briefly for UX, then deleted). | P1 |
| Account hard-delete | `User` + cascades | `deletedAt` set → grace period → hard delete. Prisma `onDelete: Cascade` clears devices, tokens, participants, presence, blocks, stories; `InstallEvent` survives via `SetNull`. `RoomEvent` rows by the deleted sender remain (they are undecryptable ciphertext in other people's rooms) — the same posture as any E2E messenger. | P1 |
| Report retention | `Report` | **Opposite direction:** rows must NOT be deleted before `retainUntil` (90/180 days, 18 U.S.C. § 2258A). Account hard-delete must not cascade through open reports — the reported-content copy is preserved for the legal window. | P1 |
| Presence staleness | `Presence` | Rows older than a freshness window are treated as offline by queries; no delete needed (one row per user). | P1 |

---

## 10. Partitioning and scale-out strategy

The honest sequencing for a one-developer, budget-conscious project: **do nothing clever until the numbers demand it**, but shape the schema tonight so the clever thing is possible without a rewrite. `RoomEvent` already has the two properties partitioning needs: an append-only monotonic key and every query scoped by `roomId`.

### P1 (now) — single Postgres, no partitions

- One Neon/Railway/Fly-class Postgres instance. Vanilla tables, the indexes listed above, `pg_dump` backups.
- `BigInt` seq means no id-exhaustion ceiling.
- The TTL sweeps (§9) are the growth control: the event log stays bounded because it is a delivery buffer, not an archive.

### P2 (100K–10M) — declarative partitioning + storage split

- **`RoomEvent`: native Postgres range partitioning on `seq`** (fixed-width chunks). Because seq is globally monotonic, chunks fill and freeze in order; the TTL/horizon sweep becomes `DROP PARTITION` on old chunks — instantaneous, no vacuum churn from mass deletes. This is the standard append-only-log treatment and the primary reason `seq` is global rather than per-room. Partition-by-`roomId` (hash) is the alternative if per-room locality dominates, but range-on-seq keeps replay ranges and drops aligned, so it is the default plan.
- **`RoomBlob` bodies move to R2**; the table keeps metadata + object key only. Postgres stops growing with media volume.
- **`Presence` moves to Redis** (GEO sets for nearby queries, TTL for staleness); Postgres keeps a fallback snapshot.
- **Read replicas** for the moderation dashboard and analytics reads, keeping the primary for the socket/write path.
- **`AuditLog`, `InstallEvent`, `CrashReport`, `HealthSample`: monthly range partitions on their timestamp column** once they grow, same drop-old-partitions retention.

### P3 (10M+) — split by service, not by table

- The event log becomes the API of a dedicated fanout service (Go/Rust per `SpotMe_Complete_Tech_Stack_2026.md`), fronted by Kafka/Pulsar; Postgres partitions remain the durable store or are replaced per-service.
- Analytics reads (`InstallEvent`, `CrashReport`, aggregates) move to ClickHouse; Postgres keeps the transactional core.
- Room-sharded Postgres (Citus-style, shard key `roomId`) only if a single primary's write throughput is actually exhausted — measured, not assumed.

---

## 11. Migration notes (tonight's change)

1. Add `RoomEvent` and `RoomBlob` to `spotme/backend/prisma/schema.prisma`; run `prisma migrate dev`. No existing model changes, so the migration is purely additive — zero risk to the verified 2026-07-26 backend state.
2. The legacy Vercel serverless pieces being replaced, in order: username registry (Vercel Blob) → `User` table; knock relay (Upstash Redis) → durable knocks in the personal-inbox room's `RoomEvent` log; per-session Trystero ids → `User.id`. The TURN mint (`spotme/web/api/turn`) stays.
3. Re-verify after cutover (nothing is fixed until re-run): video send/receive persistence, replay-after-offline on both DM and knock paths, and disappearing-message deletion actually removing rows.
