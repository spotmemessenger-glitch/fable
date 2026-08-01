# ADR-013 — Multi-device (Priority 1, Phase 5)

**Status:** Proposed — the device layer is designed and the recommended safety-
number construction is IMPLEMENTED behind the flag (`device-set.js`), but
**the safety-number construction requires the owner's explicit ratification
before multi-device is activated** (ADR-008 §BLOCKING: "decided before
multi-device is implemented, not during"). **Depends on:** ADR-004 (X3DH +
ratchet, Phases 3–4), ADR-006 (signing identity), ADR-008 (signing-key
storage + the §BLOCKING question).

## The one decision that gates this phase — OWNER RATIFICATION REQUIRED

A safety number derived from ONE device's key cannot honestly represent an
account that has a device *set* (ADR-008 §BLOCKING). The four candidate
constructions, restated with a recommendation:

| # | Construction | Verdict |
|---|---|---|
| 1 | One device-to-device key (today, `safety-number.js` v0.0) | Honest only at one device. **Kept and coexists**, does not scale. |
| 2 | A user identity key + an authenticated device set | Needs an account-level key that can be transferred/escrowed — **ruled out by ADR-008 §6** (no key backup, no recovery). |
| **3** | **A hash commitment to the active device set** | **RECOMMENDED.** The number is over a canonical commitment to every device's signing key; adding/removing a device changes it, so a device change is a *visible verification event* for every contact — the honest property, at the cost of a re-verify when the set changes. Simple; no new escrowable key. |
| 4 | Another explicitly versioned account construction | Open; nothing proposed beats #3's simplicity, and every added mechanism is added attack surface. |

**Recommendation: option 3.** It is implemented in `web/src/lib/crypto/
device-set.js` as `SAFETY_VERSION` 1 (`[0x00,0x01]`), coexisting with the
single-device v0.0 (ADR-006 coexistence: a payload carries its version, and a
scanner refuses a version it did not expect rather than comparing across
constructions). The implementation is a labeled PROPOSAL so the owner has
running, tested code to evaluate — it does not activate a device set, and
choosing option 4 (or amending 3) discards one pure module, nothing shipped.

**Until the owner ratifies a construction, multi-device stays gated.** The
rest of this ADR is design that a ratification unblocks.

## Device registration and the trusted device list

- **A device is** a 16-byte `deviceId` (already in the e2e_v3 header as
  SDEV/RDEV, 004a §4) bound to that device's **signing identity** (ADR-006/008)
  and its current agreement key + prekey bundle (Phase 3, already keyed by
  `deviceId`).
- **Registration** publishes the new device's signing key (the #39 lifecycle)
  and its prekey bundle (Phase 3). The account's trusted device list is the
  set of signing keys the user's other devices have accepted — which is the
  set the safety-number commitment (option 3) is computed over.
- **A device list has its own authenticity problem** (004a §9): the list must
  be authenticated to the account, or a malicious server adds a device the
  user never approved. Option 3 makes that tamper *visible* — an unapproved
  device changes every contact's safety number — but visibility is detection,
  not prevention; approval is the prevention.

## Device verification and revocation

- **Verification** is the existing QR / safety-number flow, computed over the
  device-set commitment (option 3) instead of a single key. The A1–A5 trust
  machine (Unverified·Pinned·Verified·Changed·Revoked) applies unchanged: a
  device-set change surfaces as `Changed` and requires re-verification, never
  a silent re-pin.
- **Revocation** reuses the signing-key lifecycle (#39): revoking a device is
  withdrawing its signing key, which removes it from the commitment and, again,
  changes the number. Revocation is not backup-recovery — a lost device's key
  is withdrawn, not restored (ADR-008 §6).

## Cross-device sync and fan-out

- **Fan-out encryption** (004a §9): one ciphertext per recipient DEVICE, N
  ratchet sessions per conversation — the SDEV/RDEV header fields exist for
  exactly this, and a frame whose RDEV is not this device is ignored quietly
  (004a §9) so adding a device does not spray alarms on old clients.
- **The device-added-mid-conversation problem has no forward-secrecy-preserving
  answer** (004a §9): re-encrypting history to a new device defeats the
  ratchet. The design decision is that a new device starts with NO history and
  the UI says so — history is not synced, which is a deliberate cost of forward
  secrecy, not a gap.

## Migration, tests, benchmarks

- **Additive.** Single-device accounts stay on v0.0 safety numbers and one
  session per conversation; nothing changes for them until they add a device.
- **Tests** (`test/device-set.test.js`, 10/10): commitment order-independence,
  add/remove/key-change all change the number, length-prefix collision
  resistance, the account-id binding, and version coexistence with v0.0. The
  honesty property — a peer adding a device changes the number both sides see —
  is asserted directly.
- **Benchmark** parity with `safety-number.js` (same iteration count) — the
  device-set number costs one extra SHA-512 for the commitment over the
  single-key version, negligible against the 5200-iteration fingerprint;
  computed off the render path and cached against the commitment.

## What is NOT built here, pending ratification

Device registration endpoints, fan-out session management, and the trusted-
device-list UI are held until the safety-number construction is ratified —
building them on an un-chosen commitment model is building on sand (the §BLOCKING
rule). This ADR + `device-set.js` is the ratifiable proposal; the rest follows
the owner's decision.

## Rollback

`device-set.js` is pure and unreferenced (fenced). Rollback before ratification
is deleting the module. After activation, the v0.0 construction still exists and
single-device accounts are unaffected; multi-device is flag-gated like every
other Phase.
