# 18 — Priority 1 Final Engineering Review Board

**Status: REVIEW IN PROGRESS.** Review-only exercise; no code modified, nothing
merged. Convened 2026-08-01 to determine whether Priority 1 is genuinely
production-ready, assuming an external cryptography audit will follow.

**Method (owner-mandated):** independent, evidence-based specialist reviews
grounded in the repository, ADRs, tests, vectors, and review documents (`15`,
`16`, `17`). No fabricated consensus — disagreements are recorded and the
stronger position is recommended with evidence. Every finding is classified and
carries evidence, root cause, security + operational impact, reproduction, a
recommended fix, and whether it blocks Priority 1.

**Reviewers (all real code-grounded passes, not personas):**
1. Cryptography (X3DH + Double Ratchet) — **complete** (findings in `16` §21 Pass B)
2. Applied Cryptography / signing lifecycle / device-set / backend crypto — **complete** (`16` §21 Pass A)
3. Backend / Database / Reliability — *running*
4. Frontend / Storage / Networking — *running*
5. Testing / Security synthesis — *running*
6. Coordinator (Executive, Performance, Documentation, Operations) — below

---

## Coordinator sections

### Executive Technical Review

**Architecture — strong.** Cleanly layered (e2e_v2 → A1–A5 trust → A7 signing
identity → e2e_v3 X3DH+ratchet → multi-device), every layer's dependency
explicit, "server is the adversary" applied consistently. Delivered as a small
stacked set of PRs (#39→#41→#42→#43) plus docs, each independently reviewable.
No feature was rewritten; no existing behavior changes with flags off.

**Migration strategy — clean.** Three new tables (`SigningKey`, `SignedPreKey`,
`OneTimePreKey`), all additive, no existing table touched, no data backfill,
FK-cascade to `User`. Order-independent.

**Rollback — real, layered.** Flag-off per layer; the post-publication case has
an *executable* rollback (withdraw), which was the ADR-008 §12 precondition and
is the reason Phase 2B shipped as it did.

**Maintainability — good, with debts.** Heavy inline "why" comments, a complete
ADR trail (13 ADRs), reproducible test vectors, and build-enforced fences make
this unusually legible for a crypto layer. Debts: `dh()`/`toB64`/`fromB64`
duplicated across three modules (deliberate purity, but three copies to keep in
sync); a duplicated IndexedDB fake across two suites; `chat.js` at ~4600 lines
(pre-existing, not this stack).

**Long-term evolution — well-positioned.** SDEV/RDEV pre-wired in the v3 header
for multi-device; `SAFETY_VERSION` versioned and coexisting; AEAD/keygen are
injected seams; the supersession chain is the hook for a future revocation
ledger.

**Executive score: 8.5/10** — architecture and reversibility are the strengths;
the two HIGH backend findings (H1/H2) and the vector-13 defect (B1) are the
reasons it is not a 10 before fixes.

### Performance Review

Measured on WebCrypto, shipped seams (median / p99): X3DH initiator 0.60 / 1.42
ms; ratchet encrypt 0.29 / 1.06 ms; decrypt in-order 0.23 / 0.99 ms; DH-step
0.91 / 1.98 ms; 50 skipped keys 7.08 / 14.8 ms; signing store cold 0.32 ms.
**Steady-state messaging is sub-millisecond CPU.** The one attacker-influenced
path (skipped-key derivation) is linear and hard-bounded at 1000 (~140 ms worst
case, then a refusal) — not a remote-DoS surface (the testing reviewer is
checking the 2× pn+n amplification noted in `16` §21 B4). Bundle retrieval is
one round trip + one atomic delete. **Not measured (owner hardware):** phone /
WebView CPU, IndexedDB latency, memory under 2000 skipped keys, battery.
**Performance score: 8/10** (in-container strong; hardware numbers outstanding).

### Documentation Review

**Consistency — high.** ADRs 001–013 form a coherent trail; the "Implementation
status" addenda bridge as-designed vs as-implemented. `16` (review package),
`17` (crypto implementation guide, for a future engineer), and `15` (completion
evidence) are new and cross-referenced. Activation is documented end-to-end
(`16` §17, `17` §10) and is deliberately a separate future PR.
**Gaps:** (a) the 004b vector-13 inconsistency is a documentation/vector defect
(B1) — the guide's §12 vector-generation process is correct but the committed
vector is not; (b) ADR-013's multi-device device-registration/fan-out is design
only (expected — gated on ratification); (c) no runbook yet for the observability
metrics an activated rollout needs. **Documentation score: 8.5/10.**

### Production Operations Review

**Deployment/flags — safe posture.** All flags OFF/absent (`ENFORCING=false`,
`SIGNING_PUBLICATION_ENABLED=false`, `spotme.e2e3` absent), fence-enforced.
Activation sequence + rollout checklist exist (`16` §17–18).
**Observability — a real gap.** No `/metrics` or `/health` wiring and no
metrics emission in `backend/src` (prom-client is a dead dependency); the
activation checklist calls for undecryptable/fallback/bound-hit counters that do
not yet exist. This does not block the *frozen* state but **must exist before
e2e_v3 is activated**.
**Disaster recovery — by-design constraint.** No key backup/recovery (ADR-008
§6, stated cost); storage loss is identity loss. Railway remains blocked.
**Operations score: 7.5/10** — safe to hold; observability is the pre-activation
gap.

---

## Consolidated findings so far (from the two completed crypto passes)

Full detail in `16` §21. Restated here in the board's classification:

| ID | Sev | Area | Blocks P1? | One-line |
|---|---|---|---|---|
| H1 | HIGH | backend (signing lifecycle) | **YES** | ≤1-active invariant not concurrency-safe; supersede reads active outside its txn; withdrawal clobberable |
| H2 | HIGH | backend (signing lifecycle) | **YES** | retirement keyed on base64 string not bytes → a retired key can return |
| B1 | HIGH (assurance) | vectors | fix before activation | conformance vector 13 mis-generated (illustrative HMAC form) + untested; `ratchet.js` itself correct |
| B2 | MED | ratchet | before activation | `decrypt()` throws raw non-`RatchetError` on two hostile-frame paths |
| B3 | MED | ratchet | before activation | non-string plaintext silently encrypted as empty |
| M1 | MED | tests | recommend | server P-256 supersession verify untested |
| M2 | MED | backend | no (hardening) | OPK pool has no depletion throttle |
| L1–L6, B4–B8, nits | LOW/INFO | various | no | see `16` §21 |

**Load-bearing fact carried into the verdict:** *no confidentiality or
forward-secrecy break was found.* The crypto core (four-DH X3DH, the ratchet KDF
ladder, constant-time comparisons, OPK single-use atomicity) verified correct
and oracle-conformant. The HIGH findings are a concurrency/identity-model bug in
the signing-key *backend lifecycle* and a mis-generated *negative vector* — real,
fixable, reachable only by an authenticated principal.

---

## Pending — reviewers 3, 4, 5 (fill on completion)

- Backend / Database / Reliability: *pending*
- Frontend / Storage / Networking: *pending*
- Testing / Security synthesis: *pending*

## Required outputs (assembled after all reviews)

1. Overall engineering score — *pending final synthesis*
2. Overall cryptography score — *pending*
3. Production-readiness score — *pending*
4. Maintainability score — *pending*
5. Risk register — *pending*
6. Remaining blockers — *H1, H2 confirmed so far; others pending*
7. Recommended improvements — *pending*
8. Documentation gaps — *B1 vector, observability runbook (so far)*
9. Missing tests — *concurrency (H1), base64 malleability (H2), P-256 verify (M1), vector-13 assertion (B1), + testing-reviewer list*
10. **Priority 1 verdict — PENDING** (one of APPROVED / APPROVED WITH FIXES / REJECTED)
