# 14 — V1 Migration Plan → V2 Roadmap Mapping

**Date:** 2026-08-01 · **Sources:** `MIGRATION-PLAN-V1.md` (historical) →
`MASTER-ENGINEERING-ROADMAP-V2.md` · **Repo evidence:** `master` = `f9a5af8`
(+ open PRs noted) and `13-PRODUCT-AUDIT.md`.

**Purpose (V2 §10.3–4):** every V1 requirement accounted for, none silently
lost. Status vocabulary is V2's: **implemented · partial · blocked · missing ·
deprecated · out of scope**. "blocked" always names the blocker.

**Approval state: PENDING.** Per V2 Appendix B, V2 becomes the controlling
direction only after the owner reviews and approves this mapping. Until then
V1 governs, and where V1 is stricter, the stricter gate remains either way.

---

## ⚠️ 1. The renumbering trap — read this first

V1 and V2 use the same words ("Priority N") for **different things**. Every
standing owner decision was issued against V1 numbering and **carries over by
subject, not by number**:

| V1 priority | Subject | Lands in V2 as |
|---|---|---|
| P0 | Repository audit | done — `10-PRIORITY-0-AUDIT.md`, `13-PRODUCT-AUDIT.md` |
| P1 | Zero-trust E2EE | **P1** (unchanged subject) |
| P2 | Media system | **P4** |
| P3 | Realtime infrastructure | **P3** (same number, same subject) |
| P4 | Presence & nearby | **P8** |
| P5 | Voice & video | **P5** (same) |
| P6 | Push notifications | split: iOS push → **P2**; reliability/receipts → **P2/P9** |
| P7 | Translation & AI | **P6** (expanded into the AI Communication Platform) |
| P8 | Performance optimisation | **P9** (budgets/benchmarks) |
| P9 | Observability | **P9** |
| P10 | Mobile platform | **P10** |
| P11 | Production hardening | **P2** (launch safety) + **P11** (business/enterprise split out) |
| P12 | Final validation | **P13** |
| — (new in V2) | Communities/channels/social | **P7** |
| — (new in V2) | Live voice translation & voice preservation | **§6 + P6** |
| — (new in V2) | Developer platform | **P12** |

**Standing owner blocks, restated under V2 numbering so renumbering cannot
lift them silently:**

- "Priorities 2 and 3 remain blocked" (V1 numbering) = **V2 P4 (media) and
  V2 P3 (realtime) remain blocked** until the owner unblocks them.
- Railway deployment remains blocked. #8 (ybot) untouched.
- **ADR-008 §12 hard stop** unchanged: no signing-key generation, persistence,
  publication, revocation transport, prekeys, X3DH, ratchet, or multi-device
  implementation until rollback-after-publication is executable or separately
  authorized. V2 P1's own line — "secure signing-key storage with executable
  rollback-after-publication behavior" — **encodes this stop**; it does not
  lift it.
- E2E scenarios 2–12 + test seam: approved and next in queue (V2 §8's "E2E
  through real product paths" gate).

## 2. V1 global rules & per-change discipline → V2

| V1 requirement | Status | V2 home / evidence |
|---|---|---|
| Never rewrite the app / breaking changes / remove features / duplicate code / invent APIs | **implemented** as practice | V2 §2.1–2.3 restate them |
| Never skip testing / documentation / benchmarks | **partial** | testing+docs held throughout; **benchmarks not yet done for identity work** (owner-scoped list outstanding) |
| Never advance past an incomplete priority | **implemented** | V2 §10.6 restates |
| Inspect → explain → compare → recommend → migrate → rollback (per change) | **implemented** as practice | ADR trail 001–008 |
| Completion checklist (12 items) | **partial** | superset now in V2 §8 (15 items, stricter: artifact verification, tail latency, monitoring-before-enable). V1 gaps still open: web type checking, identity benchmarks, formal security review, performance review |

## 3. V1 Priority 1 (E2EE) — item by item

| V1 item | Status | Evidence / blocker |
|---|---|---|
| Audit current crypto | **implemented** | ADR-001, V-19 analysis, `13-PRODUCT-AUDIT.md` §7 |
| Remove legacy crypto where safely possible | **partial — deliberate** | e2e_v1 retained for legacy rooms + wire compat; negative-control tested; full removal deferred to e2e_v3 migration (V2 P1 "legacy readability") |
| Device verification | **implemented** | A1–A4 merged (#24–#26): pinning, five states, bound QR verification |
| QR safety numbers | **implemented** | #26/#28; camera path device-unproven (manual matrix) |
| Identity enforcement (implied by "device verification") | **partial** | PR #31 built, flag OFF, awaiting owner review + manual matrix (V2 P1 item 1) |
| Secure key storage | **partial + blocked** | agreement key: implemented (non-extractable, IndexedDB, write-verified). Signing key: designed (ADR-008), **blocked by ADR-008 §12** |
| Signed prekeys | **missing + blocked** | V2 P1; blocked behind ADR-008 §12 |
| One-time prekeys | **missing + blocked** | same |
| X3DH | **missing + blocked** | designed (ADR-004 family, vectors); same blocker |
| Double Ratchet | **missing + blocked** | designed (ADR-004b vectors); same |
| Forward secrecy | **missing** | arrives with the ratchet |
| Break-in recovery | **missing** | same |
| Key rotation | **partial** | accept/verify/reject of a changed key implemented (A2–A4); scheduled/automated rotation missing |
| Multi-device support | **missing + blocked** | normative minimum in ADR-006; **blocked on the safety-number device-set question (ADR-008 §BLOCKING)** |
| Server must never decrypt | **implemented for v2** | ECDH keys never serialisable; v1 legacy is the documented exception being retired |
| Backward compat / legacy readable | **implemented** | v1 rooms still open; e2e_v3 compat package written |
| Benchmark encryption performance | **missing** | owner-scoped benchmark list outstanding (pin-store, concurrent observes, A5 overhead, startup, 100s–1000s peers) |

## 4. V1 Priorities 2–12 → V2 (task-level)

### V1 P2 Media → V2 P4 — **blocked (owner)** as a priority; item status:
encrypt-locally **implemented** · presigned **implemented** (`/v2/media`) ·
R2 **partial** (gated smoke) · cleanup **implemented** (cron) · view-once
deletion **implemented** · multipart/resumable/dedup/SHA-256/thumbnails/
malware-hooks/CDN **missing** · per-attachment keys in ratcheted envelopes
**missing + blocked** (needs the ratchet).

### V1 P3 Realtime → V2 P3 — **blocked (owner)**; seams exist:
Centrifugo adapter + backend module **partial (flag-gated)** · P2P adapter
**partial (flag-gated)** · replay/reconnect/cursor logic **implemented** and
regression-tested · Redis/Dragonfly selection, horizontal gateways, durable
queues, load tests **missing**. V2 adds an explicit either/or rule for
Redis vs Dragonfly.

### V1 P4 Nearby → V2 P8: map+GPS **implemented** · BLE **partial
(device-unproven)** · H3/PostGIS, friend-only modes, retention limits,
battery work **missing**. Privacy threat-model gate added by V2 — **stricter,
adopt**.

### V1 P5 Voice/Video → V2 P5: 1:1 signalling+TURN **partial** ·
ICE restart/recovery/ABR/telemetry **missing** · group calls/SFU **missing**
(V2: LiveKit only after audit) · echo/noise: browser-level **implemented**.

### V1 P6 Push → V2 P2/P9: web **implemented** · Android FCM **implemented** ·
**iOS missing** (dep installed, unwired — V2 P2 says implement or remove) ·
receipts/collapse/queues **missing**.

### V1 P7 Translation & AI → V2 P6: text translation **implemented (provider
risk)** · transliteration **implemented** · STT/TTS **implemented** via authed
proxy · **voice cloning implemented for voice notes** (corrected — see §6
below) · provider abstraction/fallback/quality/memory **missing** · live
voice translation + voice-preserving calls **missing** (the V2 differentiator,
new scope).

### V1 P8 Performance → V2 P9: IndexedDB/media benchmarks **implemented**
(reproducible packages) · identity benchmarks **missing** · budgets/profiling
**missing**.

### V1 P9 Observability → V2 P9: **missing** entirely (no metrics endpoint,
no Sentry-equivalent, no traces; prom-client is a dead dep).

### V1 P10 Mobile → V2 P10: Android Capacitor **partial** · iOS **missing** ·
Hypercore/Expo track **needs explicit disposition** (V2 makes this a named
decision — new, adopt).

### V1 P11 Hardening → V2 P2 + P11: JWT dual-secret **missing** (finding R5)
· rate limits **missing** · junk/dead-dep cleanup **missing** (inventoried in
audit §13) · health/readiness **missing** (BUILD_ID `/api/version` exists) ·
secrets rotation procedure **partial** (R2 rules exist) · blue/green, DR
rehearsal **missing** · org accounts/enterprise (V2 P11) **out of scope of
V1 — new**.

### V1 P12 Final validation → V2 P13: **missing** (end-state gate; unchanged
in substance).

## 5. New in V2 with no V1 ancestor

Communities/channels/broadcast/polls/mentions/threads/bookmarks/scheduled/
global search (P7) · live voice translation & voice preservation (§6, P6) ·
developer platform/bots/plugins (P12) · business/enterprise (P11) · desktop
strategy (P10) — all **missing**, all sequenced behind P1 per V2 §10.6.

**Deprecated:** nothing in V1 is deprecated by V2. **Out of scope:** nothing
V1 required has been dropped; V1's strictest gates (e.g. its completion
checklist) survive via V2 §8 + Appendix B.

## 6. Audit correction executed under V2 §10.5

`13-PRODUCT-AUDIT.md` (PR #34) understated **ElevenLabs voice cloning** as
experimental. Repository evidence, re-examined: full lifecycle client
(`lib/voice.js` — `cloneVoice`, `deleteClone`, cloned-TTS), enrollment UI with
a one-clone-per-profile rule (`views/profile.js:443–622`), quota-bucketed
`clone`/`unclone` proxy ops (`web/api/voice.js`), and a working product flow —
**voice-note translation re-voiced in the sender's cloned voice**
(`views/chat.js:3997–4112`: STT → translate → cloned TTS → sends the mp3).
The audit is corrected on PR #34 to **implemented for voice notes** (limits:
no consent/audit UX beyond enrollment, no live-call path — that is V2 §6).
This also means **voice preservation is "partial", not "missing"**: the
asynchronous form already ships; the live-call form is the roadmap item.
