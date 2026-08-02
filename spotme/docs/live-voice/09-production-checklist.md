# Live Voice Translation — production checklist

The roadmap §8 completion gate applied to this feature. Status is honest:
☑ done on this branch, ☐ open (with owner).

## Code & tests

- ☑ Real provider wire protocols in production paths (ElevenLabs chunked
  Scribe; stream-input websocket TTS); deterministic fakes confined to
  tests
- ☑ Every network/provider path deadline-bounded and cancellable
- ☑ No provider hard dependency: failover chains + #51 routing + ladder
  floors on captions/original
- ☑ Full suite green with zero credentials (76 suites / 1489 checks);
  live smoke cred-gated out of CI
- ☑ Long-session boundedness proven (400-utterance test; capped rings)
- ☑ Lint clean; modules load standalone
- ☐ Scribe realtime-websocket second registration (deferred; chunked wire
  serves)

## Flags & rollback

- ☑ Six flags (master + five layered), all default OFF, strict affirmative
  parsing, defaults asserted in tests
- ☑ Byte-identical app with flags off (fence + full suite prove it)
- ☑ Rollback plan levels 0–2 documented; OFF state CI-rehearsed

## Privacy & security

- ☑ Threat model; trust-boundary doc; consent doc
- ☑ No audio/transcript persistence anywhere (grep-fenced + interface ban)
- ☑ Strict privacy refuses the whole pipeline (tested: zero provider calls)
- ☑ Keys server-side only; no client-bundle path
- ☑ Clone reuse only — no cloning code in this module; generic voice
  labelled
- ☐ Security review of the wire-in change (applies to that PR)
- ☐ Provider retention terms confirmed per region (owner + legal, WS3
  §12.3 / C-6)

## Performance

- ☑ Local orchestration benchmarked (p50 ~48 µs/utterance 1:1; report
  §04)
- ☑ Per-stage p50/p95/p99 instrumentation shipped
- ☐ Live provider benchmarks per language pair on shaped networks — THE
  go/no-go for any cohort (activation guide §3)
- ☐ Mobile-device CPU/battery matrix

## Product / owner decisions still open (WS3 §19)

- ☐ C-1 group scope ratification (logic ships; media blocked on P5)
- ☐ C-3 latency measurement point ratified for the benchmark gate
- ☐ C-4 accept MVP emotion fidelity = identity + adaptive prosody controls
- ☐ C-6 provider retention clearance; C-7 budget numbers for caps
- ☐ Initial validated language-pair list (C-11)

## Ops

- ☑ Runbook, activation guide, flag inventory, known limitations
- ☐ Vendor quota re-sizing for streaming segment traffic
- ☐ Dashboarding of session metrics/ladder occupancy (consumes the shipped
  surfaces; observability stack is Priority-9)

## The wire-in PR (separate) must additionally

- ☐ Per-call, per-direction consent UI naming the E2E exception
- ☐ The §05 element mapping (indicators, confidence cue, degradation
  banners)
- ☐ E2E browser tests over real media (two-origin harness)
- ☐ Roadmap §8 checklist re-run for that change
