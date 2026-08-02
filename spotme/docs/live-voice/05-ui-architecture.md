# Live Voice Translation — UI architecture (event surface → screens)

The platform ships an EVENT/CONTROL surface, not screens
(`call-integration.js`). This document is the contract a UI change
implements: every control the mission names, mapped to the exact event or
method that powers it. Chat/room screens are untouched until a separate,
reviewed wire-in adopts this.

## 1. The hook point (one deliberate call)

```js
import { bootLiveVoice } from '../lib/live-voice/index.js'
// inside the call-active view, AFTER per-call consent UI:
const boot = bootLiveVoice({ call: conn.call, participants, selfId, adapters })
if (boot.started) { const lv = boot.integration; lv.attach() /* re-checks flags */ }
```

With flags off `bootLiveVoice` refuses before any dependency is touched —
the hook is safe to ship dark.

## 2. Element → event/control mapping

| UI element | Source | Notes |
|---|---|---|
| Original subtitle lane | `UI_EVENTS.CAPTION_ORIGINAL` `{speakerId, text, lang, partial}` | `partial: true` lines revise in place; `false` is final |
| Translated subtitle lane (dual subtitles) | `UI_EVENTS.CAPTION_TRANSLATED` | same revision rule; render under the original |
| Language indicator pills (per speaker) | `UI_EVENTS.LANGUAGE` `{speakerId, sourceLang, targetLang}` | update on every utterance (STT may re-detect) |
| Per-utterance confidence cue | `UI_EVENTS.CONFIDENCE` `{utteranceId, confidence}` | show the low-confidence treatment below the product threshold; never hide it (§13.1 honesty) |
| AI-voice indicator (persistent while synthesized audio plays) | `UI_EVENTS.VOICE_CLONE_ACTIVE` `{active, voice: 'clone'\|'generic'}` | `generic` must be visibly distinct ("generic voice") |
| Live latency chip | `UI_EVENTS.LATENCY` `{measuredMs, withinBudget, p50, p95}` | p50/p95 windowed over recent utterances |
| Translated audio playout | `UI_EVENTS.TRANSLATED_AUDIO` `{chunk (b64 mp3), seq, final}` + the injected `player` | feed through `createJitterBuffer` before the audio element |
| Degradation banner | `UI_EVENTS.DEGRADATION` `{tier, reason}` | announce every downgrade (§13.3) |
| Mute-translated toggle | `integration.muteTranslated(on)` | captions continue |
| Listen-original toggle | `integration.listenOriginal(on)` | suppresses playout, keeps captions |
| Replay last utterance | `integration.replayLastUtterance()` → `UI_EVENTS.REPLAY` | bounded one-utterance ring; feed `audio[]` chunks to the player |
| Live language switch | `integration.setListenLang(lang)` | applies from the NEXT utterance; no renegotiation |
| Pin speaker | `integration.pinSpeaker(id)` / `UI_EVENTS.PINNED` | UI focus + replay priority |
| Attach/state | `UI_EVENTS.STATE` | attached/detached/suspended/resumed/muted-… |
| Reconnect | `integration.suspend(reason)` / `integration.resume()` | call on transport loss/regain; session cursors handle continuity |

## 3. Rules the UI must keep (honesty duties)

1. Captions are ALWAYS marked machine-made; confidence below threshold is
   ALWAYS visible (§13.1).
2. The AI-voice indicator is persistent whenever `VOICE_CLONE_ACTIVE
   {active: true}` and must name generic vs clone (§6.4).
3. Every `DEGRADATION` event is user-visible; degradation is never silent
   (§13.3).
4. The per-call consent copy names the E2E exception in plain words before
   `attach()` is ever called (03-privacy-consent.md §2).
5. Never render another listener's lane: the integration already filters
   deliveries to self; the UI must not reach into `session` internals.
