# ADR-025 — E2EE implementation: libsignal vs custom e2e_v3

**Status: PROPOSED — owner decision required.**
**Date:** 2026-08-03 · **Owner:** Spot Me owner · **Follows:** ADR-004 (+004a–d),
ADR-008 · **Governs:** the implementation choice behind PRs #39, #41, #42, #43.

> **This ADR does not unlock or advance the crypto train.** The ADR-008 §12
> hard stop is untouched: no signing-key generation/publication, prekeys, X3DH,
> ratchet, or multi-device activation may begin until rollback-after-publication
> is executable or separately authorised. ADR-025 decides only *which
> implementation* the (still-gated) train uses.

## Context

Spot Me needs forward secrecy for 1:1 chat. Today, on `master@069905e`, messaging
uses **static-pair ECDH (e2e_v2)**: one stolen device key opens that pair's
entire history — no forward secrecy, no break-in recovery, no async setup
[repo-verified: `ADR-004 §1`]. A full forward-secret stack (X3DH + Double Ratchet
+ multi-device) is **built and dark** across draft PRs #41/#42/#43, behind the
`e2e_v3` / `spotme.e2e3` rollout flag, fence-tested as not-wired-in
[repo-verified: `feat/*` branches; `web/test/e2e-v3-not-shipped.test.js`].

**ADR-004 (merged) already chose to own the ratchet integration on WebCrypto**
and rejected libsignal on licence grounds [repo-verified: `ADR-004 §3/§4`,
`ADR-004c Q5`]. ADR-025 exists to (a) re-test that choice against **current**
(2026-08-03) evidence, since library licences and browser tooling move, and
(b) record the decision as a standalone, comparative ADR the owner can ratify —
distinct from ADR-004, which bundled it with the forward-secrecy design.

The decision hinges on one structural constraint, not a feature list:

> **A WASM crypto library cannot use a non-extractable `CryptoKey`.** Spot Me's
> identity key is generated `extractable: false` (ADR-001) — the private key is
> a handle the page can compute with but *cannot serialise*, so no XSS, bug, or
> malicious build can exfiltrate it. Any WASM library operates on bytes in linear
> memory and therefore requires an extractable key. **Adopting a WASM ratchet
> trades a security property we have for one we want.** [repo-verified:
> `ADR-004 §2`; the non-extractable property is a real WebCrypto guarantee.]

## Alternatives Considered

Three options, scored per criterion. Evidence labelled `[repo-verified]`,
`[web-sourced + date]`, or `[judgment]`.

| Criterion | ADOPT libsignal | KEEP custom e2e_v3 | HYBRID (keep now, dated re-eval) |
|---|---|---|---|
| **Licence risk** | **Disqualifying.** libsignal is **AGPL-3.0** [web-sourced 2026-08-03: `signalapp/libsignal/blob/main/LICENSE` = AGPL-3.0; still Signal-owned], which the owner **excluded** [repo-verified: `ADR-004 §opening`, "no AGPL"]. | None — Spot Me code, no third-party copyleft. | None — same custom code now; any future adopt-path is licence-gated at the trigger. |
| **Browser feasibility** | **No official browser path.** libsignal's only JS binding is a **native Node add-on; there is no official WASM build** [web-sourced 2026-08-03: `signalapp/libsignal` README — bindings are Rust/Java/Swift/TypeScript-Node; no WASM]. README: **"Use outside of Signal is unsupported"** and APIs "subject to change without notice" [web-sourced 2026-08-03, same README]. | **Native.** X25519, HKDF-SHA256, AES-GCM, Ed25519 are all WebCrypto; Ed25519 verified generating in-runtime [repo-verified: `ADR-004 §4.3`]. Runs where the app runs. | Custom now (native). A future adopt-path would be an MLS/Rust-WASM stack (see below), evaluated at the trigger. |
| **Conformance / test quality of the path** | Reference-grade (it *is* the reference) — but unreachable in-browser. | **Strong for hand-rolled.** `ratchet.js` (402 lines) is proven against the **004b conformance vectors from a pinned Syndace oracle**, two-tier (deterministic-inject + live-agreement); `x3dh.js` (202 lines) against reproducible 004a vectors; both dark + fence-tested; benchmarks present [repo-verified: `web/test/ratchet.test.js:2–33`, `x3dh.test.js:2`, `e2e-v3-not-shipped.test.js`, `test/bench/*`]. | Inherits the custom path's test quality now. |
| **Coexistence with deployed e2e_v2** | n/a (not adoptable). | **Additive, versioned:** rooms are `e2e_v1`/`v2`/`v3`, decided at creation, never migrated; v3 attempted only when the flag is on and both sides publish a bundle, else visible fallback to v2 [repo-verified: `ADR-004 §6`]. | Same. |
| **Multi-device** | Signal uses **Sesame**. | #43 implements **per-device fan-out** (one ciphertext per recipient device, N sessions) with device-set safety numbers — Sesame-shaped, additive; single-device accounts unaffected [repo-verified: `feat/multi-device` `ADR-013 §Cross-device`]. The **safety-number-under-multi-device** question is still open [repo-verified: `ADR-008 §BLOCKING`]. | Same #43 model; a future MLS adopt-path would change the group story specifically. |
| **Long-term audit & maintenance burden** | Signal-maintained + audited — but only for Signal's own consumers [web-sourced 2026-08-03]. | **We own it forever.** Hand-rolled ratchets are the classic way to ship crypto that *looks* correct; mitigated here by oracle vectors, fuzzing, skipped-key bounds [repo-verified: `ADR-004 §4/§9`], but the burden is permanent [judgment]. | Caps the burden: own the audited 1:1 path now; re-evaluate a maintained, permissive, browser-viable library (OpenMLS/vodozemac-via-Rust-SDK) when groups force the question. |
| **Time-to-forward-secrecy for real users** | Effectively never in-browser (no WASM to adopt). | **Shortest.** The stack is built and dark; time-to-users = the G8 activation milestone under ADR-008 §12, not new construction [repo-verified: PRs #41/#42/#43]. | Same near-term path as KEEP. |

**Industry cross-check** [web-sourced 2026-08-03]: browser-based Matrix clients
get their Double Ratchet from **vodozemac compiled into the whole
`matrix-rust-sdk` WASM bundle** (matrix.org E2EE guide; `matrix-org/vodozemac`),
*not* from a standalone JS binding — and ADR-004 already found vodozemac's
**standalone** JS/WASM bindings declared unmaintained upstream
[repo-verified: `ADR-004 §3`]. So the only *maintained* browser route to a Rust
ratchet today is adopting an entire Rust-SDK-in-WASM, which forfeits the
non-extractable key and adds a Rust/wasm toolchain — the same trade ADR-004
priced. No major **browser-first** product adopts **libsignal** in-browser,
because there is no official WASM to adopt [judgment, consistent with the README
evidence above].

## Decision

**Primary recommendation: HYBRID — keep the audited custom `e2e_v3` path as the
1:1 forward-secrecy implementation now, and set a dated re-evaluation trigger
for an MLS-based (OpenMLS or vodozemac-via-Rust-SDK) path scoped to *group*
encryption and long-term maintenance de-risk.**

HYBRID, not bare KEEP, because two things are simultaneously true: the custom
1:1 decision is sound and already built (so relitigating it wastes shipped,
oracle-tested work), *and* Spot Me has **not solved group encryption**, which is
exactly where MLS leads and where owning a hand-rolled protocol is least
defensible [repo-verified: `ADR-004 §3 (OpenMLS "worth revisiting for groups")`,
`§10`; `ADR-004c Q5 (multi-device fan-out "not designed")`]. HYBRID commits to
the shortest safe path to forward secrecy for users while naming, with a date,
the condition under which the library question reopens — rather than pretending
"own it forever" answers the group problem it does not address.

The evidence is **sufficient to recommend** (no deferral): the two disqualifiers
for ADOPT — AGPL licence and absence of an official browser build — are
verified against upstream today, and the custom path's conformance testing is
verified in the repository.

**Why ADOPT libsignal is not recommended.** It fails on three independent,
each-sufficient grounds, all current: (1) it is **AGPL-3.0**, which the owner
excluded; (2) it has **no official WebAssembly/browser binding** — the only JS
binding is a native Node add-on, unusable in Spot Me's browser client; (3)
upstream **explicitly does not support use outside Signal** and reserves the
right to break APIs without notice. Any *other* in-browser library path (a
Rust-SDK-in-WASM carrying vodozemac/MLS) additionally forfeits the
non-extractable identity key and imports a Rust/wasm toolchain — the trade
ADR-004 already rejected for 1:1. ADOPT is therefore rejected for the near term
and is only reconsidered under HYBRID's trigger, for groups.

**Why bare KEEP is not the primary framing.** KEEP is correct for what exists
(1:1) and HYBRID *is* KEEP for the near term — the custom path ships unchanged.
But recording the decision as unconditional "keep forever" would bury the one
place the analysis genuinely points elsewhere: group encryption, unsolved, where
MLS is the RFC-backed direction and a hand-rolled group ratchet would be the
riskiest code in the product. HYBRID keeps the near-term custom decision *and*
schedules that question instead of hiding it.

## Consequences

### If HYBRID is ratified (recommended)
- **Near term = KEEP:** the first implementation mission is the **G8 activation
  milestone for #39 → #41 → #42 → #43** — which remains **gated by ADR-008 §12**
  (executable rollback rehearsed) and by the open multi-device safety-number
  question (`ADR-008 §BLOCKING`), and requires explicit owner authorisation.
  Nothing here changes that gate.
- **A dated re-evaluation trigger** is recorded: **re-open the library question
  when Spot Me commits to group encryption, or by 2027-08-03 (12 months),
  whichever is first.** The bounded next action at the trigger is a **time-boxed
  (≤1 week) browser-feasibility spike**: build OpenMLS (or `matrix-rust-sdk`
  crypto) to WASM, measure bundle size, cold-start, per-message cost, IndexedDB
  key-storage fit, and confirm whether the non-extractable-key loss can be
  contained (e.g. a WebCrypto-wrapped key store) — a *spike*, not a migration,
  and never touching the shipping 1:1 path.
- Long-term maintenance burden is explicitly time-boxed rather than accepted
  forever.

### If bare KEEP is ratified instead
- Identical near-term path (the same G8 activation milestone, same gates), but
  **no scheduled re-evaluation** — the group-encryption/library question would
  need a fresh ADR when it arises. Acceptable, but loses the calendar commitment.

### If ADOPT is ratified (not recommended)
- The train (#41/#42/#43) would be **discarded or rewritten**, and **no code may
  touch it until a bounded browser-feasibility spike proves a licence-clean,
  browser-viable library exists** — which today's evidence says it does not
  (AGPL + no WASM). This path most likely ends in "ship nothing / defer forward
  secrecy," the honest alternative ADR-004 names [repo-verified: `ADR-004 §4`].

## Related

- **PRs:** #39 (signing-key publication + executable rollback, ADR-008 Phase 2B —
  the §12 unlock), #41 (X3DH + prekeys), #42 (Double Ratchet), #43 (multi-device
  + ADR-013). All dark/fence-tested; all gated.
- **ADRs:** ADR-004 (+004a envelope, 004b vectors, 004c decision record, 004d
  seams) — the forward-secrecy design this implements; **ADR-008 §12** — the
  untouched hard stop; ADR-001 (non-extractable identity key); ADR-003
  (safety-number authentication).
- **Pending index entries (do not edit shared files in this PR):** add ADR-025
  to `spotme/docs/adr/README.md`, and reference it from
  `spotme/docs/handbook/DECISIONS.md` item 1 and
  `03-IMPLEMENTATION-STATUS` (crypto rows), **once the #62–#65 docs stack
  merges** — noted here rather than committed, per this mission's limits.
