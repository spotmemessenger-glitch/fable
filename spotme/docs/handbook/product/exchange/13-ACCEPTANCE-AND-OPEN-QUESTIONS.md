# 13 — Acceptance Gates, Ratification & Open Questions

> Reconstruction pending A5 ratification. This chapter tells the owner exactly
> what to decide, and tells a future engineer exactly when Exchange is "done".

## 13.1 Ratification checklist (closes gap A5)

Before Exchange **implementation** begins, the owner ratifies (or corrects) each,
reconciling this PRD against the approved Exchange spec:

- [ ] **Concept & non-goals** (§01) — esp. **no payments/escrow in v1**.
- [ ] **Screen set & primary flows** (§02).
- [ ] **Lifecycle state machines** (§03) — Need/Offer/Match/Handoff.
- [ ] **Ranking weights & decays** (§04.4) — `0.35/0.25/0.20/0.15/0.05` and
      falloffs; and **proximity-outranks-popularity** invariant.
- [ ] **Interface-first AI** (§04) — no LLM activation without authorisation.
- [ ] **Notification classes, thresholds, batching** (§05).
- [ ] **Moderation pipeline, safe-category allow-list, fraud controls** (§06).
- [ ] **Privacy model** (§07) — approximate-only, consent gate, retention.
- [ ] **API surface & provider ports** (§08).
- [ ] **Data model** (§09) — no exact-coordinate/sensitive columns.
- [ ] **Business participation & reputation** (§10) — labeled sponsorship.
- [ ] **Retention/limits/budgets** (§07/§12) `[PROPOSED]` values.

When ratified, replace `[PROPOSED]` labels with agreed values and mark A5 closed
in [../../10-CONTRADICTIONS-AND-GAPS](../../10-CONTRADICTIONS-AND-GAPS.md).

## 13.2 Acceptance gates (Definition of Done)

Exchange follows the platform Definition of Done (roadmap v2.0 §25;
`MIGRATED_BUILD_MEMORY` §5). It is **not done** when only interfaces/dark modules
exist. Per-surface gates:

- **Privacy:** mutation tests prove no precise coordinate reaches any Need/Offer/
  match/notification/log/DOM; consent gate enforced; retention/purge verified.
- **Ranking fairness:** deterministic tests pin weights and the
  proximity-outranks-popularity invariant; rationale renders for every match.
- **Safety/fraud:** moderation pre/post pipeline, report/block/appeal, rate/
  velocity limits, and earned-reach all exercised; two-reviewer rule for
  safety-critical actions.
- **Honesty:** empty/partial/unavailable/failed states are real; no fabricated
  matches, counts, or locations; radius-expansion is disclosed.
- **Provider-neutral:** adapters carry no secrets; no vendor hard dependency;
  fence test proves the subsystem ships **dark** until owner activation.
- **Offline/integrity:** compose/act offline queue and replay idempotently; no
  loss/duplicate/reorder.
- **Real-device + staging:** validated with real providers/credentials in
  staging and on real devices; cost ceilings, monitoring, rollback executed;
  **owner approves activation**.

## 13.3 Build sequencing (when authorised)

Exchange is **Discovery step 2**; it reuses the step-1 Smart Nearby Discovery Map
foundation. Suggested dark-first order `[PROPOSED]`:

1. Contracts + data model + flags (dark, fenced).
2. Compose + lifecycle + honest states (no matching yet).
3. Matching pipeline + transparent ranking (deterministic tests first).
4. Unified search integration + map surface (reuse Discovery).
5. Notifications + handoff (reuse push + reach).
6. Moderation/fraud + reputation.
7. Business seam (dark).
8. Hardening → staged activation (owner-gated).

Each step: small stacked draft PR, flags OFF, tests + mutation tests +
benchmarks, owner review — no merge/activation without authorisation.

## 13.4 Open owner decisions

| # | Decision | Default in this PRD |
|---|---|---|
| 1 | **Provide the approved Exchange spec** to reconcile against | This PRD stands in until then |
| 2 | Payments/escrow in v1? | **No** (Future Scope) `[PROPOSED]` |
| 3 | Ranking weights & decays | §04.4 `[PROPOSED]` |
| 4 | Radius/expiry/retention/rate-limit values | §§04/07/12 `[PROPOSED]` |
| 5 | Safe-category allow-list | Curated, sensitive excluded `[PROPOSED]` |
| 6 | Proactive provider pings default | **Off** `[PROPOSED]` |
| 7 | Reputation model specifics | §10 `[PROPOSED]` |
| 8 | Provider selections (intent/safety/geo) | Provider-neutral; choose later |

## 13.5 Owner review feedback incorporated (2026-08-03)

From the owner's review of PR #64 — recorded so ratification starts from the
reviewed position:

1. **Exchange is a platform service, not a module** — the universal **Intent
   Graph**; every surface publishes into it. Incorporated at §1.8; the
   intent-routing service is specified in the Discovery Platform Architecture
   Specification (separate stacked PR). Proposed for formal ratification as a
   new ADR (Exchange-as-platform-service).
2. **Numeric constants stay configurable** — the PRD fixes behaviour; values
   (radii, weights, TTLs, thresholds, limits) live in runtime configuration with
   safe defaults. Incorporated in README Conventions and §4.4.
3. **A5 approach endorsed** — converting "no specification" into "a reviewable
   specification" accepted; ratification checklist (§13.1) remains the closing
   mechanism.
4. **Payments/escrow excluded from v1** — endorsed (§1.5).
5. **AI is assistive** — AI understands intent; the transparent ranking engine
   decides; explainability preserved (§04). Endorsed.

## 13.6 Dependencies

- Discovery V2 (PR #60) foundation `[REUSE]`; push platform (#48/#52) `[REUSE]`;
  knock/chat (`reach.js`) `[REUSE]`; the target architecture's realtime/outbox
  and `provider-sdk`. Exchange is **step 2**; it does not begin until the owner
  approves and A5 is ratified.
