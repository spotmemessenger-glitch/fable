# ADR-011 — Live Voice Translation: pipeline scaffolding

**Status:** Scaffolding only. **Nothing in this ADR is wired into a call, and
the feature flag `LIVE_VOICE_ENABLED` is OFF and stays OFF this cycle.** This is
the *addendum* that records what the scaffolding cycle built and, just as
importantly, what it deliberately did **not**.
**Relates to:** Roadmap V2 §6 (Live Voice Translation & Voice Preservation),
§6.5 (targets), §7 (provider rules); the standing AI principle (CLAUDE.md:
optimise accuracy + latency + privacy; no provider a hard dependency).
**Depends on / reuses:** `api/voice.js` + `src/lib/voice.js` (ElevenLabs STT/TTS
/ voice clone), the transport contract pattern of ADR-002
(`ITransportAdapter.js`).
**Priority context:** Priority 2, PR C. Priority 1 (crypto) is FROZEN and is not
touched by anything here.

## Why this exists before any real streaming code

Live voice translation is the flagship (§6, roadmap execution order ③). It is a
realtime pipeline with a hard latency promise — **< 2.5 s MVP end-to-end**
(CLAUDE.md owner amendment; §6.5 gives the component targets) — and a privacy
posture that has to be right *by construction*, because once a cloud provider
hears decrypted audio the app can no longer claim full end-to-end privacy
(§6.3). Both of those are architecture decisions, not implementation details,
and both are cheap to fix now and expensive to fix after a provider is wired in
and a flag is flipped.

So this cycle builds the **shape** — typed interfaces, a state machine, a latency
budget type, wire frames, and an orchestrator that runs the real pipeline order
on **stub** adapters — and defers every provider-specific and network-specific
part. The shape is exercised end-to-end by deterministic tests, so the seams are
proven before a single real byte of audio flows.

This mirrors how ADR-002 introduced the transport abstraction: a narrow,
checkable contract first, adapters behind it second.

## 1. Module layout (all additive, all under `src/lib/live-voice/`)

| File | Responsibility |
|---|---|
| `flags.js` | `LIVE_VOICE_ENABLED` gate. Default **false**. Reads Vite/Node env safely; nothing sets it true. |
| `frames.js` | The four wire frames — `audio-in`, `partial-caption`, `translated-audio-out`, `control` — as validating factories + `assertFrame`. |
| `streaming-interfaces.js` | `IStreamingStt` / `IStreamingMt` / `IStreamingTts` contracts: method lists, forbidden retention surface, `assertImplements*`, `StreamController`. |
| `session-state.js` | The utterance & session **state machines** as frozen transition tables + a validating `createMachine`, and the `LiveTranslationSession` type. |
| `latency-budget.js` | The `< 2.5 s` budget **accounting type**: total + per-stage allocation, `mark()`, `report()`. |
| `stub-adapters.js` | **Deterministic** interface-conformant stubs (no provider, no network) + a manual clock, for tests. |
| `orchestrator.js` | The pipeline **skeleton**: wires STT→MT→(LLM)→TTS→playback, drives the machine, accounts the budget, emits frames. |
| `index.js` | Barrel + `bootLiveVoice()` — the future flag-checked wire-in door, deliberately called from nowhere. |

## 2. Streaming contract (the three non-negotiables)

A `< 2.5 s` budget is impossible without streaming, so the interface *requires*
all three and an adapter that cannot do them is rejected by `assertImplements*`:

- **Partial results** via `handlers.onPartial` — captions and the next stage
  start on partials, not on a final blob.
- **First token** via `handlers.onFirstToken` — its arrival time is what the
  latency budget measures per stage (§6.5's "partial caption latency" and
  "translated voice first-audio latency").
- **Cancel** — each role method returns a `StreamController { cancel, done }` so
  barge-in abandons in-flight STT/MT/TTS at once (§6.2 interruption support).

The three providers stay **replaceable modules** (§6.3): every provider is an
injected parameter of the orchestrator; there is no hidden default that reaches
a live service.

## 3. Privacy is a contract, not a comment

Following the transport layer's `FORBIDDEN_KEY_SURFACE` precedent, streaming
adapters carry a `FORBIDDEN_RETENTION_SURFACE`: an adapter that exposes
`store` / `persist` / `history` / `audioLog` / `cache` (etc.) is **rejected**,
because retaining raw audio or transcripts by default contradicts §6.3/§6.4.
This is enforced in `streaming-interfaces.test.js`, not asserted in prose.

Captions are **decrypted content**. The frames are designed to ride the call's
own encrypted transport (the real wire is deferred); they carry only opaque
`sessionId` / `utteranceId`, never user identifiers. The honesty requirement of
§6.3 — do not claim full E2E once cloud AI sees the audio — is a UX/control-plane
obligation the `control` frames make visible (`voice-active-on/off`,
`fallback-captions`).

## 4. Latency budget

`TOTAL_BUDGET_MS = 2500`, allocated across the pipeline stages so a single slow
provider fails **fast** and the orchestrator can fall back to captions the
instant a slice is blown, instead of spending the whole budget to deliver late
audio (§6.2.8). The clock is injectable, which is the only way to unit-test a
latency type without flakiness. **The numbers are initial engineering
objectives (§6.5 says so explicitly); they move once real providers are
benchmarked** — see the benchmark plan
(`docs/priority-2/03-live-voice-benchmark-plan.md`). What this cycle fixes is the
*shape* of the accounting, not the constants.

## 5. State machine

An utterance marches `listening → transcribing → translating → (correcting) →
synthesizing → playing → completed`, with `interrupted` (barge-in) and
`dropped` (error / over-budget fallback) reachable from any active stage.
`correcting` is optional and skippable. Illegal moves throw at the seam — a
half-advanced utterance desyncs playback three stages downstream, so a refused
transition is strictly better than a silent one.

## 6. Voice-clone reuse — a NOTE, not new code

Live TTS **reuses the existing, consented ElevenLabs voice clone**; it does not
introduce a second voice path:

- The clone lifecycle already exists: `cloneVoice()` / `deleteClone()` in
  `src/lib/voice.js` over `POST /api/voice?op=clone|unclone` in `api/voice.js`,
  one voice per profile, created only from an explicit enrolment sample. §6.4's
  consent, ownership-binding, and delete/replace controls attach **there**.
- `ttsClone(text, voiceId)` already synthesizes speech in that voice. Live TTS
  is the **streaming** form of the same call against the **same `voiceId`** — the
  future `IStreamingTts` adapter targets ElevenLabs streaming/websocket TTS,
  behind the same `gateVendorProxy` auth + quota that fronts the existing proxy.
- Therefore live voice **creates no new voice** and clones no one from
  intercepted call audio (§6.4). The `translated-audio-out` frame requires a
  `voiceId` and the orchestrator refuses to synthesize without one — with no
  consented profile it falls back to captions-only. The stub proves that branch.

Real streaming providers, the API keys, and the streaming proxy endpoint are
**deferred** (see §8).

## 7. Rollback

- **Primary control:** `LIVE_VOICE_ENABLED` is OFF by default and read in one
  place (`flags.js`). There is no second switch.
- **Nothing imports the module.** The app's module graph does not reference
  `src/lib/live-voice/` at all, so the scaffolding cannot execute in production
  regardless of the flag. `bootLiveVoice()` is the single future entry point and
  returns `{ started: false }` while the flag is off — which is always, this
  cycle.
- **Full removal** is `rm -rf src/lib/live-voice/`, deleting the five
  `test/live-voice-*.test.js` files, and removing the additive `test:live-voice`
  script from `spotme/web/package.json`. No existing file changes, so removal
  leaves the tree exactly as it was before this PR. The existing `test` script
  was not modified.
- **No crypto, no P1 code, no existing test** was touched. Wiring the feature in
  later is a separate, reviewed change that must satisfy the roadmap §8
  completion checklist (benchmarks, security review, monitoring before enabling
  high-risk behaviour).

## 8. IMPLEMENTED (scaffolding) vs DEFERRED (real feature)

**IMPLEMENTED this cycle — real, typed, tested, flag-off, not wired in:**

- Streaming adapter **interfaces** `IStreamingStt` / `IStreamingMt` /
  `IStreamingTts` with the partial / first-token / cancel contract and the
  privacy retention ban, plus `assertImplements*` and `StreamController`.
- The `LiveTranslationSession` type and the utterance/session **state machine**
  as validated, frozen transition tables.
- The **latency-budget accounting type** (`< 2.5 s` total, per-stage allocation,
  `mark`/`report`, breach detection).
- The four **wire frame** schemas with validating factories and `assertFrame`.
- The **orchestrator skeleton** wiring STT→MT→(LLM)→TTS→playback in order, with
  budget accounting, state driving, frame emission, barge-in, and
  fallback-to-captions — run **end-to-end on deterministic stub adapters**.
- Unit tests: state machine, latency budget, frame types, interface conformance
  + the OFF flag, and the orchestrator end-to-end (68 checks, deterministic).

**DEFERRED — the real feature, explicitly out of scope this cycle:**

- Real streaming providers: ElevenLabs streaming STT/TTS, a streaming MT
  provider, and an LLM correction pass — with routing / fallback by quality,
  availability, cost, and latency (the standing AI principle).
- Microphone capture, WebRTC ingress, and **voice-activity detection /
  segmentation** (§6.2.1–2).
- The **network transport** for the frames (they are defined, not sent) and its
  binding to the call's encrypted channel.
- Playback scheduling that actually **preserves conversational order** under
  jitter (§6.2.7).
- The streaming voice proxy endpoint, quotas, cost accounting, consent/abuse
  safeguards wiring (§6.4), and the AI-active UX indicators as real UI.
- Provider benchmarking to replace the placeholder budget constants (§6.5).
- Any change that flips `LIVE_VOICE_ENABLED` or imports the module into the app.
