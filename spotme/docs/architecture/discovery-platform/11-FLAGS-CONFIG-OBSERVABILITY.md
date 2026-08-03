# 11 — Feature Flags, Configuration & Observability

> Part of the [Discovery Platform Architecture Specification](README.md).
> Engineering spec — draft for owner review (stacked PR; documentation only,
> nothing here activates code). Numeric values are [PROPOSED] config defaults.

## 11.1 The two-layer control model

The owner's configuration principle ("never hardcode tunables") and
[ADR-015](../../adr/015-compile-time-feature-flags.md) ("flags are compile-time
constants") are not in tension — they govern **different layers**:

```
 Layer 1 — ACTIVATION  (compile-time)      Layer 2 — TUNING  (runtime)
 ─────────────────────────────────────     ─────────────────────────────────────
 Is this feature in the product at all?    How does this ACTIVATED feature behave?
 Plain module constants, default false;    Named, typed config keys with safe
 hard MASTER gate; tree-shaken; fenced.    defaults; validated; classed; audited.
 Changing it = an owner-authorised code    Changing it = a governed config change,
 change whose whole subject is activation  no code change, no deploy
 (Governance G8).                          (owner sign-off where privacy-critical).
```

The joining invariant: **runtime configuration can tune a live feature; it can
never turn on a dark one.** No activation toggle may exist as a runtime key —
the config schema (§11.4) rejects feature-gating booleans by construction.
A dark subsystem reads no config because it does not run.

## 11.2 Layer 1 — activation: compile-time flags

Per ADR-015 and [ADR-016](../../adr/016-dark-shipping.md), and running today
`[REUSE]` in `spotme/web/src/lib/discovery-v2/flags.js` (draft PR #60) and
`spotme/web/src/lib/live-events/flags.js` (draft PR #61):

- Flags are **plain module constants** — never localStorage, URL params, env
  vars, or a debug handle. **Every value defaults `false`.**
- A **hard `MASTER` gate ANDs every sub-flag** (`resolveFlags`): no sub-flag
  can light a feature while the master is down; turning a subsystem on is one
  deliberate edit to `MASTER`.
- A production build with the master down **tree-shakes the subsystem out of
  `dist`** — dark code costs users nothing and is not one assignment away
  from running.
- **Fence tests** prove it mechanically (`*-not-shipped.test.js`): shipped
  dark (`assertShippedDark`), not wired in, stripped from `dist`, no secrets —
  while the same suite exercises every module, so dark ≠ untested. `[REUSE]`
  `spotme/web/test/discovery-v2-not-shipped.test.js` /
  `spotme/web/test/live-events-not-shipped.test.js` (draft PRs #60/#61);
  precedent: the **merged** signing fence
  `spotme/web/test/signing-not-shipped.test.js` (PRs #29/#36).
- **Activation is a separate, owner-authorised change** (Governance G8,
  [05-GOVERNANCE](../../handbook/05-GOVERNANCE.md)) in which the fence is
  deliberately deleted — a change whose whole subject is that authorisation,
  gated by the evidence pack of §11.9. Tests exercise features only via
  injected flag overrides (`resolveFlags(overrides)`), never by touching the
  shipped constant.

Each surface keeps its **own** flag module and fence (Events is not a
Discovery sub-flag `[REUSE]` live-events rationale); new surfaces (Moments,
AI Assistant) follow the identical pattern.

## 11.3 Layer 2 — tuning: the runtime configuration service

**Status: planned — no code exists.** `[PROPOSED]` home: a config module in
the target monorepo (`apps/api` + a shared schema in `packages/contracts`;
[13-IMPLEMENTATION-MAP](13-IMPLEMENTATION-MAP.md)). Behaviour:

- **Typed schema.** Every key is declared once with type, unit, bounds,
  governance class, and owning chapter. Unknown keys are rejected — config is
  a closed, reviewed namespace, not a property bag.
- **Safe defaults are compiled in.** Every key's default ships in the build
  (the `[PROPOSED]` values of this spec, ratified by the owner). If the
  config store is unreachable, the platform runs on defaults — **fail-safe,
  never fail-open**; a config outage can never widen privacy or disable a
  bound.
- **Validated before accept.** A proposed change is checked against the
  invariant set (§11.4) *atomically*: invalid ⇒ rejected whole, never
  partially applied ([04-RANKING-SERVICE §4.7](04-RANKING-SERVICE.md)).
- **Deterministic tests inject config objects** as plain arguments — the
  engines already work this way `[REUSE]` (weights, steps, TTLs are
  parameters throughout the dark modules); no test talks to a config service.

## 11.4 Validation invariants

Run automatically on every proposed change, before acceptance:

| Invariant | Guards | Chapter |
|---|---|---|
| Ranking weights sum to 1 (ε), all ≥ 0, signals registered | score comparability, `notify.match.threshold` meaning | [04 §4.7](04-RANKING-SERVICE.md) |
| **Proximity outranks popularity** in every profile | constitution — rank cannot be bought | [04 §4.7](04-RANKING-SERVICE.md) |
| Radius steps strictly ascending, capped | honest expansion ladder | [03 §3.6](03-INTENT-GRAPH-AND-SEARCH.md) |
| TTL/retention bounds (positive, ordered, within retention promises) | honesty of freshness; data minimisation | [08-DATA-AND-CACHING](08-DATA-AND-CACHING.md) |
| Privacy floors: cell ≥ floor, window ≥ floor, offset ≤ cap | approximation can be coarsened by config, **never refined below the owner-set floor** | [02 §2.6](02-LOCATION-PRIVACY-ENGINE.md) |
| No feature-gating boolean in any runtime key | §11.1 joining invariant | this chapter |

Invariants are **executable validators** shared with the test suites, not
review-time prose.

## 11.5 Governance classes and audit

Three classes; the class is part of each key's schema:

| Class | Who may change it — and how | Examples |
|---|---|---|
| `privacy-critical` | **Not ordinary runtime configuration** (owner directive, 2026-08-03). Anything affecting a privacy *guarantee* — location precision, consent semantics, what may cross the wire — changes only through a **code-reviewed change with explicit owner approval** (a reviewed PR whose mutation/fence tests are updated in the same change), never through the runtime config service. The values are declared in code; the registry lists them **read-only** for visibility. | `discovery.privacy.cellM` = 500 · `discovery.privacy.windowMs` = 1800000 · `discovery.privacy.maxOffsetM` = 150 |
| `product` | Product decision, via the validated + audited runtime path | `discovery.radius.steps` = [10,15,25,50,100] km · `discovery.radius.minResults` = 8 · `places.ranking.weights` · `events.ranking.weights` · `exchange.ranking.weights` · `notify.match.threshold` = 0.6 · `notify.digest.windowMin` = 30 · `data.retention.resolvedDays` = 30 · `events.retention.endedHours` = 6 |
| `ops` | SRE, via the validated + audited runtime path | `events.ttl.staleMin` = 15 · `api.page.maxSize` · `api.idempotency.windowHours` · provider timeouts/breakers ([05 §5.6](05-PROVIDER-ABSTRACTION.md)) |

**The privacy floor is structural, not procedural:** no `product` or `ops` key
may exist whose adjustment could expose precise coordinates or weaken consent —
such a knob is a design defect, rejected at schema-review time. Runtime
configuration can tune *how well* the platform works, never *how private* it is.

All defaults `[PROPOSED]`; chapter-local keys (ranking falloffs, notification
rate caps, page bounds) register in this same registry under their owning
chapter. **Every accepted change is audited: actor, key, old value, new
value, reason, validation result, timestamp** — the audit log is append-only
and is itself observable (§11.6). **Staged rollout for risky changes**:
ranking-weight and radius changes roll out staged (subset of traffic, watch
the §11.6 shift alarms, then full), and revert is a config change through the
same validated, audited path — rollback needs no deploy.

## 11.6 Metrics catalogue

Target stack is the platform's (memory §2.12: OpenTelemetry → Prometheus/
Grafana; `packages/observability`). **Status: planned — no Discovery metrics
exist today.** The catalogue every surface must emit:

| Metric | Type | Why |
|---|---|---|
| Search latency p50/p95/p99, per surface and per radius step | histogram | the product promise is "nearest, fast" |
| Result-state distribution (`ok/partial/empty/unavailable/failed/superseded`) | counters | honesty made measurable — a rising `partial` is a provider incident |
| Provider error/timeout rate, breaker state, **cost per provider** | counters/gauges | routing and ceilings ([05 §5.6–5.7](05-PROVIDER-ABSTRACTION.md)) |
| Radius-expansion frequency (terminal `radiusKm` distribution; ladder exhaustion rate) | histogram | tuning signal for `discovery.radius.*` |
| **Ranking-distribution shift alarms** (score and per-signal contribution distributions vs baseline) | gauges + alert | a weight change that reorders the world must page someone; feeds §11.5 staged rollout |
| Match rate / report rate / appeal rate (Exchange) | counters | marketplace health and abuse signal ([exchange/06](../../handbook/product/exchange/06-MODERATION-AND-FRAUD.md)) |
| Notification delivery/open/dismiss rates, per class | counters | measured delivery, never assumed ([07 §7.7](07-NOTIFICATION-SERVICE.md)) |
| Config changes per class; audit-log write failures | counters | governance is monitored, not trusted |

## 11.7 Structured logs — absolute prohibitions

Structured JSON with correlation IDs and build identity (memory §2.12).
**Prohibited in any log, at any level, in any environment:**

1. **No precise location** — no raw fix, no coordinate finer than the public
   approximation, no origin echo
   ([ADR-019](../../adr/019-discovery-v2-privacy-model.md): never logged, never
   in analytics, debug handles, or URLs).
2. **No sensitive attributes** — nothing inferred or inferable (health,
   religion, orientation…); query free-text is not logged, only length/
   category class ([roadmap v2.0 §22](../../handbook/product/SPOT-ME-PRODUCT-ROADMAP-V2.md)).
3. **No raw transcripts** — the frontend rule of memory §2.2 ("no raw
   exact-location or sensitive transcript logging") applies platform-wide.
4. **No secrets, no raw provider payloads** — normalisation drops `raw`
   before anything can log it; `assertNoSecrets` `[REUSE]`
   `spotme/web/src/lib/discovery-v2/contracts.js`.

Enforcement is mechanical: a scrubbing serializer plus the mutation-style
scanner suites (§11.10), not reviewer vigilance.

## 11.8 Traces, alerting, cost ceilings, dashboards

- **Traces** span the whole search pipeline — intent parse → radius step →
  provider fan-out → normalise → rank → envelope — with span attributes
  limited to safe facts (provider name, `radiusKm`, counts, durations, state);
  never query text, never coordinates (§11.7).
- **Alerting**: SLO-based, actionable, runbook-linked (memory §2.12/§2.13).
  Alarms: latency SLO burn, provider breaker open, `unavailable`/`failed`
  rates, ranking-shift (§11.6), notification delivery collapse, audit-log
  failures.
- **Cost ceilings**: per-provider daily/monthly ceilings with cost accounting
  on every call ([05 §5.6](05-PROVIDER-ABSTRACTION.md); memory §2.9). At a
  ceiling the router degrades honestly — fall back or return `unavailable` —
  **never silent overspend and never fabricated results**.
- **Per-surface dashboards** (Map, Events, Exchange; Moments when it exists)
  over one shared platform dashboard (providers, config audit, flag state —
  which must read **dark** until an authorised activation).

## 11.9 Activation evidence pack — Definition of Done

Layer-1 activation (§11.2) requires an evidence pack per the platform
Definition of Done (memory §5) and Governance G8 — in order, each gate green
before the next:

1. **Fence green** — the `*-not-shipped` suite passes on the final dark build
   (proving tested-dark), then is deleted *in* the activation change.
2. **Staging with real providers** — real credentials and dependencies
   validated in a production-like staging (mock-only evidence is
   insufficient — memory §4.8).
3. **Device matrix** — real devices and supported browsers, including
   foreground/background behaviour where the surface touches notifications.
4. **Rollback rehearsal executed** — flag-revert build *and* config-revert
   actually performed and verified, not described.
5. **Monitoring live** — §11.6 metrics, §11.8 alerts and cost ceilings
   configured *before* users arrive.
6. **Owner approval recorded** — the explicit sign-off, in the repository
   ([ADR-014](../../adr/014-repository-over-memory.md)).

A capability with only interfaces, stubs, or dark modules is **not done** —
this spec's own status line, applied to itself.

## 11.10 Deterministic testing

**Injected:** config (plain objects into every engine — no config service in
tests), flag overrides (`resolveFlags`, never the shipped constant), clock
(TTL/retention/audit timestamps), scripted metric/log sinks.
**Mutation/invariant tests pin:** `assertShippedDark` on the shipped flag
constants and the full fence set of §11.2 `[REUSE]` (draft PRs #60/#61;
merged signing precedent); every §11.4 validator rejects a violating change
whole (weights ≠ 1, popularity ≥ proximity, unsorted radius steps, TTL out of
bounds, privacy value finer than floor) and no partial application is
observable; a runtime key that gates a code path fails schema review; the
audit record for an accepted change carries actor+old+new+reason; the log
scrubber suite proves no precise coordinate, sensitive attribute, transcript,
secret-shaped key, or raw provider payload survives serialisation (the
[02 §2.7](02-LOCATION-PRIVACY-ENGINE.md) scanner extended to logs and span
attributes); and with the config store faked down, every engine runs on
compiled-in defaults — the fail-safe invariant as an assertion.
