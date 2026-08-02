# Live Voice Translation — threat model

Extends the WS3 design §12 and the crypto guide's golden rule ("the server
is the adversary") to the code that now exists. Scope: the live-voice
platform on this branch, dark, flags off.

## 1. Trust boundaries (where plaintext exists)

```
E2E boundary (unchanged, the product's promise)
┌─────────────────────────────────────────────────────────────┐
│ Original call audio: client ── DTLS-SRTP P2P ── client      │ server sees nothing
│ Messages:            sealed envelopes                        │ server relays ciphertext
└─────────────────────────────────────────────────────────────┘
        │ additive, per-call per-direction OPT-IN (flags + consent)
        ▼
╔═════════════════════════════════════════════════════════════╗
║ DECLARED PLAINTEXT BOUNDARY — live translation               ║
║ mic clone ─► VAD ─► [STT provider] ─► captions ─►            ║
║ [MT provider(s) via #51] ─► [TTS provider] ─► playout        ║
║ Plaintext audio: at the STT provider.                        ║
║ Plaintext transcript: in session memory (bounded), at MT     ║
║ and TTS providers.                                           ║
║ Ephemeral only: no storage API is reachable from any         ║
║ live-voice file (fence-tested).                              ║
╚═════════════════════════════════════════════════════════════╝
```

What stays E2E: the original call, always. Translation OFF (default) means
the boundary above does not exist — byte-identical app.

## 2. Assets

A1 call audio (the most sensitive), A2 transcripts/captions, A3 the
consented clone voiceId (identity), A4 vendor API keys, A5 availability of
the call itself, A6 the honesty of AI-voice indicators.

## 3. Threats and the shipped mitigations

| # | Threat | Mitigation (code, not promise) |
|---|---|---|
| T1 | Silent enablement — translation runs without the user knowing | Master + layered sub-flags all default OFF; strict affirmative parsing; `attach()` re-checks; fence test proves nothing imports the module; control frames (`voice-active-on/off`, `fallback-captions`) exist for the UI honesty duty |
| T2 | Key leakage to the client bundle | Keys are env-read at call time server-side (`elHeaders()` pattern); proxy mode for clients; fence greps for embedded keys; a browser WS cannot carry the header at all |
| T3 | Audio/transcript retention | `FORBIDDEN_RETENTION_SURFACE` rejected at the interface; no storage API in any live-voice file (grep fence); replay ring is 1 utterance, memory-only, cleared at end() |
| T4 | Voice-clone abuse (cloning from call audio / using another's clone) | No clone creation exists in this module; only the enrolled `voiceId` is ever REFERENCED; no voiceId → captions-only (orchestrator refuses); `VOICE_CLONE_ENABLED` off → neutral voice labelled `generic` |
| T5 | Strict-privacy bypass (plaintext to cloud despite strict) | `mt-stage` refuses at open() AND per-call (defense in depth, tested: zero platform calls in strict); the #51 posture gates handle sensitive/standard |
| T6 | Provider compromise / poisoned responses | Providers only ever return TEXT/AUDIO handled as data; caption frames validate shape; no provider string is executed or used as a selector beyond enum-checked fields; #51 fences context as untrusted |
| T7 | Cost-burn attack (leave a call running / fan-out amplification) | Bounded timeouts on every leg; VAD gates silence; distinct-language fan-out; `planCall` exposes the §14.3 concurrency bound for caps; cancel() closes provider sockets (stops billing). Per-account quotas remain the proxy's `gateVendorProxy` job (activation guide lists raising them as a go-live step) |
| T8 | DoS of the call via the translation path | The tap is a CLONE; every translation failure lands on a ladder rung; the original call transport is never in any live-voice code path |
| T9 | Cross-listener leakage in groups | Delivery envelopes carry explicit `to:` lists; tested that lanes never include other listeners; the UI seam drops deliveries not addressed to self |
| T10 | Hung network path wedging the session | Connect/first-audio/idle/overall deadlines on TTS; per-request + overall abort-raced bounds on STT; MT segment ceiling; cancel is race-armed so even a signal-ignoring transport cannot hang an await (tested) |

## 4. Residual risks (accepted, documented)

- The STT/MT/TTS vendors SEE plaintext for opted-in directions — inherent
  to cloud translation; mitigated by consent, posture gates, zero-retention
  provider policy (a §12.3 procurement gate, not code), and strict mode.
- Metadata (who translated to which language, when) exists in metrics —
  content-free by the safe-telemetry whitelist discipline.
- The neutral-voice id is a public ElevenLabs premade voice; using it leaks
  nothing about the speaker.
