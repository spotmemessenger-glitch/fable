# Live Voice Translation — Benchmark Plan

**Status:** Plan only. No benchmark has been run yet; the numbers below are
targets to measure against, not results. This plan pairs with ADR-011 (the
scaffolding) and Roadmap V2 §6.5 (initial performance targets) and §8
(benchmarks must report environment, raw results, median, tail latency, and a
comparison).

**Why a plan now, with no providers wired:** the scaffolding fixes the *shape*
of latency accounting (`latency-budget.js`) and quality checkpoints (the state
machine's `correcting` stage, the caption/audio frames). Deciding *how* those
get measured before a provider is chosen is what lets provider selection be an
evidence-based routing decision (accuracy + latency + privacy) rather than a
default — the standing AI principle in CLAUDE.md.

## 1. What we measure

Three families, because the flagship promise is three promises at once:

1. **Latency** — is it fast enough to feel live? (`< 2.5 s` MVP end-to-end.)
2. **Quality of meaning** — is the translation right? (translation + STT WER.)
3. **Quality of voice** — does it still sound like the speaker? (voice
   similarity.)

A provider that wins one and loses another is not a win; the report keeps all
three side by side per candidate.

## 2. Latency

Measured against the per-stage budget already coded in `latency-budget.js`
(`STAGE_BUDGETS_MS`, total `2500`). Each stage is timed by `mark()` at the
moment the stage reports first-token / final, exactly as the orchestrator does.

| Metric (§6.5) | MVP target | Production target | Budget stage |
|---|---|---|---|
| Partial caption latency | < 1.5 s | < 700 ms | `stt_partial` |
| Translated voice first-audio latency | < 3.0 s* | < 1.5 s | `tts_first_audio` (cumulative) |
| **End-to-end first translated audio** | **< 2.5 s** | < 1.5 s | total |
| Translation-failure fallback | < 2 s | < 1 s | fallback path |
| Voice-profile deletion propagation | < 24 h | < 1 h | out-of-band |

\* §6.5 lists first-audio MVP < 3.0 s; the owner amendment sets the **end-to-end
MVP at < 2.5 s**, which is the harder gate and the one `TOTAL_BUDGET_MS`
encodes. Where they differ, 2.5 s end-to-end wins.

**Report shape (per §8):** environment (device, OS, browser, network profile,
region, provider region), raw per-utterance samples, **median**, **p90 / p95 /
p99 tail**, and a comparison across providers and against the prior run. Report
per-stage medians too — a passing total with a blown `stt_partial` still means
captions feel laggy.

**Network profiles:** at minimum good Wi-Fi, typical 4G (≈100 ms RTT, some
loss), and a degraded high-latency profile (≈300 ms RTT) to size the fallback.

**Harness:** replay a fixed corpus of enrolled-speaker utterances through the
orchestrator with real adapters, driving the same `createLatencyBudget()` used
in production; aggregate `report()` outputs. The deterministic stub run
(`test/live-voice-orchestrator.test.js`) is the *correctness* baseline for the
harness itself, not a latency measurement.

## 3. Translation & transcription quality (WER / accuracy)

- **STT WER** — word error rate of the final transcript vs. a human reference,
  per language, on a fixed read + spontaneous-speech corpus. Report substitution
  / insertion / deletion split; spontaneous speech separately from read speech.
- **Translation quality** — automatic scores (e.g. BLEU / chrF / COMET) against
  reference translations, **plus** human adequacy/fluency rating on a sampled
  subset, because automatic scores rank systems poorly at the sentence level.
- **Partial stability** — how often an interim caption is later revised, and how
  far back. High churn reads as a flickering caption even when the final is
  correct; this is a UX metric the `partial` flag on caption frames enables.
- **Language pairs:** the MVP set is 5–8 validated pairs (§6.5), Indian-language
  first per `translate.js` `LANGS`. Each pair is scored independently — an
  aggregate hides a failing pair.

## 4. Voice preservation (similarity)

The differentiator is that the listener hears the *speaker's* voice (§6.1), so:

- **Speaker similarity** — cosine similarity of speaker-embedding vectors
  between the enrolled sample and the synthesized translated audio, reported as
  a distribution, not a single mean.
- **MOS / naturalness** — subjective mean-opinion-score on a sampled subset
  (naturalness and "does this sound like the same person").
- **Cross-lingual stability** — similarity measured when the target language
  differs from the enrolment language, since that is the actual use.
- **Consent guardrail (not a score, a gate):** every benchmark voice is an
  explicitly enrolled profile. No benchmark may clone a speaker from call audio
  or from a non-consented sample (§6.4). A run that cannot show provenance for
  its voices is void.

## 5. Reliability & fallback

- **Fallback correctness** — inject provider timeout / error / over-budget and
  assert the call continues on original audio + captions (§6.2.8), and that
  `fallback-captions` / `voice-active-off` control frames fire. The scaffolding
  already proves the *logic* deterministically; the benchmark proves the
  *timing* (fallback within the §6.5 window).
- **Barge-in** — measure time from speaker interruption to in-flight audio
  actually stopping; the `cancel()` contract exists, this sizes it end-to-end.

## 6. Pass/fail and provider selection

A candidate provider set passes MVP when, on the validated language pairs and
the target-network profile: end-to-end median `< 2.5 s` with a stated tail,
STT/translation quality above the agreed per-pair thresholds, voice similarity
above threshold, and fallback within §6.5. Selection is then a routing policy
over the three families + cost + regional availability + data retention (§7
integration rules) — **no single provider becomes a hard dependency.**

## 7. Deferred until providers are wired (see ADR-011 §8)

Everything in this document is a plan. It cannot produce numbers until the real
streaming STT/MT/TTS adapters, capture/VAD, and the network transport are
implemented. Until then the placeholder constants in `latency-budget.js` stand
in for measured values and are labelled as such.
