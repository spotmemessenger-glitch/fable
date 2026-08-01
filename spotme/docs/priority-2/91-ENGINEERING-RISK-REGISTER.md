# Priority 2 — Engineering Risk Register & Owner-Decision Register

**Planning only. Priority 1 frozen.** Consolidated and de-duplicated from the five
workstream designs. Two registers: **A** = decisions only the owner can make
(threat-model, product, cost), which gate or shape implementation; **B** =
engineering risks the team owns, with mitigations. Nothing here is resolved by
this document — the decisions are escalated, the risks are tracked.

## A. Owner-decision register (blocks/shapes implementation)

Priority: **P0** = blocks the workstream's core; **P1** = blocks an extension or a
scale path; **P2** = policy/hygiene. WS = originating workstream(s).

| # | Decision | WS | Priority | Default if undecided | Why it's the owner's call |
|---|---|---|---|---|---|
| D1 | Ratify the **provider plaintext boundary** + consent model (translation/live-voice/cloud-AI are plaintext at the provider) | ②③⑤ | **P0** | feature stays OFF | Relaxes "server-adjacent third party sees content" vs the E2EE posture |
| D2 | **Server translation cache** (Tier-1 `TranslationCache`) on/off/opt-in-per-tenant | ② | **P0** for server cache | OFF (session-only) | Server memory of message plaintext vs ADR-010 |
| D3 | Any **server-side plaintext index/summary/embedding of history** (WS5 Tier 3) | ⑤ | **P0** for that path | Forbidden | Breaks "server is the adversary" |
| D4 | **Notification wrapping key** is not "key publication" under ADR-008 §12 | ① | **P0** for rich native | content-less-only native | Security-review + hard-stop interpretation |
| D5 | **Cost-governance policy** (alert / degrade / hard-block) + the numbers | ②③⑤ | **P0** at scale | alert-only | Spend vs quality trade-off; 8 metered vendors |
| D6 | **Live-voice group (>2) scope** — design N-way now / ship 1:1 first | ③ | **P0** (scope) | 1:1 MVP | ADR-011 non-goal vs product ambition |
| D7 | Ratify **LTMS as the sole declared media plaintext boundary** | ③ | **P0** | E2E call only, no live translation | Scoped exception to "media never touches server" |
| D8 | **Live-voice MVP bar**: emotion fidelity tier, adaptive TTS model, latency measurement point | ③ | **P1** | basic+adaptive, segment→first-audio | Quality vs latency/cost |
| D9 | **Provider zero-retention gating** (may exclude best-quality providers) | ③② | **P1** | zero-retention required | Roadmap rule 10 vs quality |
| D10 | **BLE mesh trust + retention ADR** before rollout | ④ | **P1** | mesh not shipped | New relay-adversary + proximity model |
| D11 | **Server store-and-forward mailbox** retention TTL / size caps / anti-spam | ④ | **P1** | conservative caps | Abuse + storage policy |
| D12 | **Offline first-contact**: prekey prefetch vs downgrade for never-contacted peers | ④ | **P1** | require prefetched bundle | Forward-secrecy vs offline reach |
| D13 | **Proximity-metadata surface** (who-was-near-whom) acceptance | ④ | **P1** | gated on P8 discovery threat model | Metadata not removed by encryption |
| D14 | **Unofficial `gtx` endpoint**: keep as last-resort or remove now | ② | P2 | keep, quality-gated | Roadmap §7 vs coverage |
| D15 | **Server-side notification preferences** (mute/DND move server-side) | ① | P2 | client-only today | Cross-device correctness vs posture change |
| D16 | **Mention push metadata**: cleartext "mentions @X" routing vs undifferentiated | ① | P2 | mention class OFF | Leak vs feature |
| D17 | **CallKit/PushKit live-ring** scope (needs entitlements + iOS app) | ① | P1 | notification-only calls | P10 native coupling |
| D18 | **AI assistant history scope** + prompt-injection exposure | ⑤ | P1 | on-device, no history assistant | Attacker-authored content is the model input |
| D19 | **Cross-device conversation search** design | ⑤ | P1 | gated on multi-device | Ciphertext-sync vs per-device rebuild; searchable-encryption rejected |
| D20 | **Meeting-mode artifacts**: device-only vs enterprise server record | ⑤ | P1 | device-only | Enterprise record vs E2EE |
| D21 | **Widen the Tier-2 live exception** to in-call AI beyond translation | ⑤ | P1 | no | New egress beyond the call opt-in |
| D22 | **Telemetry never carries content/embeddings/queries** — ratify as policy | ⑤ | P2 | enforce | Observability vs privacy |
| D23 | **Persisted conversation context** for cache reuse | ②⑤ | P1 | session-scoped only | Tied to D2 |

**The P0 cluster is the real gate.** D1–D7 are the decisions without which the
revenue features (translation, live voice) and the AI roadmap cannot ship in a
form consistent with the E2EE brand promise. They are threat-model and product
calls, not engineering ones.

## B. Engineering risk register (team-owned)

L = likelihood, I = impact (both L/M/H). Mitigations are already reflected in the
workstream docs and the `90-…` phasing.

| # | Risk | WS | L | I | Mitigation | Owner-decision link |
|---|---|---|---|---|---|---|
| R1 | **Seal-lift regresses the live crypto path** (plaintext leak or undecryptable messages) | ④ | M | **H** | Sequence with/after P1 e2e_v3 activation; e2e-version negotiation + visible v2 fallback; full ADR-002 test battery; INV-1…6 as tests; security review | — |
| R2 | **<2.5 s live-voice budget missed** on real networks | ③ | M | **H** | Pipelining (partial-hypothesis MT, TTS input-streaming, foldable LLM); 5-tier degradation ladder; benchmark gate; adaptive TTS model | D8 |
| R3 | **On-device AI runtime infeasible** (WebGPU/WASM in Capacitor Android WebView) | ⑤ | M | H | **Spike first** before committing; fall back to Tier-1 ephemeral; phase the local-inference roadmap | — |
| R4 | **iOS blocks native BLE / constrains background** | ④ | **H** | M | Scope mesh to Android/native; state the non-goal honestly; web stays relay/WebRTC | D10 |
| R5 | **Cost blowout** from cross-verify + adjudication + TTS fan-out | ②③ | M | H | F0-2 cost caps + policy; worth-it predicate on adjudication; small-model-first | D5 |
| R6 | **Observability retrofit** cost / blind rollout if not built early | ①②③ | M | M | F0-1 minimal `/metrics` before scale; full OTel at P9 | — |
| R7 | **Per-instance shared-state ceiling** (rate-limit/breaker/health) at enterprise volume | ② | M | M | Redis/Dragonfly (P3) or an authorized scoped exception; document the ceiling | — |
| R8 | **Zero-retention gating excludes best providers** → quality dip | ③② | M | M | Routing policy weights; owner ruling on the quality/retention trade | D9 |
| R9 | **New client AI index not wiped / not TTL'd** | ⑤ | M | M | Readiness-checklist gate: join `wipeDevice` (correct post-NEW-4) + honor TTLs | — |
| R10 | **`chat.js` grows further** (already ~9× the 500-line rule) | ⑤③ | M | L | No new feature code in `chat.js`; new modules only | — |
| R11 | **`Device` vs `DeviceToken` duplication** causes token drift | ① | L | M | Separate cleanup PR; push path stays on `DeviceToken`/`PushSubscription` | — |
| R12 | **Broker-only-present user** misses a notification (two write paths) | ① | L | M | `PresencePort` unifies socket + HTTP publish; validate once Centrifugo is default | — |
| R13 | **Prompt injection via attacker-authored conversation content** into an assistant | ⑤ | M | H | On-device + tightly scoped tools; no autonomous actions; gated by D18 | D18 |
| R14 | **Mesh flooding / relay abuse** in the BLE mesh | ④ | M | M | seen-set + TTL + hopcount bounds; mailbox anti-spam; mesh ADR (D10) | D10, D11 |
| R15 | **Provider API drift** (models/prices/limits change) breaks a leg | ②③⑤ | M | M | Capability matrix as data + health checks + circuit breaker; adapter isolation | — |

## C. How this closes out

- Every **P0 owner decision (D1–D7)** should be answered before its workstream's
  core build starts; the `90-…` phasing already gates on them.
- Every **engineering risk** has a mitigation already designed into the workstream
  doc; R1, R2, R3, R4 are the four to watch (crypto blast radius, flagship latency,
  on-device feasibility, iOS BLE reality).
- The register is the tracking artifact: as decisions are made and risks retired,
  update the rows rather than scattering status across the workstream docs.

**No implementation is authorized until the owner accepts the Priority 1 verdict
and explicitly starts Priority 2.**
