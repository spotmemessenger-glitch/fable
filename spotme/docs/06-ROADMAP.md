# Spot Me — Development Roadmap

Document 06 of the Spot Me platform documentation set.
Scope: the migration of Spot Me Messenger from a P2P prototype (Trystero/WebRTC
rooms) to a server-backed platform, and the phased growth plan that follows.
All facts below are verified against the repository as of 2026-07-30; nothing
in this document is a marketing projection. Dates are given at week
granularity only.

---

## 1. How to read this roadmap

### Phase tags

| Tag | Phase | Horizon |
|-----|-------|---------|
| **P1** | Server migration (in progress now) | Tonight / this week |
| **P1.5** | Hardening and dormant-feature activation | Immediately after P1 verifies |
| **P2** | Growth (per target tech-stack doc, 100K–10M users) | After P1.5; no date committed |
| **P3** | Scale (per target tech-stack doc, 10M+ users) | Demand-driven; no date committed |

### Effort classes

Effort classes describe engineering effort for one developer working with AI
agents (the actual team). They are not calendar promises.

| Class | Meaning |
|-------|---------|
| **S** | Hours — a focused session |
| **M** | 1–3 days |
| **L** | Roughly one week |
| **XL** | Multi-week; needs its own plan before starting |

### Ground rules inherited from the product

These constrain every phase and are treated as product law, not preferences:

- **Honesty rules**: approximate distances stay approximate, demo contacts are
  labeled, cooperative features admit their limits, and there are no fake
  states (message info shows Sent + Read only — no invented Delivered tier).
- **Privacy promise**: the server stores ciphertext only. Room secrets live in
  URL fragments / local storage and are never sent to the server. Any roadmap
  item that would weaken this must say so explicitly (see the knock-encryption
  item in P1.5).
- **Design system is locked** (2026-07-24): `spotme/web/src/tokens.css` plus
  the per-view CSS under `spotme/web/src/views/`. Roadmap work does not
  restyle the app.

---

## 2. Phase 1 — Server transport migration (P1, tonight/this week)

Goal: replace the Trystero 0.25 BitTorrent-tracker transport with a
server-backed Socket.IO transport that is a drop-in for the existing API
surface, gaining true offline delivery and durable media without breaking the
E2E-ciphertext privacy model.

Current state being replaced: `spotme/web/src/net.js` (Trystero wrapper),
`spotme/web/src/lib/reach.js` (personal-inbox-room knock protocol),
`spotme/web/src/lib/rooms.js` (connection/store manager), and the Vercel
serverless functions under `spotme/web/api/` (`turn.js`, `username.js`,
`knock.js`, `push.js`, `translate.js`, `voice.js`, `presence.js`).

### P1-1. Socket.IO transport (drop-in for Trystero)

| | |
|---|---|
| **What** | New `spotme/web/src/lib/socket-transport.js` exporting `joinRoom`/`selfId` with the same surface `net.js` consumes today. Rooms become Socket.IO rooms on the NestJS backend (`/rooms` namespace, `spotme/backend/src/chat/`). Payloads are AES-GCM-encrypted client-side with a key derived from the room secret; the server relays and stores ciphertext only. Ephemeral actions (typing, call signalling, live location, RTC negotiation) relay without persistence. Calls remain WebRTC peer-to-peer — media never touches the server — with signalling over the socket and Cloudflare TURN (`spotme/web/api/turn.js` behavior moves behind the backend). |
| **Effort** | L |
| **Depends on** | Backend running (verified locally 2026-07-26 against Docker Postgres); nothing else. |
| **Done when** | Two browsers exchange all ~15 existing action types (msg/react/profile/history/bin/binack/fetch/call/locup/del/edit/typing/read/seen, knock/knockAck) through the socket transport with Trystero fully removed from the active code path, and a network capture shows only ciphertext payloads reaching the server. |

### P1-2. Offline delivery (RoomEvent log + replay)

| | |
|---|---|
| **What** | Every persistent action appends to a per-room `RoomEvent` log in Postgres (schema: `spotme/backend/prisma/schema.prisma`). On join, the client replays from its last sequence number. This is what makes knocks durable and messages deliverable to offline peers — the core capability the P2P transport could not provide. |
| **Effort** | M (rides on P1-1) |
| **Depends on** | P1-1. |
| **Done when** | Peer B is fully closed while peer A sends messages, a photo, and a knock; B reopens and receives everything in order exactly once, from its stored last-seq cursor. |

### P1-3. Media persistence (video P0 re-verification)

| | |
|---|---|
| **What** | Media currently ships as 128KB slices with acks (`spotme/web/src/lib/media.js`). Video persistence was a P0 bug in the P2P transport; server-side persistence of the sliced ciphertext is expected to fix it, but that is an expectation, not a result, until re-run. Interim storage is Postgres/backend disk; object storage moves to R2 in P1.5. |
| **Effort** | M |
| **Depends on** | P1-1, P1-2. |
| **Done when** | The previously failing video send/receive scenario is re-run end-to-end on the new transport and passes, including receipt after the recipient was offline during the send. |

### P1-4. Guest auth (device identity → JWT)

| | |
|---|---|
| **What** | `POST /auth/guest {device-generated id, username, name}` returns a JWT (`spotme/backend/src/auth/`). Usernames move from Vercel Blob (`spotme/web/api/username.js`) to the backend `User` table. `selfId` becomes a stable user id, replacing per-session Trystero ids. No password, phone, or email — the no-account promise is unchanged. |
| **Effort** | M |
| **Depends on** | Backend running. Parallel to P1-1. |
| **Done when** | A fresh browser profile gets a JWT, claims a username, reconnects later with the same stable `selfId`, and duplicate-username claims are rejected by the backend. |

### P1-5. Local verification pass

| | |
|---|---|
| **What** | Full two-peer manual verification of the locked feature set on the new transport before any deploy: knock → chat open on both sides, split-bubble translation, transliteration, all media types including view-once photos and their mandatory timer wheel, reactions, disappearing-message timers, edit/delete-for-everyone, calls (WebRTC audio/video with TURN), read receipts (Sent + Read only). |
| **Effort** | M |
| **Depends on** | P1-1 through P1-4. |
| **Done when** | Every item in the checklist passes in two real browser profiles against the locally running backend, and failures (if any) are logged as blockers rather than deferred silently. |

### P1-6. Deploy: Vercel redeploy + backend hosting

| | |
|---|---|
| **What** | The production Vercel deployment is currently 404 and must be redeployed. The NestJS backend (Dockerfile at `spotme/backend/Dockerfile`) deploys to Railway or Fly, with Postgres on Neon (or the host's managed Postgres). Budget-conscious hosting is deliberate: one developer + AI agents; no day-one AWS EKS. |
| **Effort** | M |
| **Depends on** | P1-5 passing locally. Deploying before local verification is explicitly out of order. |
| **Done when** | The web app loads from the production Vercel URL, connects to the hosted backend over the socket transport, and the P1-5 checklist passes once more between two devices on different networks. |

---

## 3. Phase 1.5 — Hardening (P1.5, after P1 verifies)

Items that are small, already scaffolded, or unblock dormant features. None of
these should start before P1-6 is done — each one hardens a system that must
first exist in production.

### P1.5-1. Push notification env vars

| | |
|---|---|
| **What** | Push is built but dormant: it needs 5 environment variables set, documented in `spotme/web/PUSH.md`. Note: the previously generated VAPID key pair appeared in a screenshot and is burned — generate a fresh pair; do not reuse it. Client code: `spotme/web/src/lib/push.js`. |
| **Effort** | S |
| **Depends on** | P1-6 (production URLs must be final for service-worker scope). |
| **Done when** | A push notification arrives on a device with the app fully closed, triggered by a real message send. |

### P1.5-2. Media to R2 object storage

| | |
|---|---|
| **What** | Move persisted media ciphertext from the P1 interim store to Cloudflare R2 (chosen over S3 for egress cost). Server continues to store ciphertext only. |
| **Effort** | M |
| **Depends on** | P1-3. |
| **Done when** | New media round-trips through R2, old in-flight media still delivers, and a stored object is verified to be ciphertext (not decryptable server-side). |

### P1.5-3. Sentry error reporting

| | |
|---|---|
| **What** | Sentry on both the web client and the NestJS backend. Scrubbing must be configured so ciphertext payloads, room secrets, and usernames do not leak into breadcrumbs or request bodies — an error tracker that violates the privacy promise is worse than none. |
| **Effort** | S |
| **Depends on** | P1-6. |
| **Done when** | A deliberately thrown error appears in Sentry from both client and backend, and an audit of the captured event shows no message content or room-secret material. |

### P1.5-4. Knock encryption to recipient publicKey

| | |
|---|---|
| **What** | Honest constraint, stated plainly: knock payloads are currently server-readable and contain the room secret. The fix is to encrypt knocks to the recipient's `publicKey` — the field already exists per user in `spotme/backend/prisma/schema.prisma`. Until this ships, the server can technically read knock contents; the "What is actually private" honesty card in Settings must not overstate the current state. |
| **Effort** | M |
| **Depends on** | P1-1 (knocks flowing through the socket transport), P1-4 (stable user identity to bind keys to). |
| **Done when** | A captured knock payload on the server is ciphertext, a wrong-key recipient cannot open it, and the honesty card copy is updated to match. |

---

## 4. Phase 2 — Growth (P2)

Scope follows the user-provided target tech-stack document
(`SpotMe_Complete_Tech_Stack_2026.md`), Phase 2 tier: Redis 8 (Socket.IO
adapter + presence), NATS/Kafka fanout, Sentry + OpenTelemetry/Prometheus/
Grafana, coturn fleet, CI/CD with GitHub Actions + Trivy. The items below are
the product-visible commitments; infrastructure items from that document are
adopted as their load justifies them, not on a calendar. No dates are
committed for P2.

### P2-1. React Native app GA

| | |
|---|---|
| **What** | Take the native tracks (`spotme/app`, `spotme/mobile`) to general availability on the new server transport. Stories posting — deferred to native (web has the rings UI only) — lands here. Known native groundwork already exists: prior sessions resolved RNG polyfill, RN version, and emulator-networking issues, and verified E2E + group crypto on device. |
| **Effort** | XL |
| **Depends on** | P1 complete; P1.5-1 (push) strongly recommended first, since a native messenger without push is not GA-quality. |
| **Done when** | Signed release builds pass the P1-5 feature checklist against production, and Stories can be posted and viewed from native. |

### P2-2. LiveKit SFU group calls

| | |
|---|---|
| **What** | 1:1 calls stay peer-to-peer WebRTC. Group calls need an SFU; the tech-stack doc selects LiveKit. Group scaffolding exists in the backend (`spotme/backend/src/groups/`, groups modeled as conversations). |
| **Effort** | XL |
| **Depends on** | P1-1 (socket signalling), P2 infra (Redis presence helps but is not a hard gate). |
| **Done when** | A three-or-more-party call completes on production infrastructure with join/leave/mute working, and 1:1 calls verifiably still bypass the SFU. |

### P2-3. Passkeys / OAuth 2.1 (optional account upgrade)

| | |
|---|---|
| **What** | Optional credential upgrade on top of guest auth — passkeys per the tech-stack doc — so users can recover identity across devices. Must remain optional: the no-account onboarding is the product's core promise and does not change. |
| **Effort** | L |
| **Depends on** | P1-4. |
| **Done when** | A user can add a passkey to a guest identity, recover that identity on a second device, and a user who never adds one loses nothing. |

### P2-4. Signal-protocol double-ratchet E2E upgrade

| | |
|---|---|
| **What** | Replace the room-secret-derived AES-GCM scheme with a Signal-protocol double ratchet, gaining forward secrecy and post-compromise security. This is a cryptographic migration with rollout hazard (key/session state on both ends) and needs its own migration plan before any code. |
| **Effort** | XL |
| **Depends on** | P1-4 (stable identities), P1.5-4 (publicKey distribution already exercised). |
| **Done when** | New conversations ratchet per message, existing conversations migrate or gracefully re-key, and the migration plan's rollback path has been tested — not merely written. |

### P2-5. Personal AI assistant v1

| | |
|---|---|
| **What** | Summarize / translate / draft-reply assistant, per the AI-platform section of the tech-stack doc (Claude/GPT/Gemini via a LiteLLM router). Because assistant features read message content, every entry point must be explicit, opt-in, and reflected in the "What is actually private" honesty card — an AI feature that silently reads plaintext breaks product law. |
| **Effort** | L |
| **Depends on** | P1 complete; vendor key management. |
| **Done when** | Summarize/translate/reply work behind explicit opt-in, and the honesty card accurately describes what leaves the device when they are used. |

### P2-6. Universal Language Bridge v1

| | |
|---|---|
| **What** | Cross-language conversation (Tamil ↔ English ↔ Hindi and the other supported Indian languages, including voice) building on the existing split-bubble translation and transliteration pipeline (`spotme/web/src/lib/translate.js`, `spotme/web/api/translate.js`; Sarvam/AI4Bharat per the tech-stack doc; Whisper/ElevenLabs for speech). Honest precondition: the existing translation pipeline has 7 open issues — those are burn-down work inside this item, not a separate someday-list. |
| **Effort** | XL |
| **Depends on** | P2-5's vendor routing; existing translation pipeline issues resolved or explicitly waived per issue. |
| **Done when** | A two-language text conversation flows both directions with split-bubble display intact, voice-note translation works for at least one language pair, and the 7 tracked pipeline issues are each closed or consciously waived. |

### P2-7. Moderation AI

| | |
|---|---|
| **What** | AI-assisted moderation feeding the existing pipeline (`spotme/backend/src/moderation/` — Report model + NCMEC retention already in schema). Hard gate, restated from the constraints: the NCMEC/CSAM reporting pipeline needs a real API key before real user media ships at scale. E2E encryption limits server-side scanning to reported/unencrypted surfaces; this boundary is documented, not worked around covertly. |
| **Effort** | L |
| **Depends on** | NCMEC API key (external, blocked on registration); P1.5-2 (media in R2). Age-verification vendor wiring is a sibling gate in this area and is also not yet done. |
| **Done when** | Reported content flows through classification to the admin dashboard (`spotme/admin-dashboard`), NCMEC reporting works against the real API, and the scanning boundary is documented for users. |

---

## 5. Phase 3 — Scale (P3)

Phase 3 executes the top tier of the target tech-stack document and is
deliberately not planned in item-level detail here — every P3 item is
demand-driven and should be re-scoped against real load data when P2 traffic
justifies it. Per that document, the P3 toolkit is:

- **Hot-path services in Go/Rust** — presence and fanout rewritten out of the Node monolith. (XL; depends on measured P2 bottlenecks, not assumptions.)
- **Kafka/Pulsar event backbone** replacing/extending P2 fanout. (XL)
- **ClickHouse** for analytics, **Qdrant** vector search for AI features. (L–XL each)
- **Multi-region Kubernetes** with Terraform + Helm + Istio, Envoy at the edge, VictoriaMetrics for metrics. (XL; this is the point where the budget-hosting posture of P1 is deliberately retired.)
- **CRDT-style sync** for multi-device state. (XL)
- **vLLM-served models behind the LiteLLM router** for AI-feature cost control at volume. (L)

**Entry criterion for P3 as a whole**: a sustained, measured load or cost
problem in P2 infrastructure that a P2-tier fix cannot solve. Adopting P3
machinery earlier than that is over-engineering for a one-developer team and
is explicitly rejected by this roadmap.

---

## 6. Standing risk register (cross-phase)

Honest constraints that stay on the books until closed. None of these are
softened by phase progress.

| Risk | Phase gate | Status |
|------|-----------|--------|
| Video persistence P0 fixed only in principle by server persistence | P1-3 re-verification | Open until re-run passes |
| Cloned voice sends plaintext audio to the vendor (`spotme/web/src/lib/voice.js`, `spotme/web/api/voice.js`) — GDPR/BIPA exposure | Document mitigation and consent flow; not a marketing feature until then | Open |
| Knock payloads server-readable (contain room secret) | P1.5-4 | Open |
| Push dormant (5 env vars; burned VAPID pair must be regenerated) | P1.5-1 | Open |
| NCMEC/CSAM pipeline lacks API key | P2-7 hard gate before real media at scale | Open (external) |
| Translation pipeline: 7 open issues | Burned down inside P2-6 | Open |
| Age-verification vendor not wired | P2-7 area | Open |
| Production Vercel deployment 404 | P1-6 | Open |

---

## 7. Explicit non-goals

- No paid marketing, growth targets, or revenue projections — this is an
  engineering roadmap and invents no market numbers.
- No design-system changes; the 2026-07-24 lock holds.
- No day-one hyperscaler infrastructure; P3 machinery waits for P3 evidence.
- No weakening of the honesty rules or the ciphertext-only server posture to
  ship any item faster. Where an item temporarily falls short (knocks,
  cloned voice), this document says so rather than hiding it.
