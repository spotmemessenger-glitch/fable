# Live Voice Translation — ops runbook

For the operator of a deployment where any live-voice flag is up.

## 1. Health surfaces

- **Session metrics:** `session.metrics()` → `{ utterances, overBudget,
  overBudgetRate, stages: { total|capture|stt_partial|stt_final|mt|
  llm_correct|tts_first_audio|playback_schedule: {count,min,max,mean,p50,
  p95,p99} } }`. Content-free by construction.
- **Ladder:** `session.ladder()` → `{ tier, allows, moves[] }` — tier
  occupancy below `full` is the single best degradation signal (WS3 §16).
- **MT routing evidence:** `mtStage.decisionLog()` → last 32 `{provider,
  confidence, band, uncertain, cacheHit, latencyMs, reason}`.
- **#51 platform health:** `platform.readiness()` (breakers, flags, cost)
  — the MT stage inherits all of it.

## 2. Symptom → action

| Symptom | Likely cause | Action |
|---|---|---|
| `overBudgetRate` climbing; ladder at `captions-only` | Slow STT/TTS leg or network | Check per-stage p95 to find the stage; if provider-side, breakers + failover chains already re-route; if regional, drop `STREAMING_PROVIDER_ENABLED` for the affected deploy (Level-1 rollback) |
| Ladder pinned at `original-only` | Provider outage or key problem | Verify `ELEVENLABS_API_KEY` present where adapters run; check vendor status; the call itself is unaffected — no urgency beyond feature loss |
| `voice: 'generic'` unexpectedly | Clone unavailable (deleted, plan slot, TTS failover to non-clone leg) | Confirm the profile still has a `voiceId` (`/api/voice?op=clone` lifecycle); check TTS failover events in the chain's `failovers` |
| MT `uncertain` spikes | #51 providers gated out (privacy mode, breakers, pairs) | Read `decisionLog().reason` + `platform.readiness()`; this is a translation-platform incident — its runbook applies |
| 429s from ElevenLabs | Quota — segment traffic multiplies request counts | Raise/rebalance `gateVendorProxy` buckets (voice=30/min today, sized for batch); consider larger VAD segments (`maxSegmentMs`) to cut requests |
| Latency chip fine but audio choppy | Playout loss | Jitter `stats` (lost/late/concealed, depthMs) — sustained `grew` means the network needs the deeper buffer; nothing to do unless depth pins at max, then prefer captions (drop voice) |
| Session stuck DEGRADED after a drop | resume() never called by the UI | `integration.resume()`; cursors preserve continuity; past-grace sessions should be re-attached fresh |
| Memory growth suspicion | It should be impossible | Every buffer is capped (rings/logs/replay); `aggregator.retainedSamples()` must plateau — if it does not, that is a bug: file it with the long-session test as the repro harness |

## 3. Cost controls

- VAD gates silence (nothing silent is posted).
- Distinct-language fan-out only; `planCall()` gives the §14.3 bound —
  enforce per-call caps at the wire-in with it.
- `cancel()` on barge-in closes the TTS socket (stops metered synthesis).
- The #51 cost governor applies to every MT call when its flag is on.
- The kill order under runaway spend: `VOICE_CLONE_ENABLED` →
  `LIVE_TRANSLATION_ENABLED` → `LIVE_VOICE_ENABLED` (each strictly reduces
  metered surface; captions-only is ~an order cheaper than voice, WS3 §14).

## 4. Security duty rota

- Key rotation: rotate `ELEVENLABS_API_KEY` in env; adapters read at call
  time — no restart-coupled caching.
- Never add logging of caption/audio payloads; metrics are the only
  sanctioned telemetry (threat model T3; the safe-telemetry whitelist).
- Any report of translation running without the indicator = P1 honesty
  bug; pull `LIVE_VOICE_ENABLED` first, investigate second.

## 5. Escalation evidence to attach

`session.metrics()`, `session.ladder().moves`, `mtStage.decisionLog()`,
`platform.readiness()`, jitter `stats`, and the deploy's flag set. None of
these contain user content.
