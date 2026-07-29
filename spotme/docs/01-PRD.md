# Spot Me Messenger — Product Requirements Document (PRD)

Document 01 of the Spot Me platform documentation set.
Status: authoritative product requirements for the migration from P2P prototype to server-backed platform.
Scope basis: the shipped web app (`spotme/web`), the NestJS backend (`spotme/backend`), and the phased target stack. Everything marked **Shipped** has been live-verified in the web app; everything else is phase-tagged **P1 / P2 / P3**.

---

## 1. Product summary

Spot Me is a **proximity-first messenger with no account, no password, and no phone number**. A user opens the app, gets a device-generated identity, and can chat three ways:

| Mode | How a chat starts | Where it lives in code |
|---|---|---|
| **Meet** | Username or invite link | `spotme/web/src/views/inbox.js`, `spotme/web/api/username.js` |
| **Nearby** | Map + radar discovery of people around you | `spotme/web/src/views/discovery.js`, `spotme/web/src/lib/discovery.js` |
| **Bluetooth** | Local mesh preview | `spotme/web/src/views/bluetooth.js` |

There is **no accept gate**: a "knock" opens the chat on both sides immediately (`spotme/web/src/lib/reach.js`, durable relay in `spotme/web/api/knock.js`).

The second pillar is **language**. Spot Me treats translation and transliteration as first-class messaging features, with Indian languages as the primary target: split-bubble translation (original and translation always both visible, never a toggle) and type-in-English → send-in-your-script transliteration for 10 Indian languages (`spotme/web/src/lib/translate.js`, `spotme/core/translit.js`).

The third pillar is **honesty**. The product never claims more privacy, precision, or delivery certainty than it can prove. These rules are product law and are restated as formal requirements in §7.

---

## 2. Problem and positioning

- Mainstream messengers require a phone number, which is both a privacy leak and a barrier for spontaneous, proximity-based connection (events, campuses, transit, markets).
- Cross-language conversation inside chat apps is an afterthought: translation is a long-press action that replaces the original text, and typing in an Indian script requires a separate keyboard.
- Spot Me's position: **meet people around you and talk across languages, with zero sign-up friction and honest privacy claims.**

No market-size figures are asserted in this document; sizing claims require sourced research and are out of scope here.

---

## 3. Personas

Personas are ordered by product priority. Indian-language-first users are the primary design target for the language features.

### P-1. Priya — Indian-language-first communicator (primary)
Tamil-speaking, comfortable reading Tamil script, types on an English (QWERTY) keyboard. Wants to send messages in Tamil script without installing a Tamil keyboard, and to read messages from Hindi- or English-speaking contacts in her own language.
- Needs: transliteration at send time (`vanakkam` → வணக்கம்), split-bubble translation that never hides the original, language settings shown in native scripts (the Settings language grid renders native scripts — `spotme/web/src/views/profile.js`).
- Success looks like: she never switches keyboards and never loses the original text of a message.

### P-2. Arun — proximity connector
At a college fest / co-working space / train. Wants to see who is around, knock, and talk — without exchanging phone numbers.
- Needs: map + radar discovery with coarse (~) distances, ghost mode when he does not want to be seen, demo practice contacts to learn the app safely (`spotme/web/src/lib/demo.js`).

### P-3. Meera — privacy-conscious user
Chose Spot Me because it needs no phone number. Reads the "What is actually private" card in Settings and expects the app to keep its word.
- Needs: view-once photos with a mandatory timer, app-switcher blur, last-seen visibility control, block list, Clear-all-data with double confirmation (`spotme/web/src/views/profile.js`), and honest copy about what deletion/view-once can and cannot guarantee.

### P-4. Deepak — voice-first user
Prefers speaking to typing. Uses voice notes, the cloned-voice option, and (on native) voice/video calls.
- Needs: ~30-second voice-clone enrollment, one clone per profile (`spotme/web/api/voice.js`), voice notes with duration, WebRTC calls with PiP and mute.
- Constraint he must be told about: cloned-voice audio is sent to a third-party vendor in plaintext (see §9).

### P-5. Staff — trust & safety operator (internal)
Works in the admin dashboard (`spotme/admin-dashboard`) against the backend's moderation model (Report + NCMEC retention, admin/audit/Employee tables in `spotme/backend`'s Prisma schema).
- Needs: report queues, audit trails, and crash/health telemetry (CrashReport, HealthSample).

---

## 4. Feature inventory — Shipped (live-verified in the web app)

Everything in this section exists today in `spotme/web` and was verified working. The P1 migration (§5) changes the transport underneath these features; it must not regress any of them.

### 4.1 Identity and onboarding
- Device-generated identity; no account, password, or phone number.
- Profile: name, language, avatar (12 AI avatars), transliteration and auto-translate preferences (`db.profile()` in `spotme/web/src/lib/db.js`).

### 4.2 Chat modes and inbox
- Three modes (`meet` / `nearby` / `bluetooth`) filtered by the inbox tabs General / Nearby / Bluetooth (`spotme/web/src/views/inbox.js`, contract in `spotme/web/CONTRACT.md`).
- Knock protocol: no accept gate; a knock opens the chat on both sides. Durable knock relay + push trigger via `spotme/web/api/knock.js` and `spotme/web/api/push.js` (push is dormant until 5 env vars are set — see §9).
- Swipe actions on conversations: delete, archive.

### 4.3 Messaging (`spotme/web/src/views/chat.js`, `spotme/web/src/lib/rooms.js`)
- Message kinds: text, photo, **private view-once photo**, video, voice note (with cloned-voice option), document, location, live location.
- Reactions with per-emoji motion.
- Disappearing messages: per-chat timer 10 seconds – 3 months; a **separate mandatory timer wheel for private photos**.
- Edit, delete-for-me, delete-for-everyone (no residue).
- Reply, forward, star, message info — **Sent + Read only; there is deliberately no fake "Delivered" tier**.
- Typing indicators and activity pings.
- Media transport: 128 KB slices with acknowledgements (`spotme/web/src/lib/net.js`).

### 4.4 Language (the differentiator)
- **Split-bubble translation**: original + translation always both visible, never a toggle (`spotme/web/src/lib/translate.js`, device engine first, cloud fallback via `spotme/web/api/translate.js`).
- **Transliteration**: type English, send in your script; applied at send time; 10 Indian languages (`spotme/core/translit.js`).
- Language grid in Settings rendered in native scripts.
- Speak (TTS) and dictate (STT) helpers where the platform supports them.

### 4.5 Calls
- Voice/video calls over WebRTC with PiP, mute, decline/accept; TURN credentials minted by `spotme/web/api/turn.js` (Cloudflare TURN).
- **Web build honesty rule**: calls are native-only; the web app shows the toast "Calls arrive with the native app" and never fakes a call UI (`spotme/web/CONTRACT.md`).

### 4.6 Media tools
- Photo editor: pen, text layers, rotate, HD toggle.
- Image compression and file-size guards (`spotme/web/src/lib/media.js`).

### 4.7 Social surfaces
- **Stories**: rings UI shipped (`spotme/web/src/views/stories.js`); posting is deferred to the native app.
- **Alerts** screen (`spotme/web/src/views/notifications.js`).
- **Contacts / Groups**: contact list, block list; group invite links carry the group name (`spotme/web/src/views/contacts.js`, `spotme/web/src/views/groups.js`).

### 4.8 Settings and safety (`spotme/web/src/views/profile.js`)
- AI avatars (12), voice clone (~30 s sample, one per profile), ghost mode, last-seen visibility, app-switcher blur.
- Notification permission flows with a **real state readout** (never a pretend toggle).
- Demo practice contacts (always marked with a "demo" chip).
- "What is actually private" honesty card.
- Blocked list; Clear-all-data with double confirmation.

### 4.9 Design system (LOCKED)
Locked 2026-07-24; tokens in `spotme/web/src/tokens.css`, per-view CSS in `spotme/web/src/views/*.css`.
- Colour roles: ink `#0f0f10` = commit actions; teal-blue `#1b8a9d` = information/state; red `#e5342b` destructive only; green = presence + Bluetooth.
- Sora type, 560 px shell, WhatsApp-style floating bottom bar, 140–220 ms motion, `prefers-reduced-motion` respected.
- Any new surface (AI assistant, channels, marketplace) must ship inside this system; the design system is a requirement, not a suggestion.

### 4.10 Backend platform (built and verified, being wired in as P1)
`spotme/backend`: NestJS 10 + Prisma 5 + PostgreSQL + Socket.IO. The schema is E2E-preserving (opaque `Message.cipherText`, per-user `publicKey`, single-row Presence, no location history), with chat-requests, groups-as-conversations, text stories, moderation (Report + NCMEC retention), admin/audit/Employee, CrashReport, and HealthSample. Verified running 2026-07-26 against local Docker Postgres. Staff UI in `spotme/admin-dashboard`; native tracks in `spotme/app` and `spotme/mobile`; Hypercore P2P library for native in `spotme/core`.

---

## 5. Feature inventory — Planned (phase-tagged)

Phases are capacity/architecture stages, not dates. P1 = the current server-backed migration; P2 = the growth stage (Redis, message-queue fanout, SFU, native GA); P3 = the large-scale stage (hot-path services, event backbone, multi-region).

### 5.1 P1 — Server-backed transport migration (in progress now)
- **Drop-in Socket.IO transport** replacing Trystero WebRTC rooms: `spotme/web/src/lib/socket-transport.js` exports the same `joinRoom`/`selfId` surface; rooms become Socket.IO rooms on the NestJS `/rooms` namespace.
- **Durable message log**: every persistent action appended to a per-room RoomEvent log (Postgres) and replayed on join from the client's last sequence number → true offline delivery and durable knocks.
- **Privacy-preserving persistence**: payloads AES-GCM-encrypted client-side with a key derived from the room secret (which lives in URL fragments / local storage and is never sent to the server) — the server stores ciphertext only.
- **Ephemeral relay** (no persistence) for typing, call signalling, live location, and RTC negotiation.
- **Calls stay peer-to-peer**: media never touches the server; signalling over the socket; Cloudflare TURN.
- **Guest auth**: `POST /auth/guest` with a device-generated id → JWT; usernames move from Vercel Blob (`spotme/web/api/username.js`) to the backend User table; `selfId` becomes a stable user id.
- Deployment: Docker on Railway/Fly/Hetzner-class hosting (single developer, budget-conscious — not day-one AWS EKS).
- P1 exit requirement: **re-verify the video persistence bug** that was P0 in the P2P transport (server persistence is the fix, but it must be proven, not assumed).

### 5.2 P2 — Growth features
- **Personal AI assistant**: summarize a conversation, translate on demand, suggest replies. Served via LiteLLM routing to Claude/GPT/Gemini-class models; Whisper/ElevenLabs for speech; Sarvam/AI4Bharat for Indic languages. Must render inside the locked design system and must be clearly labeled as AI (see HR-6).
- **Universal Language Bridge**: real-time Tamil↔English↔Hindi (and the other supported Indic languages) conversation, including voice — the evolution of the shipped split-bubble pipeline. Ships only when the 7 open translation-pipeline issues are closed (§9).
- **AI camera (first stage)**: point-and-translate text in the viewfinder. (Object and calorie recognition graduate in P3 — see 5.3.)
- **Signal-protocol double-ratchet E2E upgrade**, Passkeys/OAuth 2.1 optional account linking, encrypted knocks (knock payloads encrypted to the recipient `publicKey` — field already in the backend schema).
- **Group calls** via LiveKit SFU; **React Native app GA** (Stories posting arrives here); Redis 8 (Socket.IO adapter, presence), NATS or Kafka fanout, OpenSearch search, Sentry + OpenTelemetry/Prometheus/Grafana, coturn fleet, CI/CD with GitHub Actions + Trivy.
- **Moderation AI** assisting the staff report queue (never auto-punishing without human review).

### 5.3 P3 — Scale features
- **Channels**: one-to-many broadcast surfaces. Requires the P3 fanout backbone (Kafka/Pulsar, Go/Rust hot-path fanout service); deliberately not attempted on the P1 monolith.
- **Marketplace**: buying/selling surface attached to proximity (the Spot). Requires trust & safety maturity (moderation AI live, age verification wired) before listing anything; payments design is a separate future document.
- **Groups at very large scale (up to 500k members)**: groups exist today as conversations; the 500k target is a P3 requirement because it needs the event backbone, CRDT-style sync, and hot-path presence/fanout services. No group-size ceiling is promised to users before this infrastructure exists.
- **AI camera (full)**: object recognition and calorie estimation, served by vLLM-hosted models behind the LiteLLM router with Qdrant vector search.
- Multi-region Kubernetes + Terraform + Helm + Istio, ClickHouse analytics, Envoy, VictoriaMetrics.

---

## 6. User stories

### Language (P-1 Priya)
- As a Tamil speaker with an English keyboard, I type `vanakkam` and the app sends வணக்கம், so I never install another keyboard. *(Shipped)*
- As a reader, I always see the original message above/beside its translation — the app never hides what was actually said. *(Shipped)*
- As a Tamil speaker talking to a Hindi speaker, I speak in Tamil and my contact hears/reads Hindi, and vice versa. *(P2 — Universal Language Bridge)*
- As a traveler, I point my camera at a sign and read it in my language. *(P2 — AI camera, text stage)*

### Proximity (P-2 Arun)
- As a user at an event, I open Nearby and see people around me with approximate (~) distances, so I can knock and start talking. *(Shipped)*
- As a user who wants privacy right now, I enable ghost mode and disappear from discovery. *(Shipped)*
- As a new user, I practice on demo contacts that are clearly marked "demo" before talking to real people. *(Shipped)*
- As a user whose contact is offline, my message is delivered when they next open the app. *(P1 — RoomEvent replay)*

### Messaging (all personas)
- As a sender, I set a disappearing timer from 10 seconds to 3 months per chat. *(Shipped)*
- As a sender of a private photo, I am required to pick a view-once timer — there is no "keep forever" default for private photos. *(Shipped)*
- As a sender, I can edit or delete-for-everyone, understanding these are cooperative features. *(Shipped; honesty copy in Settings)*
- As a user, message info shows Sent and Read only — the app never shows a delivery tier it cannot verify. *(Shipped)*

### Voice and calls (P-4 Deepak)
- As a user, I record ~30 seconds once and can then send voice notes in my cloned voice. *(Shipped; vendor-plaintext caveat must be disclosed at enrollment — §9)*
- As a native-app user, I make voice/video calls with PiP and mute; media goes peer-to-peer and never touches the server. *(Shipped native; P1 keeps signalling-only on server)*
- As a group, we hold a group call. *(P2 — LiveKit SFU)*

### Safety and privacy (P-3 Meera)
- As a user, I read "What is actually private" in Settings and every claim on that card is true. *(Shipped; standing requirement)*
- As a user, I block someone and they can no longer reach me. *(Shipped)*
- As a user, I clear all data with a double confirmation and the app forgets me locally. *(Shipped)*
- As a staff member, I review reports with an audit trail. *(Backend shipped; dashboard in `spotme/admin-dashboard`)*

### AI assistant (P2)
- As a user returning to a long chat, I ask the assistant to summarize what I missed.
- As a user, I get suggested replies in my language, clearly marked as AI suggestions, and nothing is sent without my tap.

### Channels / Marketplace / Large groups (P3)
- As a creator, I broadcast to followers in a channel.
- As a local seller, I list an item visible to people nearby.
- As a community admin, I run a group larger than today's conversation-scale groups, up to 500k members.

---

## 7. Honesty rules — formal product requirements

These are shipped product decisions (`spotme/web/CONTRACT.md`, "Honesty rules") promoted here to numbered requirements. **Every current and future feature must comply. A feature that cannot comply does not ship.**

- **HR-1 — Approximate distances.** Distances always carry a tilde ("~24 m"). Positions are coarse by design; the product never implies precision it does not have.
- **HR-2 — Demo transparency.** Demo people always carry a visible "demo" chip. No demo content ever impersonates a real user.
- **HR-3 — Cooperative features admit they are cooperative.** View-once, delete-for-everyone, and disappearing timers depend on the other client cooperating. The product never claims more than that. The Settings screen carries the honesty copy; other screens stay clean.
- **HR-4 — No fake states.** No "Delivered" tier (Sent + Read only), no fake call UI on web (toast: "Calls arrive with the native app"), no pretend notification toggles (permission flows show real system state).
- **HR-5 — Privacy claims match the architecture.** The "What is actually private" card must be updated in the same change set as any transport/persistence change. P1 specifically: the server stores ciphertext only, but knock payloads are currently server-readable (they contain the room secret) — this limitation is documented, not hidden, until P2 encrypts knocks to the recipient's public key.
- **HR-6 — AI is labeled and consented.** (Extends the rules to the AI roadmap.) AI-generated content (assistant replies, translations beyond the shipped pipeline, AI-camera output) is visually attributed as AI; cloned-voice enrollment discloses that audio is sent to a third-party vendor; nothing AI-generated is sent on the user's behalf without an explicit user action.
- **HR-7 — No invented numbers.** Product copy, marketing, and internal documents state only measured or sourced figures. This PRD contains no market-size or revenue claims for that reason.

---

## 8. Success criteria

No adoption or revenue targets are set here (that requires sourced market research). Success is defined as verifiable product behaviour:

**P1 (migration) is done when:**
1. All §4 shipped features work unchanged on the Socket.IO transport (regression pass across the views in `spotme/web/src/views/`).
2. A message sent to an offline recipient is delivered on their next open (RoomEvent replay verified with two real clients).
3. A knock sent to an offline recipient opens the chat when they return (durable knock verified).
4. The server can be shown to store only ciphertext for persistent message payloads.
5. The P0 video persistence bug is re-verified as fixed on the new transport.
6. Guest auth issues a stable `selfId` that survives reconnects and app restarts.
7. Calls still negotiate peer-to-peer with server-side signalling only.
8. The production deployment is live again (it is currently 404 — §9) with a documented deploy ritual.

**P2 is done when:** double-ratchet E2E is live without breaking split-bubble translation; knocks are encrypted to recipient keys; group calls work on the SFU; the React Native app (including Stories posting) is GA; the AI assistant and Universal Language Bridge meet HR-6; the 7 translation-pipeline issues are closed.

**P3 is done when:** channels, marketplace, and 500k-member groups run on the scale backbone with moderation AI and age verification live, and multi-region failover is demonstrated.

---

## 9. Constraints and known risks (do not soften)

| Risk / constraint | Status | Owner phase |
|---|---|---|
| Video persistence bug (P0 in P2P transport) | Fixed by server persistence in principle — **must be re-verified** | P1 |
| Cloned voice sends plaintext audio to vendor | GDPR/BIPA exposure; requires disclosure at enrollment + documented mitigation, not marketing | P1 (disclosure), P2 (mitigation review) |
| Knock payloads server-readable (contain room secret) | Documented limitation; encrypt to recipient `publicKey` (schema field exists) | P2 |
| Push notifications dormant | 5 Vercel env vars unset (`spotme/web/api/push.js`) | P1 |
| NCMEC/CSAM pipeline needs API key | Blocks real media at scale | Before public media launch |
| Translation pipeline: 7 open issues | Blocks Universal Language Bridge | P2 gate |
| Age verification vendor not wired | Blocks marketplace and teen-safety commitments | P3 gate (marketplace), earlier if policy requires |
| Prod deployment currently 404 | Needs redeploy | P1 |
| Team = one developer + AI agents, budget-conscious | Hosting choices: Neon/Railway/Fly/Hetzner-class, not day-one AWS EKS | All phases |

---

## 10. Non-goals

- **No accounts, passwords, or phone numbers** — ever, as a core product identity. Optional Passkey/OAuth linking (P2) must remain optional.
- **No feed / algorithmic timeline.** Stories are ephemeral rings, not a ranked feed.
- **No advertising surface** in any current phase; monetization design (marketplace excepted) is out of scope for this PRD.
- **No precise-location sharing in discovery.** Coarse positions with ~distances only (HR-1). (Explicit live-location sharing inside a chat is a deliberate user action and remains supported.)
- **No fake capability claims**: no "Delivered" tier, no web call UI, no "guaranteed deletion" language (HR-3/HR-4).
- **No server-readable message content** for persistent chat payloads — the P1 architecture stores ciphertext only, and no future feature may weaken this without a documented, user-visible change to the honesty card (HR-5).
- **No day-one hyperscale infrastructure.** P3 technologies (Kafka/Pulsar, multi-region K8s, Go/Rust services) are explicitly deferred until the scale stage.
- **No invented metrics** in product or planning documents (HR-7).

---

## 11. References (repo paths)

- View contract and honesty rules: `spotme/web/CONTRACT.md`
- Views: `spotme/web/src/views/{inbox,chat,discovery,bluetooth,contacts,groups,stories,profile,notifications}.{js,css}`
- Libraries: `spotme/web/src/lib/{db.js,discovery.js,rooms.js,translate.js,media.js,demo.js,ui.js,net.js,reach.js,socket-transport.js}`
- Design tokens (locked): `spotme/web/src/tokens.css`; locked screen designs: `spotme/design/`
- Serverless API (pre-migration): `spotme/web/api/{turn.js,username.js,knock.js,push.js,translate.js,voice.js,presence.js}`
- Backend (NestJS + Prisma): `spotme/backend`; staff UI: `spotme/admin-dashboard`
- Native tracks: `spotme/app`, `spotme/mobile`; Hypercore P2P library: `spotme/core` (transliteration engine: `spotme/core/translit.js`)
