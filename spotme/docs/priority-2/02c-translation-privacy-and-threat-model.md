# 02c — Translation Platform: privacy model & threat model

**Companion to** ADR-010b. Scope: additive, gated OFF. The engine is byte-identical
to `origin/master`.

---

## 1. The honest privacy statement

Spot Me markets end-to-end encryption. **Cloud translation is not end-to-end
private.** The moment plaintext leaves the device for a third-party translator,
that provider has seen the message. The platform does not hide this — it makes it
first-class:

- `privacy.isE2EPreserved(posture)` is true **only** for `on-device`.
- `privacy.privacyNotice(posture)` returns an explicit user-facing string: a
  cloud translation is labelled "plaintext was sent to a third-party translator;
  this message was NOT end-to-end private for translation" — the same honesty the
  shipped `src/lib/translate.js` already applies with its "cloud" label.
- The pipeline attaches that notice to every served result (`result.privacyNotice`).

## 2. Privacy modes → admissible providers (`privacy.js`)

A request declares a MODE; the mode fixes which provider POSTURES are admissible.

| mode | admits postures | meaning |
|---|---|---|
| `strict` | on-device | nothing leaves the device — E2E preserved |
| `sensitive` | on-device, cloud-contract | a contracted cloud (DPA in place), never keyless |
| `standard` | on-device, cloud-contract, cloud-keyless | consumer chat; keyless last-resort allowed |

Rules:
- The mode **only ever tightens** — `context.buildContext` raises the floor to
  `sensitive` when PII is present in the message or the retained context, and a
  per-conversation pref can force `strict`; it never loosens.
- An **enterprise tenant** (a request carrying a `tenantId`) keeps the keyless
  denial even in `standard` — a keyless vendor has no data-processing agreement.
- `privacy.privacyPolicyForMode(mode)` produces the exact `(posture, tenantId) →
  bool` gate the router consumes as `policy.privacyPolicy`, so mode selection and
  routing cannot drift apart.

## 3. Data retention posture (per provider)

| posture | meaning | providers |
|---|---|---|
| `none` | nothing leaves the device | device |
| `contract` | a data-processing agreement is in place | google, sarvam, gemini, openai, anthropic, elevenlabs |
| `contract-no-trace` | contract plus a documented no-trace option | azure |
| `unknown-no-contract` | keyless endpoint, no agreement — denied to tenants by default | google-inputtools, gtx, mymemory |

## 4. Redaction hook

`privacy.redact(text)` replaces detected PII (email, card, IPv4, phone — a
digit-count-validated, deterministic heuristic) with **translation-inert
placeholders** (`⟦EMAIL_1⟧`), returning a reversible map. It is intended to run
BEFORE a third-party call; `privacy.reinsert` restores placeholders after
translation. A `false` from `classifyText` means "no obvious PII", not a
guarantee of none — the heuristic is high-signal, not exhaustive.

## 5. Safe telemetry

`privacy.safeLogFields(record)` is a **whitelist** (not a denylist): only a fixed
set of aggregate-safe fields survive; message text, `q`, `script` content,
`english`, and any key-shaped value are dropped. `metrics.record()` reads only
aggregate-safe fields, so no plaintext or secret can enter a log or metric even
if a caller passes one. `readiness()` returns booleans, counts and circuit states
— asserted free of `key|secret|token|apiKey` in `test/translation-metrics.test.js`.

## 6. Threat model

| # | Threat | Mitigation |
|---|---|---|
| T1 | **Prompt injection** via message content into an LLM leg | The engine's per-request fenced prompts and faithfulness-first adjudication are UNCHANGED and remain the guard; the platform reuses the engine, it does not re-prompt. |
| T2 | **Wrong-script output** shipped as a translation | The engine's own `scriptOk` is reused (not copied) at every platform stage — consensus drops wrong-script candidates, execute sheds them, adjudication verdicts are re-checked. |
| T3 | **Cache cross-user leak** — one user's private-context result served to another | The canonical key folds in privacy mode + a context fingerprint (a hash of speakers/glossary/prefs/recent-turn text); different context ⇒ different key. Proved in `test/translation-cache.test.js`. |
| T4 | **Stale cache after a model change** | Version-stamped entries; `invalidateVersion` drops entries from a retired engine version. |
| T5 | **PII sent to a low-trust provider** | PII classification raises the privacy floor to `sensitive`, and `sensitive`/`strict` gate out keyless providers; a redaction hook can strip PII before the call. |
| T6 | **Secret/plaintext in logs or telemetry** | Whitelist `safeLogFields`; metrics ignore unknown/content fields; adapters carry no key (contract's forbidden-secret surface). |
| T7 | **Cost exhaustion / denial-of-wallet** | Per-account daily/monthly ceilings, hard refusal over budget, fan-out budget with mandatory recorded reason. |
| T8 | **A dead/hostile provider stalling the pipeline** | Circuit breaker sheds it; bounded per-provider retry on transient errors only; a fallback always exists (no provider is a hard dependency). |
| T9 | **Confidence inflation** — showing an unverified guess as confirmed | Confidence is derived from the verification outcome; an unresolved/failed case returns explicit `uncertain: true`, which the cache refuses to store. |
| T10 | **Silent flag-on** turning the platform live by accident | Strict exact-match flags, layered under a master; a disabled platform refuses `execute()`/`run()`; the not-shipped fence proves no app importer. |

## 7. Residual risks / owner decisions

- **Plaintext in memory.** The cache and quality/cost counters hold plaintext and
  aggregates in process memory only (bounded, gated), mirroring the engine's
  existing in-memory caches. A durable/server cache (design §11/§13) is an owner
  decision and is NOT built here.
- **Provider trust is transitive.** A `contract` posture is only as good as the
  actual DPA; the retention column is a claim to be verified operationally, not a
  cryptographic guarantee.
- **Redaction is heuristic.** It reduces, not eliminates, PII exposure to cloud
  providers; `strict` mode (on-device only) is the sole path that preserves E2E.
