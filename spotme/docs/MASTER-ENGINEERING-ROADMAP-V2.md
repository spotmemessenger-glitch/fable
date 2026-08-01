# SPOT ME — Engineering Master Roadmap V2

> Production-grade secure messaging, AI-native communication, and global
> platform expansion. Prepared from the current Spot Me product audit and
> engineering migration work.
>
> **Provenance:** faithful markdown transcription of the owner-supplied
> `MASTER-ENGINEERING-ROADMAP-V2.docx` (committed alongside, byte-identical to
> the 2026-08-01 upload). Tables reconstructed from the document's own rows;
> no content added or removed. The V1 migration plan is preserved at
> `MIGRATION-PLAN-V1.md`; the V1→V2 requirement mapping lives at
> `14-ROADMAP-V1-TO-V2-MAPPING.md`.

**Product vision:** Speak any language. Your contacts hear you in theirs — in
your own voice — while privacy, identity verification, and end-to-end security
remain core platform guarantees.

## 1. Executive Summary

Spot Me is a privacy-first communication platform with a substantial messaging
core already implemented. The current product includes one-to-one and group
messaging, voice notes, media sharing, view-once media, reactions, replies,
edit/delete, disappearing messages, presence, read receipts, location sharing,
translation, transliteration, nearby discovery, WebRTC calling, identity
pinning, QR safety-number verification, and multiple transport/storage seams.

This V2 roadmap does not restart completed work. It preserves existing
functionality and closes the remaining gap to a platform comparable in breadth
and reliability to WhatsApp, Telegram, Facebook Messenger, and Signal, while
giving Spot Me a distinct product identity through live multilingual voice
communication and voice preservation.

### Guiding outcome

- WhatsApp-level reliability for everyday messaging, media, calls, push
  notifications, sync, and device support.
- Telegram-level groups, channels, broadcast, search, extensibility, and
  large-scale content distribution.
- Messenger-level social communication, stories, reactions, media richness,
  and cross-device usability.
- Signal-level security properties: verified identity, X3DH, prekeys, Double
  Ratchet, forward secrecy, break-in recovery, and secure multi-device
  operation.
- Spot Me differentiation: live voice translation, translated subtitles, voice
  preservation, transliteration, nearby discovery, and optional privacy modes.

### Current engineering baseline

| Capability | Current State | Target State | Priority |
|---|---|---|---|
| Messaging core | Strong; most core user flows implemented | Highly reliable, scalable, cross-device | Continue hardening |
| Identity security | Pinning and verification substantially implemented | Enforced trust and revocation lifecycle | Priority 1 |
| Signal-style protocol | Designed; core v3 implementation incomplete | X3DH + Double Ratchet + multi-device | Priority 1 |
| Media | Client encryption, slicing, local/S3 seam, view-once | CDN, thumbnails, transcoding, resumable upload | Priority 4 |
| Calls | 1:1 WebRTC path present | Reliable voice/video, ICE recovery, group calls | Priority 5 |
| Translation | Text translation and transliteration live | Official provider abstraction and quality control | Priority 6 |
| Voice AI | STT/TTS integrated; voice cloning partially evidenced | Live translated calls with voice preservation | Priority 6 |
| Realtime | Socket.IO primary; Centrifugo/P2P seams exist | Horizontally scalable, replayable, observable | Priority 3 |
| Operations | CI and real integration testing improved | Full SRE/observability/DR maturity | Priority 2/9/11 |

## 2. Non-Negotiable Engineering Rules

1. The repository is the source of truth. Do not invent APIs, data models, or
   architecture.
2. Do not rewrite the whole product. Migrate incrementally.
3. Do not remove working features without explicit approval and documented
   replacement.
4. Do not merge code solely because CI is green; require scope review,
   regression evidence, rollback, and documentation.
5. Each priority must be split into small, independently testable and
   reversible PRs.
6. Feature flags must default to the safe state and have an operational
   rollback path.
7. Security-sensitive state must never be logged, exposed to analytics, stored
   in ordinary localStorage, or sent to the server.
8. Third-party integrations must be abstracted, measurable, replaceable, and
   protected by least-privilege credentials.
9. No priority is complete until tests, type checking/static analysis, lint,
   benchmarks, security review, performance review, documentation, and
   rollback evidence all pass.

## 3. Current Product State

The following is the working product baseline derived from the current
engineering audit.

### 3.1 Implemented or substantially implemented

- Guest authentication, refresh tokens, employee/admin login, profiles,
  usernames, contacts.
- One-to-one messaging and group chat with roles, permissions, bans, and join
  flows.
- Text, voice notes, photos, files, location messages, view-once media,
  replies, reactions, forward, edit and delete.
- Typing indicators, read receipts, presence, last-seen controls, retry and
  reconnect behavior.
- Disappearing messages and device data wipe.
- Basic stories/status backend and minimal UI.
- Nearby map discovery and Bluetooth discovery paths, though hardware
  validation is incomplete.
- Web push and Android push; iOS push remains incomplete.
- Per-message and whole-chat translation, transliteration, language guards.
- ElevenLabs speech-to-text and text-to-speech integration through an
  authenticated proxy.
- 1:1 WebRTC signalling and Cloudflare TURN integration.
- PostgreSQL/Prisma, S3-compatible storage, MinIO CI, local storage adapter,
  Cloudflare R2-compatible path.
- Socket.IO transport plus Centrifugo and P2P transport seams.
- Identity pinning, trust states, QR/safety-number verification, device wipe
  of trust data.
- CI with unit, integration, build, lint, and Playwright E2E foundation.

### 3.2 Partial, hidden, experimental, or unproven

- Voice and video calling are not yet validated across physical devices, NATs,
  poor networks, or reconnect scenarios.
- Voice cloning exists as an integration/experimental capability but lacks a
  fully audited product flow in the current tree.
- Stories UI is minimal.
- Contacts and archive are thin.
- Nearby and Bluetooth flows require privacy, battery, and hardware
  validation.
- Centrifugo and P2P transports are feature-gated and not production defaults.
- Identity enforcement is designed/dark but must be independently validated
  before activation.
- Cloudflare R2 provider smoke evidence and production storage operation
  remain gated.
- Native Hypercore/Expo client is a separate older product track and needs an
  explicit disposition.

### 3.3 Missing or materially incomplete

- X3DH, signed prekeys, one-time prekeys, Double Ratchet, forward secrecy,
  break-in recovery, and complete multi-device cryptography.
- Channels, communities, broadcast lists, polls, mentions, threads, bookmarks,
  scheduled messages, and robust global search.
- iOS push notifications.
- Group voice/video calls, ICE restart, call recovery, adaptive bitrate
  control, and call quality telemetry.
- Streaming live voice translation and voice-preserving translated calls.
- Official translation provider abstraction, quality scoring, and translation
  memory.
- Media thumbnails, video transcoding, resumable uploads, malware scanning,
  deduplication, CDN configuration.
- Redis/Dragonfly-backed realtime scale, durable queues, and replayable
  streams.
- Production observability: metrics, traces, centralized logs, alerts,
  dashboards, and Sentry-equivalent error tracking.
- Formal security and performance reviews across all security-sensitive work.

## 4. Competitive Gap Analysis

| Capability | Current State | Target State | Priority |
|---|---|---|---|
| Reliable 1:1 messaging | Strong | Reach parity across devices and failure modes | High |
| Large groups | Implemented foundation | Scale, moderation, search, admin tooling | High |
| Channels/broadcast | Missing | Telegram/WhatsApp-style distribution | High |
| Stories/status | Partial | Polished creation, viewers, privacy, media tools | Medium |
| Voice/video calls | Partial | Reliable 1:1 and group calling | High |
| Cross-device sync | Incomplete | Secure multi-device fan-out and history | Critical |
| Signal-grade protocol | Incomplete | X3DH, prekeys, Double Ratchet, recovery | Critical |
| Global search | Minimal | Messages, media, users, groups, channels | High |
| Push parity | Web/Android only | Reliable iOS/Web/Android | Critical |
| Communities | Missing | Structured spaces, topics, announcements | Medium |
| Bots/platform APIs | Missing | Webhooks, SDKs, bot runtime | Medium |
| Live voice translation | Missing | Core differentiator | Critical |
| Voice preservation | Partial capability | Consented real-time translated voice | Critical |

## 5. Updated Engineering Priorities

### Priority 1 — Complete Secure Messaging

- Finish persisted identity enforcement and safe recovery UX.
- Implement secure signing-key storage with executable
  rollback-after-publication behavior.
- Implement signed prekeys and one-time prekeys.
- Implement X3DH session establishment.
- Implement secure ratchet persistence and the Double Ratchet.
- Deliver forward secrecy and break-in recovery.
- Implement key rotation and device removal.
- Implement the minimum multi-device cryptographic model.
- Maintain legacy conversation readability and mixed-version compatibility.
- Complete security, performance, benchmark, device, E2E, migration, and
  rollback evidence.

### Priority 2 — Production Hardening and Launch Safety

- Auth and OTP rate limits, abuse controls, lockouts, and suspicious-activity
  monitoring.
- Separate access and refresh secrets and review token lifecycle.
- iOS push implementation and full killed/background/foreground validation.
- Official health checks, readiness/liveness, and deployment smoke tests.
- Secure secrets management and credential rotation procedures.
- Remove junk files, dead dependencies, dead environment variables, and stale
  branches.
- Formal incident response, data retention, account deletion, and privacy
  documentation.
- Blue/green or canary deployment, rollback automation, database migration
  rehearsal.

### Priority 3 — Realtime and Messaging Scale

- Audit Socket.IO gateway, Centrifugo adapter, P2P path, presence, receipts,
  reconnect, and replay.
- Select Redis or DragonflyDB through benchmarks and failure testing; do not
  integrate both by default.
- Implement horizontal gateways, shared presence, rate limits, distributed
  locks, and ephemeral state.
- Introduce durable streams/queues where required, with message replay and
  idempotency.
- Implement backpressure, bounded queues, connection admission, stream
  recovery, and load shedding.
- Load-test messaging, typing, presence, read receipts, groups, reconnect
  storms, and offline delivery.

### Priority 4 — Media Platform

- Presigned upload/download as the primary path.
- Resumable and multipart uploads with background retry.
- Thumbnail generation, metadata extraction, audio waveforms, and video
  transcoding.
- SHA-256 integrity manifests and safe deduplication.
- Malware scanning hooks and quarantine workflow.
- CDN and cache-control strategy.
- Random per-attachment encryption keys delivered inside ratcheted envelopes.
- View-once deletion of both media bytes and retained key material.
- Storage lifecycle policies, cleanup, cost dashboards, and disaster recovery.

### Priority 5 — Voice and Video Platform

- Harden 1:1 WebRTC audio/video across devices and browsers.
- Implement ICE restart, network switching recovery, reconnect, and NAT
  traversal validation.
- Add adaptive bitrate, simulcast where appropriate, jitter/packet-loss
  telemetry, and call quality scoring.
- Use browser/platform echo cancellation and noise suppression, then evaluate
  advanced processing.
- Implement group voice/video with a reviewed SFU architecture such as LiveKit
  only after audit.
- Add call history, missed-call notifications, permissions, privacy controls,
  and abuse controls.

### Priority 6 — AI Communication Platform

- Make AI communication a first-class product area rather than a miscellaneous
  feature.
- Harden existing ElevenLabs STT/TTS proxy with quotas, timeouts, cost
  controls, retries, redaction, and provider abstraction.
- Implement user-consented voice enrollment, voice profile management,
  deletion, replacement, and audit history.
- Implement live translated calls: streaming STT, translation, TTS, subtitles,
  and graceful fallback.
- Implement voice preservation so translated speech is rendered using the
  original speaker's consented voice profile.
- Support interruption handling, turn-taking, partial transcripts, language
  detection, and context-aware translation.
- Add optional original-audio playback and a visible AI-generated-audio
  indicator.
- Add provider fallback, quality scoring, translation memory, latency
  monitoring, and cost monitoring.
- Define private modes: cloud, self-hosted, and on-device where feasible.

### Priority 7 — Communities, Channels, and Social Features

- Communities with roles, spaces, topics, announcements, and moderation.
- Channels and broadcast lists.
- Polls, mentions, threaded replies, pinned content, scheduled messages,
  bookmarks.
- Rich stories/status, privacy controls, viewer management, and media editing.
- Public/private profiles, QR invites, invite links, and discovery controls.
- Global search across users, chats, groups, media, stories, and channels.

### Priority 8 — Discovery and Nearby Platform

- Privacy-preserving nearby discovery using GPS, H3/PostGIS, and explicit
  visibility controls.
- Bluetooth LE discovery with real-device validation and battery limits.
- Map clustering, friend-only modes, temporary location sharing, and
  block/report integration.
- Business and event discovery only after privacy threat modeling.
- Location retention limits, coarse-location modes, and abuse prevention.

### Priority 9 — Observability, Performance, and SRE

- OpenTelemetry instrumentation for backend, web, realtime, storage, AI, and
  calls.
- Prometheus-compatible metrics, dashboards, logs, traces, alerts, and error
  tracking.
- Performance budgets for CPU, memory, battery, startup, reconnect, media, and
  database queries.
- Capacity planning, synthetic checks, uptime objectives, error budgets, and
  on-call procedures.
- Chaos/failure testing for database, storage, TURN, translation, push, and
  realtime dependencies.

### Priority 10 — Mobile and Multi-Platform

- Complete Android Capacitor production validation.
- Implement and validate iOS support, push, background handling, camera,
  microphone, QR, and calls.
- Offline mode, deep links, background sync, battery optimization, and
  app-store readiness.
- Desktop strategy for Windows/macOS/Linux and tablet layouts.
- Explicitly decide whether the Hypercore/Expo client is retired, merged, or
  maintained as a separate product.

### Priority 11 — Business, Enterprise, and Moderation

- Organization accounts, managed devices, policies, and audit logs.
- Admin dashboards, analytics, moderation queues, and appeals.
- Export and compliance tooling with privacy safeguards.
- Complete CSAM/NCMEC-related integrations only with legal review and approved
  provider access.
- Business profiles, verified accounts, support workflows, and optional
  enterprise identity.

### Priority 12 — Developer Platform and Ecosystem

- Public API and scoped OAuth/application credentials.
- Webhooks, SDKs, bots, and extension model.
- Plugin security model, permissions, quotas, review process, and marketplace
  governance.
- No plugin may access plaintext, keys, or private media without explicit user
  authorization and isolation.

### Priority 13 — Final Production Validation

- No new product features.
- Run complete audits of all APIs, sockets, encryption, media, calls, AI,
  push, background work, mobile flows, and deployment paths.
- Complete final architecture, scalability, benchmark, security, privacy, and
  production-readiness reports.
- Resolve all critical and high-severity findings before declaring completion.

## 6. Live Voice Translation and Voice Preservation Specification

This capability is Spot Me's primary product differentiator. It must be
engineered as a realtime communications pipeline with explicit latency,
privacy, consent, cost, reliability, and fallback requirements.

### 6.1 Target user experience

A speaker talks naturally in one language. The listener hears the meaning in
their selected language, rendered using the speaker's explicitly enrolled
voice profile. Live captions remain available, and the original audio may
optionally be mixed or replayed.

### 6.2 Realtime pipeline

1. Capture microphone audio through the WebRTC call path.
2. Create short streaming audio segments with voice activity detection and
   interruption support.
3. Run streaming speech-to-text with partial and final transcripts.
4. Detect or confirm the source language.
5. Translate partial/final text using a provider abstraction with conversation
   context.
6. Synthesize translated speech using the speaker's consented voice profile.
7. Buffer and schedule audio playback to preserve conversational order while
   minimizing delay.
8. Display live translated captions and fallback to captions/original audio if
   AI processing degrades.

### 6.3 Required architecture boundaries

- Calls must continue to work when translation is disabled or unavailable.
- The realtime call transport, translation provider, and voice provider must
  remain replaceable modules.
- Voice profiles must not be silently created, shared, copied, or used for
  another account.
- No third party receives more audio or metadata than required for the enabled
  feature.
- Call participants must see when translated or synthesized audio is active.
- The system must never claim full end-to-end privacy if cloud AI providers
  receive decrypted audio.

### 6.4 Consent and abuse safeguards

- Explicit voice-enrollment consent with a clear sample recording flow.
- Voice profile ownership bound to the authenticated user/device.
- Delete, replace, disable, and re-enroll controls.
- Clear AI-generated speech indicator during calls and playback.
- No cloning of another person from uploaded or intercepted audio.
- Provider and application audit events without storing raw voice content by
  default.
- Rate limits, usage limits, abuse reporting, and account sanctions.
- Legal and policy review for supported regions and languages.

### 6.5 Initial performance targets

| Metric | MVP Target | Production Target |
|---|---|---|
| Partial caption latency | < 1.5 s | < 700 ms |
| Translated voice first-audio latency | < 3.0 s | < 1.5 s |
| Translation failure fallback | < 2 s | < 1 s |
| Call continuity during provider failure | Original audio continues | Original audio + captions continue |
| Voice profile deletion propagation | < 24 h | < 1 h |
| Supported languages | 5–8 validated pairs | Prioritized global language set |

Targets are initial engineering objectives and must be validated against
provider capabilities, network conditions, device performance, and user
testing.

## 7. Third-Party Integration Strategy

| Capability | Current State | Target State | Priority |
|---|---|---|---|
| PostgreSQL / Prisma | Active | Primary durable database | Keep and harden |
| Cloudflare R2 / S3 APIs | Partially validated | Media storage | Complete protected provider smoke and production rollout |
| MinIO | Active in CI | Deterministic S3 integration testing | Keep as CI dependency |
| Cloudflare TURN | Active/partial | WebRTC relay | Benchmark, monitor, and add fallback |
| Google Maps | Active | Nearby map | Review privacy and cost |
| ElevenLabs | STT/TTS active; cloning needs product verification | Voice AI | Abstract, quota, consent, cost, fallback |
| Google GTX endpoint | Active but unofficial | Translation | Replace with supported provider |
| MyMemory | Fallback | Translation | Retain only with measured quality/terms |
| Firebase Admin | Active | Android push | Keep |
| Web Push/VAPID | Active | Web push | Keep |
| APNs library | Installed but unwired | iOS push | Implement or remove |
| Centrifugo | Feature-gated | Realtime alternative | Benchmark before production decision |
| Redis / DragonflyDB | Not integrated | Realtime/cache/queues candidate | Select during Priority 3 audit |
| Sentry/OpenTelemetry stack | Absent | Observability | Add under Priority 9 |

### Integration rules

- Every provider must have an adapter or service boundary.
- Credentials must live only in approved secret stores and must be least
  privilege.
- Provider timeouts, retries, quotas, cost, regional availability, and data
  retention must be documented.
- Production must degrade gracefully when non-core providers fail.
- No provider may become an undocumented protocol dependency.

## 8. Completion Checklist for Every Priority

- ☐ Code compiles and production artifacts are verified, not only command
  exit codes.
- ☐ Backend type checking and web static analysis/type checking pass.
- ☐ Lint passes.
- ☐ Unit tests pass.
- ☐ Integration tests pass against provisioned dependencies.
- ☐ End-to-end tests pass through real product paths.
- ☐ Existing functionality remains operational.
- ☐ No known regression is accepted without explicit documented approval.
- ☐ Documentation and architecture decisions are updated.
- ☐ Benchmarks include environment, raw results, median, tail latency, and
  comparison.
- ☐ Security review is completed with findings and dispositions.
- ☐ Performance review is completed.
- ☐ Migration and rollback are tested and documented.
- ☐ Feature flags and operational controls are documented.
- ☐ Production monitoring and alerting exist before enabling high-risk
  behavior.

## 9. Delivery Milestones

| Milestone | Exit Outcome |
|---|---|
| Private Alpha | Current proven messaging, translation, voice notes, limited calls; invite-only; known limitations disclosed. |
| Closed Beta | Priority 1 secure messaging substantially complete; iOS/Android validation; reliable push; core observability. |
| Public Beta | Realtime/media/calls hardened; official translation provider; live captions; limited live voice translation. |
| Production Launch | Signal-style security, multi-device, operational maturity, full mobile parity, abuse controls, DR. |
| AI Communication Launch | Voice-preserving translated calls with consent, quotas, quality metrics, provider fallback, and privacy modes. |
| Platform Expansion | Communities, channels, enterprise, bots, public APIs, desktop and broader ecosystem. |

## 10. Immediate Instructions for Claude

1. This roadmap is an updated engineering control document. Claude must
   reconcile it with the existing migration plan and current repository state
   before changing priorities.
2. Commit this roadmap as docs/MASTER-ENGINEERING-ROADMAP-V2.md (or
   equivalent) without deleting the historical migration plan.
3. Create a mapping from every existing migration-plan requirement to this V2
   roadmap so no requirement is silently lost.
4. Mark each item as implemented, partial, blocked, missing, deprecated, or
   out of scope.
5. Correct the product audit where repository evidence conflicts with
   user-confirmed behavior, especially ElevenLabs voice cloning.
6. Do not start new priorities while the current Priority 1 gate remains open.
7. Create a detailed implementation sequence for the remaining Priority 1
   work.
8. Create a separate AI Communication ADR covering live translation, voice
   preservation, privacy, consent, latency, provider abstraction, and failure
   behavior.
9. Return the mapping, Priority 1 sequence, and AI Communication ADR outline
   for approval before implementation.

## Appendix A — Current Feature Inventory Snapshot

| Feature Area | Current State |
|---|---|
| Authentication and profiles | Implemented; OTP delivery incomplete |
| 1:1 and group messaging | Implemented |
| Voice notes | Implemented |
| Media/files/view-once | Implemented with further media-platform work pending |
| Replies/reactions/edit/delete/forward | Implemented |
| Typing/read receipts/presence | Implemented |
| Disappearing messages | Implemented |
| Location messages | Implemented |
| Stories/status | Partial |
| Nearby map/Bluetooth discovery | Partial; device and privacy validation pending |
| Voice/video calls | Partial |
| Text translation/transliteration | Implemented; provider risk |
| STT/TTS | Integrated through ElevenLabs; production limits pending |
| Voice cloning | User-confirmed working for voice notes; repository product-flow evidence requires reconciliation |
| Live voice translation | Missing |
| Voice-preserving translated calls | Missing; primary roadmap differentiator |
| Web/Android push | Implemented |
| iOS push | Missing |
| Identity pinning/QR verification | Substantially implemented |
| X3DH/Double Ratchet/multi-device | Missing implementation |
| Channels/communities/broadcast | Missing |
| Observability/SRE stack | Missing |

## Appendix B — Document Governance

- The original migration plan remains historical and must not be silently
  overwritten.
- This V2 roadmap becomes the current product/engineering direction after the
  repository mapping is reviewed and approved.
- Where the original plan is stricter, the stricter completion gate remains
  unless explicitly amended.
- Status percentages are estimates; code, tests, and deployment evidence
  control completion.
