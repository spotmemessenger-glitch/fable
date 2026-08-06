# Spot Me — Security Plan

Document 07 of the platform document set. Covers the threat model, encryption
design, authentication/authorization, rate limiting, abuse handling, audit
logging, secrets management, and incident response for Spot Me Messenger as it
migrates from the P2P prototype (`spotme/web`, Trystero/WebRTC) to the
server-backed platform (`spotme/backend`, NestJS + Prisma + Postgres +
Socket.IO).

Phase tags: **P1** = current migration (modular monolith, guest auth,
server-relayed encrypted rooms), **P2** = 100K–10M scale (Signal-style
ratchet, passkeys, Redis/NATS, SFU), **P3** = 10M+ (multi-region, hot-path
services). A tag on a control means "this is when it must exist," not "this is
when we start thinking about it."

Ground-truth files referenced throughout:

- `spotme/backend/prisma/schema.prisma` — the data model, including the
  moderation, audit, and key-storage fields
- `spotme/backend/README.md` — the design constraints ("do not relax")
- `spotme/backend/src/moderation/ncmec.service.ts`,
  `spotme/backend/src/moderation/moderation.service.ts` — CSAM/report path
- `spotme/backend/src/audit/audit.service.ts` — staff audit trail
- `spotme/web/src/net.js`, `spotme/web/src/lib/reach.js`,
  `spotme/web/src/lib/rooms.js` — current P2P transport and knock protocol
- `spotme/web/api/` — Vercel serverless functions (`knock.js`, `turn.js`,
  `voice.js`, `username.js`, `translate.js`, `push.js`, `presence.js`)
- `spotme/web/src/lib/socket-transport.js` — the P1 server transport
  (drop-in replacement for the Trystero API surface, being implemented in the
  current migration)

---

## 1. Security posture in one paragraph

Spot Me's core promise is proximity-first messaging without accounts, phone
numbers, or passwords, where the server relays and stores **ciphertext and
metadata only**. The backend schema was designed around that promise before
any transport code was written: `Message.cipherText` is opaque, the server
holds no decryption key, `Presence` is a single overwritten row (no location
history), and the only path content reaches a human in readable form is a
user-filed `Report` carrying reporter-supplied plaintext
(`spotme/backend/prisma/schema.prisma`, `spotme/backend/README.md`). This
document is honest about the gaps: knock payloads are currently
server-readable, cloned-voice audio goes to a vendor in plaintext, the NCMEC
pipeline has no API key yet, and age verification is not wired. Each gap has
an owner-phase below.

---

## 2. Threat model

### 2.1 Server compromise (P1 design constraint)

**Threat.** An attacker gains read access to the Postgres database, the NestJS
host, or a backup. This is the scenario the whole schema is built for.

**What the attacker gets:**

- Message **ciphertext** (`Message.cipherText`, base64, opaque), nonces,
  message kind/size/timing, conversation membership
  (`ConversationParticipant`), TTLs
- User profile data: username, optional email/phone, name, avatar URL,
  self-reported city/area/age/sex, X25519 **public** keys (`User.publicKey`)
- Current presence: at most one lat/lon row per user (`Presence`), overwritten
  in place — no movement history exists to steal, by design
- Report rows, including reporter-supplied plaintext
  (`Report.reportedContent`)
- Refresh-token **hashes** and OTP-code **hashes** (`RefreshToken.tokenHash`,
  `OtpCode.codeHash`) — not usable directly
- **Knock payloads, which today include the room secret** (see 2.3) — this is
  the one place a server compromise currently escalates to content compromise
  for conversations whose knock is still retained

**What the attacker does not get:** message plaintext, media plaintext
(`mediaKey` objects are encrypted client-side before upload, per the schema
comment), or room secrets for conversations established without a
server-relayed knock.

**What they DO get, since 2026-08-05 (ADR-004): live call audio and video.**
This bullet previously claimed call media was out of reach because WebRTC
stayed peer-to-peer. That is no longer true — the peer-to-peer path was deleted
and calls run on a LiveKit SFU, which decrypts media in order to forward it.
Frames are TLS-protected in transit and are not stored, but an attacker who
controls the media server sees the call. **Calls are not end-to-end encrypted;
messages still are.** The documented upgrade path is LiveKit's
insertable-streams E2EE, where participants agree a key the server never holds;
it is not implemented. Note the scope: this is the MEDIA server. A TURN relay,
a separate thing, still only forwards bytes it cannot read.

**Mitigations.** P1: ciphertext-only storage (already the schema contract),
least-privilege DB credentials, host secret manager (Section 9), disk
encryption at the hosting provider. P2: encrypt knocks to the recipient's
public key (removes the escalation path), Sentry + OpenTelemetry for
detection, automated backup encryption verification. P3: per-service DB
credentials when hot paths split out into Go/Rust services.

### 2.2 Tracker metadata leakage (P1 — resolved by the migration)

**Threat.** The current P2P transport (`spotme/web/src/net.js`, Trystero 0.25)
uses public BitTorrent trackers for room discovery. Third-party tracker
operators — parties with no contractual relationship to Spot Me — can observe
room identifiers, participant IPs, and join timing. This is metadata exposure
to infrastructure we do not control.

**Mitigation (P1).** The Socket.IO migration
(`spotme/web/src/lib/socket-transport.js` joining rooms on the NestJS
`/rooms` namespace) removes public trackers from the path entirely. Metadata
then flows only to our own backend, which is governed by this document, and to
Cloudflare TURN for call relay (which sees IPs and bandwidth, not media
plaintext). After the migration, any remaining Trystero code path should be
deleted, not left as a fallback — a fallback that silently re-leaks metadata
to public trackers is worse than a hard failure.

### 2.3 Knock plaintext exposure (P1 known gap → P2 fix)

**Threat.** The knock protocol (`spotme/web/src/lib/reach.js`, durable relay
in `spotme/web/api/knock.js` via Upstash Redis; moving to the RoomEvent log in
P1) delivers the payload that lets the recipient join the conversation room —
**including the room secret**. Today that payload is readable by the server
that relays or stores it. Consequence: a server compromise or a subpoena
covering retained knocks can yield the key material for the affected
conversations, defeating E2E for exactly those rooms.

**Fix (P2, field already in place).** Encrypt the knock payload to the
recipient's X25519 public key (`User.publicKey` in
`spotme/backend/prisma/schema.prisma` exists for this). The server then
relays an opaque blob it cannot open; only the recipient's device — which
holds the matching secret key, never uploaded — can extract the room secret.
Until this ships, two honest interim controls apply (P1): delete knock
payloads immediately after acknowledged delivery (no longer than the current
relay TTL), and state the limitation plainly in the app's "What is actually
private" honesty card rather than implying knocks are E2E.

### 2.4 Voice-clone vendor exposure — GDPR/BIPA (P1 known gap)

**Threat.** The cloned-voice feature (`spotme/web/api/voice.js`, ~30s
enrollment sample, one clone per profile) sends **plaintext audio to a
third-party vendor**. A voiceprint is biometric data: special-category
personal data under GDPR Art. 9 and a "biometric identifier" under
Illinois BIPA, which carries private-right-of-action statutory damages.
This is the highest regulatory-severity data flow in the product.

**Mitigations (P1, before wide release — document, not marketing):**

- Explicit, separate, opt-in consent screen before recording the sample,
  naming the vendor and stating that audio leaves the device unencrypted to
  that vendor; consent stored with timestamp
- A working deletion path: deleting the clone (or the account) must trigger
  deletion at the vendor, not just locally
- A signed DPA with the vendor covering biometric data, retention limits, and
  sub-processor disclosure; verify the vendor's stated retention actually
  matches
- Do not enable the feature for users who fail or skip the 18+ gate
  (Section 2.6) — biometric consent from minors is a separate legal problem
- P2: evaluate on-device or self-hosted voice synthesis to remove the vendor
  from the flow entirely; until then this feature is honestly described as
  **not** E2E

**Related exception worth stating exactly:** the split-bubble translation
feature (`spotme/web/api/translate.js`, Sarvam/AI4Bharat pipeline in P1) also
processes message text in plaintext server-side/vendor-side, because
translation of ciphertext is impossible. Translation is opt-in per
conversation and this exception belongs on the same honesty card.

### 2.5 CSAM obligations — NCMEC (P1 legal obligation)

**Threat/obligation.** As a US-facing ESP, Spot Me has a reporting duty under
18 U.S.C. § 2258A once it obtains actual knowledge of apparent CSAM. E2E
encryption does not exempt the service: knowledge arrives through user
reports, and the schema is built for that path.

**Current implementation (real, in repo):**

- `Report` model (`spotme/backend/prisma/schema.prisma`): `reason: CSAM`,
  `status: ESCALATED_NCMEC`, `reportedContent` (plaintext supplied by the
  **reporter's** client — nothing is decrypted server-side), `retainUntil`
  enforcing the § 2258A preservation window (90 days, 180 on law-enforcement
  request) via a retention job, and `ncmecReportedAt`/`ncmecReportId` for the
  CyberTipline round-trip
- `spotme/backend/src/moderation/ncmec.service.ts` **fails loudly until
  `NCMEC_API_KEY` is provisioned** — per `spotme/backend/README.md`, this must
  never be stubbed into a fake success. Consequence, stated plainly: **real
  user-generated media must not ship until the CyberTipline credentials
  exist** (P1 launch blocker for media, not a P2 nice-to-have)

**Process requirements (P1):** moderator actions on CSAM reports go through
the audit log (Section 8); staff access to `reportedContent` is
role-gated (`MODERATOR`/`ADMIN`); escalation to `ESCALATED_NCMEC` records who
acted and when. P2: hash-matching (e.g., industry hash lists) on the
report-intake path only — never on encrypted content in transit, which the
architecture cannot scan and should not pretend to.

### 2.6 Age verification (P1 known gap)

**Threat.** Nearby/Discovery shows physically proximate strangers a knock
away. Without an age gate this is a child-safety and regulatory exposure
(and several jurisdictions now require verification for exactly this feature
class).

**Current state:** schema support exists (`User.ageVerified`,
`ageVerifiedAt`, `ageVerifyRef` — the third-party provider's reference id
only, no document images stored), but **no verification vendor is wired**
(`spotme/backend/README.md` gap list). Interim P1 stance: Nearby/Discovery
remains gated on self-declared 18+ with the honest limitation documented;
vendor integration is required before Nearby ships beyond a trusted test
population. Store only the vendor reference, never the underlying ID
document — the schema field is deliberately shaped to make the right thing
the only thing.

### 2.7 Out of scope for this document

Client-device compromise (malware on the user's phone reads plaintext —
no messenger survives this), global passive network adversaries correlating
traffic timing, and physical coercion. We do not claim protection we cannot
deliver; the in-app honesty card is the product-law mechanism for saying so.

---

## 3. E2E encryption design

### 3.1 Now (P1): AES-GCM from the room secret

Every persistent payload is encrypted client-side with AES-GCM using a key
derived from the **room secret**. The room secret is generated on the
initiating device and shared out-of-band from the server's perspective — it
travels in URL fragments (never sent in HTTP requests) and lives in
localStorage; it is **never transmitted to the backend** (with the one
exception of the knock path, Section 2.3, until the P2 fix). The server
appends ciphertext events to the per-room `RoomEvent` log and replays them on
join from the client's last sequence number — durable offline delivery
without readable content.

**Exactly what the server CAN read (P1):**

| Data | Where |
|---|---|
| Who talks to whom, when, how often, message sizes and kinds | `RoomEvent` log, `Message` rows, `ConversationParticipant` |
| Usernames, profile fields, X25519 public keys | `User` |
| Current presence (single row, overwritten; honors ghost mode) | `Presence` |
| Ephemeral relayed events' routing (typing, call signalling, live-location envelopes) | `/rooms` Socket.IO namespace — relayed, not persisted |
| Knock payloads **including room secrets** (until P2 fix) | knock relay path |
| Text submitted for translation, in plaintext | `spotme/web/api/translate.js` / P1 translation service |
| Voice-clone enrollment audio and TTS text, in plaintext, shared with the vendor | `spotme/web/api/voice.js` |
| Reporter-supplied plaintext of reported messages | `Report.reportedContent` |

**Exactly what the server CANNOT read (P1):**

- Message plaintext (`Message.cipherText` is AES-GCM ciphertext; no key
  server-side)
- Media content (encrypted client-side before R2 upload; `Message.mediaKey`
  points at an encrypted object)
- Call audio/video (WebRTC peer-to-peer, DTLS-SRTP; Cloudflare TURN
  (`spotme/web/api/turn.js` mint) relays encrypted packets without keys)
- Room secrets for rooms it never relayed a knock for

**Honest characterization:** P1 is end-to-end encrypted content with
server-visible metadata and a known key-distribution weakness in the knock
path. It is not Signal-equivalent and must not be marketed as such.

### 3.2 Phase 2: double ratchet, device verification, encrypted backups

- **Double ratchet (Signal protocol)** — replaces the static per-room AES-GCM
  key with per-message keys providing forward secrecy (a captured key does not
  decrypt past messages) and post-compromise security (healing after a device
  compromise). `User.publicKey` (X25519) is the identity-key foundation;
  P2 adds signed prekeys and one-time prekey bundles served by the backend.
- **Device verification** — safety-number/QR comparison so users can detect a
  server substituting keys (the MITM the P1 design must currently trust the
  server not to attempt). Surfaced in-chat with the same honesty-first UX as
  the rest of the product.
- **Encrypted backups** — chat history export/restore encrypted under a
  user-held passphrase or device keystore key; the server stores an opaque
  blob. Without this, device loss means history loss — that is the honest P1
  behavior and should be stated, not papered over.
- **Encrypted knocks** — the Section 2.3 fix lands here at the latest.

### 3.3 Phase 3

CRDT-style multi-device sync under the ratchet, per-device sessions, and
key-transparency (audit log of key changes) if the user base justifies it.

---

## 4. Authentication and authorization

### 4.1 End users

- **P1 — guest JWT.** `POST /auth/guest` with a device-generated id,
  username, and display name returns a JWT; `selfId` becomes the stable user
  id (replacing per-session Trystero ids). Usernames move from Vercel Blob
  (`spotme/web/api/username.js`) to the backend `User` table (unique
  constraint). No password, no phone — deliberately. Access tokens are
  short-lived; `RefreshToken` rows store only `tokenHash` with expiry and
  revocation (`revokedAt`), so a DB read does not yield usable tokens.
  Optional email/phone attach via `OtpCode` (hash-only storage,
  `consumedAt` single-use, expiry indexed).
- **P2 — passkeys and OAuth 2.1.** WebAuthn passkeys as the primary upgrade
  path (phishing-resistant, no password DB to breach, fits the no-password
  brand), OAuth 2.1 for optional linked sign-in. Guest-first onboarding
  remains; passkeys protect account recovery and multi-device.
- JWT guard: `spotme/backend/src/common/guards/jwt-auth.guard.ts`; secrets
  `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` live in the host secret manager
  (Section 9).

### 4.2 Staff

Employees are a **separate** account system (`Employee` model — deliberately
not the end-user `User` table), authenticated with bcrypt-hashed passwords
and gated by `employee-auth.guard.ts` + `roles.guard.ts` with the `Role` enum
(`USER`/`SUPPORT`/`MODERATOR`/`ADMIN`/`OPS`). Every sensitive dashboard
action is audit-logged (Section 8). P2: mandatory 2FA for `MODERATOR` and
above, session timeout, IP allowlisting for the admin dashboard.

### 4.3 Authorization rules of note

- Nearby is the **only** source with an accept/reject gate
  (`spotme/backend/src/chat-requests/chat-requests.service.ts`: `NEARBY`
  requests stay `PENDING`; `USERNAME`/`LINK`/`CONTACT`/`BLUETOOTH` open
  immediately) — mirrors the product's no-accept-gate knock design while
  keeping a consent step where strangers are discovered by proximity.
- Socket.IO room membership must be authorized against
  `ConversationParticipant` on join (P1) — a valid JWT alone must not grant
  entry to arbitrary rooms.
- Blocks (`Block` model, unique blocker/blocked pair) must be enforced
  server-side on knock delivery, chat requests, and room events — not only
  hidden client-side.

---

## 5. Rate limiting (P1)

Guest auth makes identities cheap, so rate limiting is a launch requirement,
not hardening-for-later. P1 targets, enforced in the NestJS layer (e.g.,
`@nestjs/throttler`) with per-IP and per-user keys:

- `POST /auth/guest` — strict per-IP limit; new-identity creation is the
  cheapest abuse primitive in the system
- Knock/chat-request send — per-user and per-recipient caps (also the
  anti-harassment control; see Section 6)
- Report filing — per-user cap to prevent report-bombing
- Username lookup (`GET /api/users/lookup`) — per-IP, to slow enumeration of
  the username namespace
- Socket.IO event flood control per connection; disconnect on sustained abuse
- Translation and voice endpoints — per-user quotas (these cost real vendor
  money; unlimited free calls are a fraud vector, Section 6)

P2: move counters to Redis (already in the P2 stack for the Socket.IO adapter
and presence) so limits survive multi-instance deployment. P3: edge rate
limiting (Envoy) in front of hot-path services.

---

## 6. Abuse and fraud

- **Harassment via knocks.** No accept gate is the product's core bet; the
  compensating controls are the Nearby-only accept gate, per-recipient knock
  caps (Section 5), one-tap block (`Block`, enforced server-side), and
  report (`Report`). Ghost mode and last-seen visibility limit unwanted
  discovery.
- **Cheap-identity spam.** Guest accounts have no phone/email cost. Controls:
  per-IP signup limits, device-id continuity signals (`Device` rows),
  per-new-account sending caps for the first N interactions (P1), and
  escalation to proof-of-work or optional verified email for flagged clients
  (P2). We accept this trade-off knowingly rather than betraying the
  no-phone-number promise.
- **Invite-link abuse.** Group invite links carry the group name; links must
  be revocable by the owner and knock caps apply on join floods (P1).
- **Vendor-cost fraud.** Translation and voice-clone endpoints spend vendor
  budget per call; quotas per user plus anomaly alerts on aggregate spend
  (P1: a daily threshold check is enough; P2: Grafana alerting).
- **Location spoofing.** Presence lat/lon is client-asserted. The product
  already displays approximate distances (~) as product law; the server
  additionally sanity-checks update frequency and implausible jumps before
  surfacing a user in Nearby (P1, heuristic only — do not claim spoof-proof).
- **Moderation outcomes.** `ReportStatus` (`OPEN`/`ACTIONED`/`DISMISSED`/
  `ESCALATED_NCMEC`) with `resolvedByEmployeeId` ties every outcome to a
  staff identity in the audit log.

---

## 7. Data minimization commitments (schema-enforced)

These are restated because they are security controls, not just privacy
copy — each removes a class of breach impact outright:

- No location history: `Presence` is one overwritten row
  (`spotme/backend/prisma/schema.prisma`), and `InstallEvent.city` is coarse
  and never GPS-derived
- No plaintext, no keys: `Message.cipherText` + client-held keys
- Soft-delete with hard purge: `User.deletedAt` marks, a purge job
  hard-deletes after the grace period
- Disappearing messages: `Message.ttlSeconds`/`expiresAt` mirror the client
  timers server-side, so expired ciphertext is actually deleted from the
  server, not merely hidden
- Age verification stores a vendor reference only (`ageVerifyRef`), never
  identity documents

---

## 8. Audit logging (already in schema — P1)

`AuditLog` (`spotme/backend/prisma/schema.prisma`, written via
`spotme/backend/src/audit/audit.service.ts`) records every sensitive
dashboard action: `employeeId`, `action` (e.g., `report.view`,
`report.action`, `employee.create`), target type/id, JSON metadata,
timestamp — indexed by employee and by action. This is the accountability
control that justifies any staff access to user-adjacent data (the schema
comment says exactly this).

P1 rules: audit writes are non-optional on the moderation and admin paths
(a failed audit write fails the action, not the other way around); staff
cannot delete audit rows (no delete endpoint exists — keep it that way).
P2: ship audit logs to append-only external storage so a compromised admin
host cannot rewrite history; alert on anomalous staff access patterns.
Detection floor today is `HealthSample` + `CrashReport` polling; Sentry and
OpenTelemetry/Prometheus/Grafana arrive in P2.

---

## 9. Secrets management

- **P1.** All secrets live in the deploy host's secret manager (Railway/Fly
  for the backend, Vercel env for the serverless functions) — never in the
  repo (`spotme/backend/README.md`; same pattern `spotme/web/PUSH.md`
  documents for push keys). Inventory: `DATABASE_URL`, `JWT_ACCESS_SECRET`,
  `JWT_REFRESH_SECRET`, `NCMEC_API_KEY`, `RESEND_API_KEY`, Cloudflare TURN
  credentials, Upstash Redis tokens, translation/voice vendor keys, VAPID
  push pair, R2 credentials when media lands. Startup must fail fast on
  missing required secrets rather than degrade silently — `ncmec.service.ts`
  already models the correct behavior.
- **Rotation.** Any secret that appears in a chat transcript, screenshot, or
  log is burned and regenerated — this has already happened once to a VAPID
  pair (see `spotme/web/PUSH.md` history) and the response (regenerate) is
  the standing policy.
- **P2.** CI/CD via GitHub Actions with Trivy scanning; secrets injected at
  deploy, never in build artifacts; per-environment key separation.
- **P3.** Dedicated secret store (e.g., Vault-class) with per-service
  identities when the monolith splits.

---

## 10. Incident response basics (P1)

One developer plus AI agents is the honest team size; the plan is sized for
that reality.

1. **Detect.** `HealthSample`/`CrashReport` polling and the ybot crash
   bridge today; Sentry + metrics alerting in P2. A user report of a security
   issue is treated as a detection source, not noise.
2. **Classify.** SEV-1: key/secret exposure, plaintext exposure, CSAM
   pipeline failure, auth bypass. SEV-2: metadata leak, abuse-control
   failure, vendor incident. SEV-3: everything else.
3. **Contain.** Revoke/rotate affected secrets (Section 9); revoke refresh
   tokens (`RefreshToken.revokedAt` supports bulk revocation); take the
   affected endpoint down rather than leave it leaking — the product's
   honesty rules apply to outages too.
4. **Assess and notify.** If personal data is affected, GDPR Art. 33 sets a
   72-hour supervisory-authority notification clock from awareness; BIPA
   exposure (voice data) and NCMEC obligations (Section 2.5) have their own
   tracks. Notify affected users plainly — the "What is actually private"
   card sets the register.
5. **Recover and record.** Post-incident notes go in the repo docs, and any
   burned pattern (like the VAPID pair) becomes a standing rule. Re-verify
   the E2E properties after any transport or key-path change — the brief's
   rule that nothing is "working" until re-run applies doubly to security
   properties.

---

## 11. Gap register (single honest list)

| Gap | Severity | Phase to close | Blocking? |
|---|---|---|---|
| Knock payloads server-readable (contain room secret) | High | P2 (encrypt to `User.publicKey`); P1 interim: delete-after-delivery + honesty card | No, with interim controls |
| NCMEC API key not provisioned | Legal | P1 | **Blocks shipping real user media** |
| Voice-clone plaintext to vendor (GDPR/BIPA) | High | P1 consent/DPA/deletion; P2 self-host evaluation | Blocks wide release of the feature |
| Age-verification vendor not wired | High | P1 before Nearby GA | Blocks Nearby beyond test users |
| Translation processes plaintext | Medium (inherent) | Documented exception, honesty card (P1) | No |
| No forward secrecy / device verification | Medium | P2 double ratchet | No |
| Push dormant (5 env vars unset), prod deployment 404 | Ops | P1 | Blocks launch, not security-critical |
| Rate limiting not yet implemented on new backend endpoints | High | P1 | Blocks public launch |
