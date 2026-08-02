# Live Voice Translation — platform architecture

Companion to ADR-011b. The WS3 design
(`docs/priority-2/03-live-voice-translation.md`, planning branch) is the
full blueprint; this documents what is BUILT on this branch and how the
pieces compose.

## 1. The pipeline, per utterance

```
mic track ── clone() tap ──► VAD (energy+hangover) closes segments
                                  │  [quality/vad.js]
                                  ▼
                    beginSharedSttUtterance(stt)        ← ONE pass per speaker
                                  │  [shared-stt.js]
             ┌────────────────────┼──────────────────────────┐
             ▼ (leg per DISTINCT target lang)                ▼ (same-lang listeners)
   createLiveVoiceOrchestrator (scaffold, per leg)     original captions only
   STT → MT → (corrector) → TTS → playback
        │       │                   │
        │       │                   └─ ElevenLabs stream-input WS (clone or
        │       │                      neutral labelled voice; prosody.js
        │       │                      maps expressive intent to settings)
        │       └─ mt-stage.js → #51 platform.run() per segment
        │          (routing, failover, breakers, confidence, cost,
        │           privacy postures, BOUNDED context, glossary)
        └─ ElevenLabs chunked Scribe (segment posts, growing partials)
                                  │
                                  ▼
              deliveries { to:[listenerIds], frame, speakerId,
                           targetLang, voice } ── per-listener lanes
                                  │
                                  ▼
        call-integration.js → typed UI_EVENTS + jitter-buffered playout
```

Captions always LEAD audio: the orchestrator emits STT partials (original
captions) and MT partials (translated captions) before any TTS chunk exists.

## 2. Layers and their owners

| Layer | Module | State it owns |
|---|---|---|
| Flags | `flags.js` | none (env + per-flag override seam) |
| Providers | `providers/*` | per-stream timers/sockets only, all bounded |
| MT | `mt-stage.js` | bounded context window (via #51), 32-entry decision log |
| Session | `live-session.js` | session machine, active-utterance tokens, delivered-only cursors, 1-utterance replay ring per listener |
| Quality | `quality/*` | VAD segment state, jitter schedule + adaptive depth, ladder tier + bounded move log, diarizer EMA + bounded turns |
| Metrics | `metrics.js` | fixed 256-sample rings per stage |
| UI seam | `call-integration.js` | listener registry, mute/pin toggles, the tapped CLONE track |

Nothing anywhere persists audio or transcripts — enforced by
`test/live-voice-not-wired.test.js` (no storage API appears in any
live-voice file) and by the interface-level `FORBIDDEN_RETENTION_SURFACE`.

## 3. Where it runs

The adapters are placement-agnostic behind injected transports:

- **Server (LTMS role, the WS3 target):** `direct` mode — env key, real
  fetch/WebSocket. This is where fan-out shares one STT pass across
  listeners and credentials stay.
- **Client (1:1 early rollout):** `proxy` mode — the shipped authed
  `/api/voice` pattern; TTS streaming needs a proxy websocket endpoint
  (deferred; documented in known-limitations).

## 4. Concurrency & ordering rules

- One in-flight utterance per speaker; new speech BARGES IN (token cancel
  across every leg, §8.4).
- Legs of one utterance run in parallel (distinct languages), share the STT
  stream, and deliver only to their own listeners.
- Playout order per speaker is the jitter buffer's sequence order; the
  replay ring keeps only the last utterance.
- suspend() cancels everything and parks the session DEGRADED; resume()
  re-activates with delivered-only cursors (§8.5, live-only, no backfill).

## 5. Failure posture

Every failure lands on a NAMED rung of the ladder (`full → captions-only →
original-only`), hysteresis-damped both ways, and the original E2E call is
never touched by any of it — the translated stream is additive, so the
worst case is exactly today's call.
