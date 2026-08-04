# ADR-010 — Translation Platform (provider abstraction)

**Status:** Proposed — **PLANNING ONLY** (owner directive 2026-08-01).
**Depends on:** the shipped multi-provider engine (`web/api/translate.js`),
roadmap §2 rule 10 (accuracy + latency + privacy; no hard provider dependency).

## Context — the platform already half-exists, undeclared

`web/api/translate.js` (902 lines) is not a thin proxy. It already contains:
official Google Cloud Translation v2, Azure Translator v3
(translate/transliterate/detect), Sarvam (Indic specialist), a Gemini
translation leg; an LLM reading chain for romanized-Indic chat
(Anthropic → Gemini → OpenAI, first success wins, failures collected);
**parallel cross-confirmation** (primary + Sarvam raced, wrong-script answers
disqualified by `scriptOk` — both Sarvam and Gemini have been caught answering
in the wrong language); an **LLM adjudicator panel** on disagreement
(OpenAI → Gemini → Anthropic, the candidate's own author excluded,
faithfulness-first briefing against prompt injection); per-request nonce
fencing on every attacker-reachable string; per-user rate limits (40/min LLM,
120/min MT). The client (`lib/translate.js`) runs on-device first → authed
proxy → keyless `gtx` → MyMemory last resort, with session-only plaintext
caches. ElevenLabs is adjacent (STT/TTS/cloning) and joins for voice flows.

What does NOT exist: a declared provider interface, routing as data rather
than code, confidence scoring, quality evaluation as a feedback loop,
cost-aware routing, and observability. **This ADR formalises what grew
organically; it does not rebuild it.**

## Decision (design to be implemented when scheduled)

### 1. Provider abstraction

One interface per capability — `translate`, `transliterate`, `detect`,
`read` (LLM comprehension), `judge` — each provider registering the
capabilities it actually has: OpenAI, Gemini, Azure, Sarvam AI, ElevenLabs
where applicable (voice legs), plus the incumbent Google MT, Anthropic, and
MyMemory (client fallback). Providers declare: supported language pairs,
script coverage, cost class, and latency class. The existing functions become
registrations, not rewrites.

### 2. Dynamic routing — by language pair, latency, quality, availability

A routing table (data, not branches) scores candidates per request:
pair-fitness (Sarvam for Indic, general MT elsewhere — today's hardcoded
order becomes a scored default), measured p50 latency, rolling quality score
(§4), current availability (circuit-breaker state), and cost class. The
router degrades, never dies: any single provider outage re-routes — **no
provider may become a hard dependency** (roadmap rule 10). The existing
first-success chains are the degenerate form of this router and keep working
during migration.

### 3. Context preservation

Conversation-context windows for the LLM legs (the reading chain already
proves context matters — "varen" is a promise, not a description), with the
same fencing discipline: context is attacker-authored text and rides inside
nonce fences, never as instructions. Context stays session-scoped and is
never persisted server-side (the client's own cache rules are the precedent:
plaintext caches were pulled out of localStorage for disappearing-message
hygiene).

### 4. Confidence scoring and quality evaluation

Every response carries `confidence`: agreement-derived (two engines agreeing
on meaning-normalised text — `agree()` exists), adjudicator-derived (which
candidate won, why), or single-engine (lowest). Quality evaluation is the
feedback loop: adjudicator verdicts and wrong-script disqualifications are
already computed and thrown away today except for one log line — they become
the rolling per-provider, per-pair quality score the router reads.

### 5. Cost-aware routing and observability

Per-provider cost classes and counters (calls, tokens where metered,
failures, fallbacks taken, adjudications) — the audit's corrected finding
stands: **eight metered vendors, no caps in code**. Budgets and alerts are
part of this design, feeding the same observability surface as ADR-009 §4.

### 6. Enterprise accuracy and latency

Accuracy: cross-confirmation + faithfulness-first adjudication (shipped)
made systematic per §4. Latency: parallel racing (shipped) kept; routing adds
"skip confirmation for high-confidence pairs" as a measured, not assumed,
optimisation. Targets and benchmarks per V2 §8 land with implementation.

## Non-goals

No provider SDK lock-in; REST clients stay. No server-side translation
memory of message plaintext. No change to E2E properties: translation
operates on text the user explicitly submitted for translation.

## Rollback / activation

The abstraction lands behind the existing engine order as default — routing
table OFF means today's behaviour, verbatim. Per-capability flags; rollback
is the flag, and the legacy chain remains the code path underneath it.
