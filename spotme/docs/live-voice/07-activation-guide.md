# Live Voice Translation — activation guide

How to turn the dark platform on, in order, with the gate each step must
pass. Do not skip steps; every one exists because a rule (roadmap §8, WS3
§18.5) demands it.

## 0. Preconditions (before any flag moves)

- `cd spotme/web && npm test` green (76 suites / 1489 checks).
- `ELEVENLABS_API_KEY` present SERVER-SIDE only (same custody as
  `api/voice.js`).
- The #51 translation platform enabled per ITS activation runbook
  (`TRANSLATION_PLATFORM_V2_ENABLED=true` + desired sub-flags) — the MT
  stage calls `platform.run()`, which refuses while #51 is off.
- Provider retention terms confirmed for every registered provider (WS3
  §12.3 procurement gate).
- Vendor quota review: `gateVendorProxy` limits on `/api/voice` sized for
  streaming segment traffic (see ops runbook §3).

## 1. Dark verification (flags off — the permanent baseline)

Nothing to do: CI already proves byte-identical behaviour with flags off on
every run.

## 2. Cred-gated live smoke (an engineer's machine, never CI)

```
ELEVENLABS_API_KEY=… LIVE_VOICE_LIVE_TESTS=1 \
  node test/live-voice-elevenlabs-stt.test.js && \
ELEVENLABS_API_KEY=… LIVE_VOICE_LIVE_TESTS=1 LIVE_VOICE_TEST_VOICE_ID=<a real clone id> \
  node test/live-voice-adapter-conformance.test.js
```

Gate: both live sections pass (wire + contract on the real vendor).

## 3. Provider benchmarks (the go/no-go evidence)

Run the benchmark plan (`docs/adr/03-live-voice-benchmark-plan.md`) against
live providers per candidate language pair: STT stabilisation p50/p95, TTS
first-audio p50/p95, composed mouth-to-ear on clean/lossy/high-RTT shaped
networks. Gate: p50 mouth-to-ear < 2.5 s, p95 < 3.2 s for the pairs to be
enabled (WS3 §13.2). Record results in a dated addendum to
`04-benchmark-report.md`.

## 4. Internal enablement (server/staging env)

```
LIVE_VOICE_ENABLED=true
LIVE_CAPTIONS_ENABLED=true          # captions first — cheapest, safest
STREAMING_PROVIDER_ENABLED=true
```

Gate: internal calls show captions leading, latency chip within budget,
zero effect on non-participating calls.

Then add translation, then voice:

```
LIVE_TRANSLATION_ENABLED=true       # + verify #51 readiness surface
VOICE_CLONE_ENABLED=true            # clone only for enrolled+consented
```

Gate: per-utterance confidence visible; AI-voice indicator correct for
clone AND generic; barge-in + reconnect exercised by hand.

## 5. Cohort rollout (per validated language pair)

Widen per WS3 §18.5: internal → cohort, 5–8 benchmarked pairs first
(roadmap §6.5). `GROUP_TRANSLATION_ENABLED` stays OFF until the Priority-5
group media plane exists — the flag guards logic that has no media
transport yet.

## 6. The wire-in change (separate, reviewed)

Adopting `bootLiveVoice`/`createCallIntegration` in the call UI is its own
PR: consent copy (03-privacy-consent.md §2), the element mapping
(05-ui-architecture.md), and the roadmap §8 checklist (benchmarks, security
review, monitoring) all apply to THAT change. This branch deliberately
contains no call-screen edits.

## Verification commands (any stage)

```
cd spotme/web
npm test                      # everything, flags off
npm run test:live-voice       # the 17 live-voice suites
node test/bench/live-voice.bench.mjs   # local-cost regression check
```
