# ADR-011b — Live Voice Translation: the platform implementation

**Status:** Implemented, dark. **Every flag defaults OFF; nothing in the app
imports the module; app behaviour with flags off is byte-identical.**
**Extends:** ADR-011 (the scaffold this builds ON — interfaces, state
machines, latency budget, frames, orchestrator all kept), ADR-010/010a/010b
(the #51 translation platform this CONSUMES), the WS3 design
(`docs/priority-2/03-live-voice-translation.md` on the planning branch).
**Priority context:** Priority 2, PR C (flagship, owner order ③). Priority 1
(crypto) is FROZEN and untouched. The push platform (#52) and the
translation platform files (#51, `src/lib/translation/`) are untouched.

## 1. What was decided and built

| Decision | Choice | Why |
|---|---|---|
| STT wire | ElevenLabs Scribe **chunked** REST (`POST /v1/speech-to-text`, `model_id=scribe_v1`, multipart) driven per VAD-closed sub-segment, in `direct` (server key) and `proxy` (shipped `/api/voice?op=stt` JSON) modes | It is the protocol this app already runs in production (`api/voice.js stt()`), so "real wire" is a fact, not a guess. The WS3 contract allows "websocket/chunked"; the Scribe realtime websocket stays open as a second registration once its frame schema is pinned against live docs (known-limitations #2) |
| TTS wire | ElevenLabs **stream-input websocket** (`wss://…/v1/text-to-speech/{voiceId}/stream-input`), BOS/text/EOS framing, `voice_settings` from a documented prosody mapping, mp3 output | The documented realtime protocol; first audio arrives before the sentence completes — the §4 second dominant term. `eleven_flash_v2_5 → eleven_turbo_v2_5 → eleven_multilingual_v2`; `eleven_v3` excluded (batch-only, budget-breaking) |
| Key custody | `xi-api-key` read from env at call time, server-side only (the `api/voice.js elHeaders()` pattern); client role goes through the authed proxy | No key can enter the bundle; a browser WebSocket cannot even set the header |
| Transport injection | `fetchFn` / `wsFactory` parameters; the REAL global is used only when nothing is injected AND `STREAMING_PROVIDER_ENABLED` is on | Deterministic tests with zero credentials; production refuses to construct a live transport while the flag is down |
| MT | **No own translator.** `mt-stage.js` implements IStreamingMt by calling the #51 platform per caption segment | Routing, failover, breakers, confidence, cost, privacy postures and bounded context already exist there; duplicating any of it was forbidden and unnecessary |
| Privacy modes | `standard`/`sensitive` flow to the platform's posture gates; **`strict` REFUSES live translation** with a typed error the session turns into original-captions-only | strict = on-device only (translation/privacy.js) and there is no on-device streaming MT; refusal is the feature |
| Fan-out | One STT pass per speaker; one MT+TTS leg per DISTINCT listen language; same-language listeners get original captions; the speaker gets nothing added | §6.3 cost rule; `fanout.js` is pure data logic, `shared-stt.js` enforces the single pass |
| Group | Session logic (matrix, addressing, per-listener delivery envelopes, shared STT) is REAL and tested for N participants behind `GROUP_TRANSLATION_ENABLED`; group MEDIA transport is a **declared dependency on Priority-5 group-call infra** | "Do not fake group media" — nothing here pretends to be an SFU |
| Degradation | `full → captions-only → original-only` ladder with two-sided hysteresis (N breaches in a window to demote; sustained clean to promote); wired to the orchestrator's over-budget fallback via the session | §13.3 "never silence"; the original E2E call never stopped underneath |
| Voice identity | Clone `voiceId` reused from the shipped enrolment (never created here, never from call audio); `VOICE_CLONE_ENABLED` off or unenrolled speaker → **neutral labelled premade voice** (`NEUTRAL_VOICE_ID`), surfaced as `voice: 'generic'` | §5.1/§6.4; no silent substitution, no invented voice — the orchestrator still refuses to synthesize with no voiceId at all |
| Failover | `createFailoverChain(role, candidates)` — an IStreaming* adapter over adapters; STT resumes REMAINING segments, TTS synthesizes only the un-played REMAINDER, MT re-issues | §7.4 mid-utterance failover; roadmap rule 10 (no hard dependency) enforced at the streaming layer too |
| UI seam | `call-integration.js`: attach() gated on `LIVE_VOICE_ENABLED && LIVE_TRANSLATION_ENABLED`; the mic tap is a **track CLONE** (second consumer); typed `UI_EVENTS` + controls; **no screens built** | Flags off = provably nothing (test-audited); the call's own stream is never touched; screens are a mapping doc, not code |

## 2. Module map (all additive)

```
src/lib/live-voice/
  flags.js            master + 5 LAYERED sub-flags (extended; master behaviour unchanged)
  providers/
    elevenlabs-stt.js REAL chunked Scribe wire, direct/proxy, bounded, cancellable
    elevenlabs-tts.js REAL stream-input websocket, bounded, cancellable
    prosody.js        emotion/intonation/pace/energy → legal voice_settings
    failover.js       mid-utterance failover chains per role
  mt-stage.js         IStreamingMt over the #51 platform (+ strict refusal)
  shared-stt.js       one STT pass per speaker, fanned to N legs
  fanout.js           who-hears-what matrix + planCall cost bound
  live-session.js     the LiveVoiceSession manager (1:1 + group logic)
  call-integration.js flag-gated media/UI seam (UI_EVENTS + controls)
  metrics.js          bounded-ring p50/p95/p99 aggregation
  quality/            vad.js, jitter-buffer.js, degradation-ladder.js,
                      diarization.js, constraints.js
  (scaffold files unchanged except: orchestrator.js additively carries
   mtConfidence/mtProvider; index.js barrel re-exports + a real, still
   flag-gated bootLiveVoice door)
```

## 3. What the tests hold (deterministic, no credentials)

17 live-voice suites / 299 checks inside the 76-suite / 1489-check full run:
wire-protocol pinning for both providers on fake transports; one conformance
contract across stubs, real adapters, chains and the MT stage; MT-through-
#51 routing + mid-call failover + bounded context + strict refusal; session
barge-in/reconnect/cursors/ladder; 3-party fan-out with per-listener lanes;
400-utterance boundedness; flag layering; the not-wired fence. Live-provider
smoke exists but is **cred-gated** (`ELEVENLABS_API_KEY` +
`LIVE_VOICE_LIVE_TESTS=1`) and skips in CI.

## 4. IMPLEMENTED vs DEFERRED

**IMPLEMENTED (dark, flag-off):** everything in §2; latency accounting into
percentiles; local-orchestration benchmark; the docs set
(`docs/live-voice/`).

**DEFERRED, explicitly:**
- **Group media transport** — blocked on Priority-5 group-call infra (SFU /
  LTMS media plane). Group session LOGIC ships; group audio does not move.
- **Scribe realtime-websocket STT** — second registration once the frame
  schema is verified against live docs; the chunked wire is the shipped
  protocol meanwhile.
- **Live provider benchmarks** — the §4 critical-path terms (STT stabilise,
  TTS first-audio) need credentials + real networks; the benchmark plan
  (`docs/adr/03-live-voice-benchmark-plan.md`) governs; local orchestration
  cost is measured and reported now.
- **On-device strict-mode translation** — strict currently refuses (by
  design); an on-device streaming MT adapter would lift the refusal.
- **Server-side LTMS deployment** — the adapters run wherever the key
  lives; the dedicated media service (WS3 §3.1) is infrastructure work.
- **Native/mobile audio specifics** — AudioWorklet capture framing, iOS
  audio-session categories, Bluetooth routing.
- **UI screens** — the event/control surface + mapping doc ship; screens
  are a separate, reviewed change.

## 5. Rollback

`LIVE_VOICE_ENABLED` off (default) is the rollback; the sub-flags cannot
outlive it (layered). Nothing imports the module (fence-tested), so full
removal is `rm -rf src/lib/live-voice/`, deleting `test/live-voice-*.test.js`
+ `test/bench/live-voice.bench.mjs` + `test/helpers/fake-translation-provider.js`,
restoring the two `package.json` script lines, reverting the
translation-fence carve-out hunk, and deleting `docs/live-voice/` + this ADR.
See `docs/live-voice/06-rollback-plan.md` for the ordered procedure.
