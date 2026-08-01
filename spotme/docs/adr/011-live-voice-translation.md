# ADR-011 — Live Voice Translation (flagship)

**Status:** Proposed — **PLANNING ONLY** (owner directive 2026-08-01).
**Depends on:** ADR-010 (provider platform), the shipped voice-note
translation pipeline, ElevenLabs voice cloning (one clone per profile).

## Context — the foundation already ships, in batch form

`views/chat.js` already runs the full pipeline asynchronously for voice
notes: **STT → translate → cloned TTS in the sender's own voice**, delivered
as an mp3 — a capability none of the major comparators ship. The owner's
directive: base the live architecture on this working pipeline. The live form
is therefore a **re-architecture of the same three stages as streams**, not a
new capability from nothing — and explicitly NOT an extension of the
voice-note code, which stays untouched (batch and live have different failure
modes, buffers, and UI).

## The pipeline

```
Microphone
  ↓  capture (AudioWorklet; 16 kHz mono frames; jitter buffer)
Streaming STT                    — partial transcripts, endpointing
  ↓
Language Detection               — auto-detect on early audio/partials;
  ↓                                sticky per speaker, revisable
Conversation Context             — rolling window feeding the engine
  ↓                                (fenced as untrusted, per ADR-010 §3)
Translation Engine               — INCREMENTAL: translate stabilised
  ↓                                segments, revise displayed partials
Voice Clone                      — the speaker's enrolled clone
  ↓                                (speaker preservation)
Streaming TTS                    — audio out as segments stabilise
  ↓
Playback                         — jitter-buffered; ducks under the
                                   original when live captions suffice
```

## Requirements, and where each lands

| Requirement | Design |
|---|---|
| Speaker preservation | the enrolled ElevenLabs clone voices the translation; unenrolled speakers get a neutral voice, labelled |
| Live captions | partial transcripts render immediately as captions — captions lead audio, always |
| Original transcript | kept and displayed on demand (source of truth for "what did they actually say") |
| Translated transcript | kept alongside; both visibly marked machine-produced |
| Interruption handling | barge-in cancels in-flight TTS for superseded segments; endpointing splits on speaker change |
| Incremental translation | segment-level: stabilised STT segments translate immediately; displayed partials may revise until stabilised, spoken audio only from stabilised text |
| Provider failover | every stage routes through ADR-010's abstraction — STT, MT, and TTS each degrade independently; no stage has a hard provider dependency |
| Original-audio fallback | the untranslated stream is always available one tap away, and automatically on pipeline failure — degraded is original audio + captions, never silence |
| AI status indicator | a persistent, honest indicator that translation is active and machine-made |
| Quality monitoring | per-stage latency and confidence feed ADR-010 §4/§5 observability |
| Enterprise accuracy | context-aware engine + ADR-010 confidence; low-confidence segments visibly flagged in captions |

## Latency budget

**MVP: < 2.5 s end-to-end** (speech → translated audio). Working split to be
validated by benchmark, not assumption: capture+transport ≤ 300 ms, streaming
STT first-stable ≤ 800 ms, translation ≤ 400 ms, TTS first-byte ≤ 700 ms,
playback buffer ≤ 300 ms. **Production target: < 1 s where provider
capabilities allow** — reached by streaming every stage (no stage waits for a
complete predecessor) and pair-tuned provider selection. Captions beat both
targets by construction since they skip TTS. Benchmarks per V2 §8 (env,
median, p95/p99) are part of the implementation gate.

## Privacy model

Live translation processes **cleartext speech through third-party providers
by explicit, per-call, per-direction opt-in** — this is a deliberate,
user-visible exception to the E2E posture, stated in those words in the UI
(the ADR-001 boundary is not silently crossed). No provider may retain audio
(contractual + shortest-retention API options); nothing is stored server-side
beyond the session; transcripts live on the participants' devices only.
Enrollment/consent for voice cloning stays governed by the existing
one-clone-per-profile flow. Per roadmap rule 10: accuracy, latency, AND
privacy are optimised together — a provider that cannot meet the retention
terms is not routed to, whatever its quality.

## Non-goals

No always-on translation (explicit opt-in per call). No voice-note code
changes. No group-call translation in MVP (1:1 first; group is a stated
follow-up). No offline/on-device MVP (a future track once on-device STT/MT
mature).

## Rollback / activation

Feature-flagged per direction; OFF restores the untranslated call with zero
residue. The pipeline is additive alongside the existing call path — rollback
is the flag, and the original audio path never stopped existing underneath.
