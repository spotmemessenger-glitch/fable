# 08 — Security & Privacy

> Detail: `spotme/docs/07-SECURITY-PLAN.md`, `spotme/docs/adr/` (ADR-001…008),
> and the backfilled ADRs 018/019. Verified against `master` `31e1894`,
> 2026-08-03.

## Identity & messaging security (merged)

- **No account, no password, no phone number.** Identity is device-generated
  (`core/identity.js`, `web/src/lib/crypto/`).
- **Safety numbers** for out-of-band verification (#12/#14); a scanned number is
  **bound before it is believed** (A4, #26); a changed peer key is **proposed,
  never silently adopted** (A2+A3, #25).
- **Identity trust state machine** with persistence (A1, #24) and a signing
  identity that proves possession via bindings (A7, #29).
- **Send enforcement** is computed always but **shipped switched off** (A5, #31)
  — the verdict exists and is tested before it ever gates a send.
- **Signing-key storage** is merged **dark** (ADR-008 Phase 2, #36).

### The ADR-008 §12 hard stop (binding)

**No signing-key generation, persistence-for-publication, publication, prekeys,
X3DH, ratchet, or multi-device** until rollback-after-publication is executable
or separately authorised. PR #39 (publication + rollback) and the crypto stack
#41/#42/#43 sit behind this gate. Do not cross it without explicit owner
authorisation. (See [03-IMPLEMENTATION-STATUS](03-IMPLEMENTATION-STATUS.md) →
Deferred.)

## Location privacy

**Honesty pillar applied to location.** Positions are shown as approximate
("~24 m", never exact); ghost mode withholds position entirely.

- **On `master` today, the Discovery v1 lobby still broadcasts precise GPS** in
  public presence (`web/src/lib/discovery.js`). This is a known privacy defect.
- **The fix is in draft PR #60** (Discovery V2): precise GPS is kept
  **device-local** (distance/centring/radius only); the public position is an
  **on-device approximation** — snapped to a ~500 m privacy cell with a rotating
  bounded offset, deterministic and testable. See **ADR-018** (deterministic
  location grid) and **ADR-019** (Discovery V2 privacy model). This is **not yet
  on master** — do not describe the defect as fixed until #60 merges.

## Secrets & configuration

- **Never commit secrets.** Fence tests assert no secret-shaped literals in dark
  foundations; provider adapters must keep credentials in closures/injected
  config, never as enumerable object fields (ADR-017).
- CI uses non-secret placeholder values (e.g. `JWT_ACCESS_SECRET=ci-…`) so it
  never exercises the hardcoded fallback recorded as finding **R5** in
  `spotme/docs/10-PRIORITY-0-AUDIT.md`.
- The vestigial Vercel `/api/*` functions had their vendor keys removed
  2026-07-31 (`09-TECH-STACK.md §1`).

## AI, privacy scope

- **AI is interface-only** across the platform — no LLM calls, no conversational
  assistant — until owner-authorised. AI interfaces must not infer sensitive
  traits and must carry **no personalization** (ADR-017 provider neutrality +
  the Discovery/Events ranking design: transparent weights, explainable).
- **Provider no-hard-dependency principle** (owner amendment 2026-08-01): every
  AI/provider feature optimises accuracy + latency + privacy simultaneously; no
  provider may become a hard dependency — route/fall back on quality,
  availability, cost, response time.
