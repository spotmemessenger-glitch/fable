# 02e — Translation Platform: rollout, rollback & ops runbook

**Companion to** ADR-010b. Scope: additive, all flags default **false**, NOT
wired into the live path. The engine (`web/api/translate.js`,
`web/src/lib/translate.js`, `web/src/lib/english.js`) is byte-identical to
`origin/master`.

---

## 1. Current state (this PR)

- Nothing is enabled. No app file imports the platform (enforced by
  `test/translation-v2-not-shipped.test.js`). The live translate path is exactly
  today's engine.
- The full test suite is green, including every pre-existing test and the
  not-shipped fence. New coverage: retry, privacy, cost, cache (with isolation),
  context, verify, metrics, routing-properties, and integration (with the
  flag-OFF byte-identical compatibility proof).

## 2. Activation — the deliberate, layered path

Activation is a **separate change**, done one layer at a time. At each step,
watch the observability surface (`platform.readiness()`) and roll back by
clearing the flag (a data change, no deploy).

1. **Wire the entry (no behaviour change).** Adopt
   `integration.createTranslationEntry({ engine, platform })` at the app's
   translate call site. With the master flag OFF this is a **pure passthrough** —
   byte-identical to today — so shipping the wiring is safe on its own.
2. **Supply a real engine delegate.** Give the engine port a delegate
   (`adapters/engine-port.createHandlerDelegate`) so the platform can actually
   reach the vendors when enabled. Still inert while the master is OFF.
3. **Shadow routing.** Turn on nothing user-visible; call `platform.decide()`
   alongside the live path and log the decision. Compare chosen-provider
   distributions against the engine's actual order. (Safe: `decide()` has no side
   effects and runs even while the master is OFF.)
4. **Master ON, dynamic routing ON, canary.** Set `TRANSLATION_PLATFORM_V2_ENABLED`
   and `TRANSLATION_DYNAMIC_ROUTING_ENABLED` for a small cohort. Watch success
   rate, latency percentiles, wrong-script rejections, uncertainty rate.
5. **Cache ON.** Set `TRANSLATION_CACHE_ENABLED`. Watch cache hit rate and, above
   all, re-verify the isolation invariant in production sampling (no cross-user
   answers). Version-bump `policyVersion`/`engineVersion` on any model change to
   invalidate.
6. **Cost governance ON.** Set real ceilings (02d), then
   `TRANSLATION_COST_GOVERNANCE_ENABLED`. Watch `blocked`/`softWarnings`.
7. **Cross-verify, then adjudication.** Enable `TRANSLATION_CROSS_VERIFY_ENABLED`,
   then — only with cost governance already on — `TRANSLATION_ADJUDICATION_ENABLED`.
   Watch adjudication count and fan-out budget.
8. **Widen** cohort by cohort to 100%.

## 3. Rollback

- **Any enabled layer:** clear its flag (env var → `false`/unset, or the global
  override). Sub-flags are layered, so clearing the master disables all of them at
  once. This is a data change, no deploy; the legacy chain remains underneath.
- **Active-platform full rollback:** clear the master flag. The entry becomes a
  passthrough again immediately.
- **Remove the code entirely:** delete `web/src/lib/translation/`, the
  `test/translation-*.test.js` files, the two benches under `test/bench/`, and the
  appended `&& node test/translation-*.test.js` entries in `web/package.json`; and
  the `docs/adr/010b-*.md` + `docs/priority-2/02b–02f-*.md` files. No existing
  file is otherwise modified; no migration, key, flag or crypto state to unwind;
  mixed-version deploys are safe (the engine is unchanged).

## 4. Ops runbook

**Health / readiness.** `platform.readiness()` returns `{ ready, flags,
providers, capable, circuits, cache, cost, metrics }` — booleans, counts and
circuit states, no secret, no content. `ready` is true when at least one provider
can translate and not every such provider's breaker is open.

| symptom | where to look | likely cause / action |
|---|---|---|
| latency up | `metrics.latencyMs.p95/p99`, `byProvider` | a slow provider leads under the active profile; check `circuits`; consider `latency` profile / a pair override |
| uncertainty up | `metrics.uncertaintyRate`, `wrongScriptRejections` | providers disagree or answer wrong-script; check a specific `byPair`; adjudication may be off |
| spend up | `cost.snapshot()` (`recorded`, `fanouts`) | fan-out rate high; check `softWarnings`/`blocked`; tighten fan-out budget or ceilings |
| cache ineffective | `cache.snapshot().hitRate` | context fingerprints too specific (expected for private chat) or version churn; check `invalidations` |
| a provider is down | `circuits.<id>` = `open` | breaker shed it; it half-opens after cooldown; nothing to do unless every translator is open (`ready:false`) |
| "translation uncertain" shown to users | `metrics.byBand` (`degraded`/`fallback`) | working as designed — an honest low-confidence signal, not an error |

**Knobs (env).** Circuit `TRANSLATE_LEG_MS`/`TRANSLATE_LLM_MS` (engine, unchanged);
routing profile via request or `policy.profile`; cost ceilings via governor
config; cache TTL/size via `cacheOptions`.

## 5. Known limitations (honest)

- **Deferred (needs live credentials / a deploy target):** the real engine
  delegate is dormant; no test makes a live vendor call. End-to-end latency on the
  deploy target is unmeasured here.
- **Streaming / live voice is a STUB.** `integration.streaming` declares the shape
  and throws; there is no live-call implementation (that is ADR-011 ③).
- **No persistence.** Cache, quality EWMA and cost counters are in-memory and
  reset on restart; the durable tables (design §13) are deferred owner decisions.
- **No new HTTP endpoint.** Batch/whole-chat/voice-note are supported at the
  library level (`integration.translateBatch` / `translateVoiceNote`); no
  `?op=batch`/`?op=admin` server contract is added.
- **PII redaction is heuristic**, not exhaustive; only `strict` (on-device)
  preserves E2E.
- **Cost figures are order-of-magnitude estimates**, not billing; reconcile
  before hard enforcement.
- **Router edit is minimal and additive:** an optional `attempt` hook (default
  identity). Existing routing behaviour is unchanged and still fully tested.

## 6. Owner decisions required

1. Approve the layered activation order (§2) and the cohort sizes.
2. Set real cost ceilings and fan-out budgets (02d) before cost governance ON.
3. Decide on durable persistence for cache/counters/quality (design §13).
4. Confirm provider retention/DPA claims (02c §3) operationally.
5. Decide whether a server cache (plaintext at rest) is acceptable, or cache stays
   in-memory only.
