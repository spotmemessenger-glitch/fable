# Live Voice Translation — known limitations

Honest list, numbered for reference from other docs and the owner report.

1. **Group media transport does not exist.** The N-way session logic
   (matrix, shared STT, per-listener lanes, `GROUP_TRANSLATION_ENABLED`)
   is real and tested, but moving group audio between >2 devices needs the
   Priority-5 group-call media plane (SFU/LTMS). Nothing here fakes it;
   the flag guards logic whose media dependency is declared, not met.
2. **STT streams by chunked segments, not a provider push-socket.** The
   shipped wire is the production-proven Scribe REST protocol driven per
   VAD segment (partials at segment granularity). The Scribe
   realtime-websocket is a planned second registration once its frame
   schema is pinned against live vendor docs — the adapter seam
   (`IStreamingStt` + injectable transport) is already shaped for it.
   Consequence: first-partial latency is bounded below by segment length;
   the VAD's `maxSegmentMs` and hangover are the tuning knobs.
3. **Live provider tests and benchmarks are credential-gated.** CI proves
   protocol framing on fake transports; the real-vendor smoke + the §4
   latency matrix require `ELEVENLABS_API_KEY` (+ `LIVE_VOICE_LIVE_TESTS=1`)
   and shaped networks, and remain a pre-cohort gate (activation guide
   §2–3). Until run, all provider-latency numbers are engineering
   estimates.
4. **Client-role TTS streaming needs a proxy websocket endpoint.** The
   TTS adapter's real transport carries the key in the handshake header,
   which a browser cannot do. Server-side (LTMS role) it works as shipped;
   a browser deployment needs an authed websocket proxy (the streaming
   sibling of `api/voice.js`), which does not exist yet. STT's proxy mode
   works today over the existing `/api/voice?op=stt`.
5. **Strict privacy = no live feature at all.** By design strict refuses
   STT, MT and TTS (nothing may leave the device), so strict users get no
   captions either. Lifting this requires an on-device adapter tier
   (roadmap §6 "private modes"), not configuration.
6. **Prosody is control-mapped, not transferred.** Emotion/intonation/
   pace/energy map deterministically onto ElevenLabs voice settings
   (identity + pacing per WS3 §5 MVP tier); acoustic emotion EXTRACTION
   from source audio and true prosody transfer are the staged Tier-1/2
   work (§5.4, owner decision C-4).
7. **TTS failover resume is chunk-approximate.** Across a mid-utterance
   TTS hop the remainder is computed at chunk granularity (provider
   alignment maps refine it when present); a few already-synthesized words
   may repeat or elide at the seam in the worst case. STT/MT hops are
   exact.
8. **Speaker diarization is per-stream energy, not in-stream separation.**
   Correct for this architecture (each participant has their own stream);
   two people sharing one microphone are attributed as one speaker.
9. **Native/mobile audio specifics are untouched** — AudioWorklet capture
   framing, iOS audio-session categories, Bluetooth routing, background
   behaviour. The seam consumes a standard MediaStreamTrack clone, so the
   work is additive when scheduled.
10. **No UI screens ship here.** The typed event/control surface + mapping
    doc do; adopting them in the call UI (with consent copy and
    indicators) is a separate, reviewed change — until then the feature is
    unreachable even with every flag on, which is the intended dark state.
11. **Per-account cost caps are not enforced inside this module.** The
    bounded timeouts, VAD gating, fan-out collapsing and `planCall` bound
    ship; account/day budget enforcement belongs to the proxy/LTMS layer
    (`gateVendorProxy` pattern + #51 cost governor) and needs the owner's
    budget numbers (C-7).
