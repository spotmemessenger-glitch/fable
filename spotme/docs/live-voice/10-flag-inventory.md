# Live Voice Translation — flag inventory

All flags read via `src/lib/live-voice/flags.js` only. Parsing: an unset,
empty, or unrecognised value is OFF; only `true|1|on|yes` (trimmed,
case-folded) is ON. Sub-flags are LAYERED: they read true only when the
master is ALSO on. In-process override seams exist for tests/wire-in
(`setLiveVoiceOverride`, `setLiveVoiceSubOverride`) and never for
production configuration.

| Flag (env; `VITE_`-prefixed also read in Vite builds) | Default | Layer | Gates | Off behaviour |
|---|---|---|---|---|
| `LIVE_VOICE_ENABLED` | **false** | master | the entire platform; `bootLiveVoice`; `attach()` | module inert; app byte-identical |
| `LIVE_TRANSLATION_ENABLED` | **false** | under master | the MT stage / translated captions+voice; also required by `attach()` | attach refuses; sessions built directly run original-captions mode only |
| `VOICE_CLONE_ENABLED` | **false** | under master | using the enrolled clone `voiceId` for TTS | neutral premade voice, labelled `generic` |
| `LIVE_CAPTIONS_ENABLED` | **false** | under master | captions-without-speech session mode | a session with translation also off refuses to construct |
| `GROUP_TRANSLATION_ENABLED` | **false** | under master | >2-participant sessions (logic only; media is P5-blocked) | >2 participants refuse at construction |
| `STREAMING_PROVIDER_ENABLED` | **false** | under master | constructing a REAL provider transport (no-injection open()) | adapters refuse to open; injected fakes (tests) unaffected |

Related but NOT owned here (read for context only): the #51 flags
(`TRANSLATION_PLATFORM_V2_ENABLED` + its sub-flags) gate the platform the
MT stage calls — both stacks must be up for live translation to function;
either alone is insufficient by design.

Asserted in `test/live-voice-flags.test.js`: every default false; layering
(sub true + master off = OFF); env forms; override seams; and the suite
leaves every flag off.
