# Live Voice Translation — privacy & consent

The honest statement, per roadmap §6.3/§6.4 and WS3 §12: **once live
translation is on for a direction, that direction's speech is not
end-to-end private — cloud AI providers receive it in cleartext.** The
product must say this in those words. The original call remains E2E.

## 1. Where plaintext exists (and where it never does)

| Data | Exists at | Never at |
|---|---|---|
| Raw audio (per opted-in direction) | mic clone (device), STT provider | our storage (none), other listeners' devices beyond normal call audio |
| Transcript / original captions | session memory (bounded), MT provider (unless strict), listeners' screens | any storage API (fence-tested) |
| Translated captions/audio | MT/TTS providers, listeners | storage |
| Clone voiceId (an ID, not audio) | TTS request | client bundle key material (none) |
| Latency/health metrics | memory rings, ops surface | content of any kind (numbers + enum stages only) |

Retention: **ephemeral by construction.** No live-voice file can reach
localStorage/indexedDB/blobstore/fs (`test/live-voice-not-wired.test.js`);
the replay control reads a one-utterance in-memory ring cleared at session
end. Server-side persistence of audio/transcripts is not implemented
anywhere. Provider-side zero-retention terms are a procurement gate (WS3
§12.3): a provider that cannot meet them must not be registered.

## 2. Consent gates (layered, all required)

1. **Owner/deploy:** the flags. `LIVE_VOICE_ENABLED` + sub-flags, default
   off, strict affirmative parsing.
2. **Per-call, per-direction user opt-in:** enabling translation for YOUR
   outbound audio is consenting to YOUR speech crossing the boundary. The
   session/integration only runs for participants passed in with
   `consented` state by the (future) UI wire-in; the UI copy must name the
   E2E exception explicitly. Nothing is always-on.
3. **Voice-clone consent — already shipped, only REFERENCED here:** the
   one-clone-per-profile enrolment in the voice-note flow
   (`src/lib/voice.js cloneVoice/deleteClone` over `api/voice.js`,
   profile UI) is the sole source of a `voiceId`. This platform:
   - never creates a clone, never from call audio (§6.4);
   - uses the clone ONLY when `VOICE_CLONE_ENABLED` AND the speaker is
     `consented: true` AND has a `voiceId`;
   - otherwise uses a neutral premade voice explicitly labelled
     `voice: 'generic'` in every delivery.
4. **Counterpart visibility:** control frames `voice-active-on/off` mark
   synthesized audio; `fallback-captions` marks degradation. The UI must
   render a persistent AI-voice indicator from these (mapping doc
   `05-ui-architecture.md`).

## 3. Strict privacy mode

`strict` (per-conversation pref or session setting) means on-device only,
and there is no on-device streaming STT or MT in this build — so strict
refuses the WHOLE live pipeline, enforced twice:

- the MT stage refuses at `open()` and per call (`STRICT_PRIVACY_REFUSAL`;
  tested to make zero platform calls), and
- the session, once strict is detected, refuses `speech()` entirely —
  **no cloud STT runs, no caption frame is emitted, nothing leaves the
  device** (tested: zero STT calls, zero frames, `mode: 'refused'`).

The original E2E call carries on untouched. Lifting the refusal requires an
on-device adapter tier (known-limitations), not a policy change.

## 4. User controls (all local, immediate)

`muteTranslated`, `listenOriginal` (captions continue), live
`setListenLang`, `replayLastUtterance` (bounded, in-memory), detach()
(stops the clone track; the call continues untouched). Turning the feature
off leaves zero residue — the tap track is stopped and the session state
garbage-collects; nothing was written anywhere.

## 5. What we never claim

While any cloud provider receives a direction's audio, the app must not
display a full-E2E badge for that call without qualification. When
translation is off (the default and every failure floor), the E2E claim is
fully true again.
