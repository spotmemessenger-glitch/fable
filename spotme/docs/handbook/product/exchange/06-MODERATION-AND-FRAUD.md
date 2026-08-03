# 06 — Moderation, Safety & Fraud

> Reconstruction pending A5 ratification. Thresholds `[PROPOSED]`.

## 6.1 Threat model

Exchange invites strangers to transact locally, so the risks are concrete:
scams (fake offers, advance-fee, bait-and-switch), spam/flooding, prohibited
goods/services, harassment, impersonation, location-based stalking, and
manipulation of ranking. The controls below are **v1 requirements**, not
future work.

## 6.2 Moderation pipeline

```
 compose ─▶ PRE-CHECK (sync, fast)  ─▶ POST-PUBLISH (async classifiers + signals)
    │            │  block/flag                    │  flag/queue
    │            ▼                                 ▼
    │        rejection w/ reason            moderation queue ─▶ human review ─▶ action
    ▼
 ACTIVE (if clean)                         actions: allow / limit-reach / hide / remove / ban
```

- **Pre-check (synchronous):** category allow-list (no prohibited/unsafe
  categories), banned-content patterns, rate/duplicate checks. Fast; blocks the
  worst before publish.
- **Post-publish (asynchronous):** provider-neutral safety classifiers (text/
  image) behind a port; community reports; behavioural signals. `[REUSE]` the
  provider-neutral adapter pattern (no vendor lock-in, no key leakage).
- **Human review** for anything flagged/appealed; two independent reviewers for
  safety-critical actions (`MIGRATED_BUILD_MEMORY` §4). **No automation may hide
  an alert or mark its own unverified claim as evidence.**

## 6.3 Report / block / appeal

- **Report** on every Need/Offer/Match/message: reason taxonomy + evidence
  capture (ids, timestamps, snapshots).
- **Block** removes a user from your matching and hides your items from them,
  bidirectionally.
- **Appeal** for any moderation action, with a human decision and an audit trail.

## 6.4 Fraud & abuse prevention `[PROPOSED]`

- **Identity/verification gates:** posting reach scales with account age/
  verification/reputation; new/unverified accounts get **limited reach** and
  tighter rate limits before trust is earned.
- **Rate limits & velocity checks:** per-user/per-IP/per-device posting and
  messaging caps; burst detection; duplicate-content detection.
- **Anti-scam heuristics:** off-platform-payment lures, advance-fee patterns,
  external-link risk, mismatched location/claims → flag + warn the counterpart.
- **Reputation feedback loop (§10):** confirmed fraud lowers reputation and
  reach; repeat offenders are banned; bans propagate across a user's devices.
- **Sybil resistance:** device-set identity signals and verification raise the
  cost of throwaway accounts; no reliance on precise location for this.
- **In-conversation safety nudges:** scam warnings, "never pay off-platform in
  v1", report shortcuts.

## 6.5 Safe categories & vulnerable users

- A curated **allow-list** of categories; sensitive/illegal/high-risk categories
  are disallowed in v1 `[PROPOSED]`.
- **Stronger defaults for minors and vulnerable users:** restricted categories,
  reduced reach, no exact-location sharing, guardian-appropriate controls.

## 6.6 Auditability

- Every moderation decision is logged with actor, reason, evidence and reversal
  path; metrics (report rate, action rate, appeal-overturn rate) are monitored.
- Location-abuse controls: approximate-by-default and no precise live exposure
  (§07) are the primary structural defences against stalking.
