# ADR-012a — Bluetooth mesh threat model

**Status:** Threat model for the mesh **scaffolding** (Priority 2, PR D).
**Companion to:** `012-adaptive-communication-network.md`.
**Scope of the code today:** the routing logic in
`web/src/lib/transport-supervisor/mesh.js` (MeshFrame, seen-set/TTL/hopcount
bounded flooding) — **pure functions, no radio.** The native BLE transport is
Priority 10. This document sets the security frame the native work must satisfy
and states which properties the scaffolding already structurally guarantees.

---

## 1. The one load-bearing assumption

**Mesh relays are UNTRUSTED. They are other people's phones.** A frame may pass
through devices whose owners are curious, malicious, or compromised. Therefore
**confidentiality and integrity of message content rely ENTIRELY on the seal
(AES-GCM, end-to-end), never on the mesh.** The mesh is a dumb, hostile courier
that moves opaque bytes. This is why:

- the mesh layer only ever handles an **opaque `SealedEnvelope` payload** (INV-2);
- a relay **forwards ciphertext bit-identically** — only `hop` changes (INV-5);
- **no key ever reaches the transport/mesh layer** (INV-1).

Crucially, the seal itself (the **seal-lift**) is **DEFERRED** and gated on
Priority 1 activation (ADR-012 §7, ADR-008 §12). **Until the seal-lift lands, no
real message may traverse a mesh** — the scaffolding carries opaque test bytes
only, and the flag is off. This threat model therefore describes the *target*
security posture and the structural guarantees already in place, not a shipping
system.

## 2. Assets

1. **Message confidentiality** — plaintext of chats.
2. **Message integrity/authenticity** — no undetected tampering or forgery.
3. **Availability** — messages reach the peer when a path exists.
4. **Metadata privacy** — who is talking to whom, and physical presence/proximity.
5. **Device resources** — battery and bandwidth.

## 3. Adversaries

- **A1 Passive RF eavesdropper** — sniffs Bluetooth in radio range.
- **A2 Malicious relay** — a participating mesh node (dedup/forward path).
- **A3 Active injector/tamperer** — crafts or mutates frames.
- **A4 Flooding / DoS** — storms the mesh or replays to exhaust nodes.
- **A5 Traffic-analysis / tracker** — correlates frames, IDs, or radio presence
  to locations and social graphs.
- **A6 Battery-drain attacker** — keeps victims forwarding to drain them.

## 4. Threats, mitigations, residual risk

| # | Adversary | Threat | Mitigation (mechanism / invariant) | Status | Residual / deferred |
|---|---|---|---|---|---|
| T1 | A1/A2 | Read message content off the air or at a relay | End-to-end seal; relay sees only opaque ciphertext (INV-2); no key on transport (INV-1) | **Structural in scaffolding**; seal itself deferred | Content safe **only once seal-lift lands**; until then no real traffic on mesh |
| T2 | A3 | Tamper with a message in transit | AES-GCM authentication (post-seal-lift) + relays forward ciphertext bit-identically (INV-5) | Relay-preservation enforced now; AEAD deferred | Detection depends on the deferred seal/AEAD |
| T3 | A3 | Forge a message from another user | Sender authenticity from the signed identity / ratchet (P1) bound into the sealed envelope | **Deferred to P1** | No authenticity guarantee in scaffolding; do not ship traffic |
| T4 | A4 | Broadcast storm via re-forwarding | **Seen-set** (forward once) + **TTL/hopcount** (bounded hops); `receiveMeshFrame` drops duplicates and TTL-spent frames | **Implemented (pure)** | Seen-set is bounded+TTL → dedup is *eventual*, not perfect (accepted trade) |
| T5 | A4 | Replay old frames to resurface/confuse | envelopeId + dedup window; per-origin reorder buffer rejects at/behind high-water | **Implemented (pure)** | Beyond the window, replay re-enters; freshness ultimately from the ratchet (P1) |
| T6 | A3 | Loop/echo amplification | Origin-self frames are `deliver-only` (never re-forwarded); seen-set breaks cycles | **Implemented (pure)** | — |
| T7 | A5 | Map who-talks-to-whom / track by ID | envelopeId/frameId derive from ciphertext digest + routing only (INV-4), carry no account identity or plaintext | Partial (IDs are opaque) | **Radio-layer metadata (MAC, RSSI, timing, presence) is a native concern — DEFERRED to P10**; needs address randomisation, padding, cover traffic |
| T8 | A6/A4 | Drain battery by forced forwarding | TTL caps hops; seen-set caps repeat work; capability matrix rates BLE battery cost so the selector can prefer other links | Partial | Native rate-limiting / duty-cycling / peer caps **deferred to P10** |
| T9 | A2 | Selectively drop messages (censor) | Bounded flooding gives path diversity; store-and-forward outbox retries; adaptive layer can switch transports | Partial | Delivery is best-effort; no anti-censorship guarantee |
| T10 | A4 | Sybil / fake nodes inflate the mesh | — | **Deferred** | Admission/rate control is a native-layer design; out of scope for scaffolding |

## 5. What the scaffolding structurally guarantees today

Even with no radio and the flag off, the pure logic already makes these true and
tests them (`test/adaptive-mesh.test.js`, `test/adaptive-scaffold.test.js`):

- A relay **cannot alter ciphertext** without it being a *different* frame
  (INV-5; payload immutable, only `hop` advances).
- The mesh layer **cannot read** the payload — it is opaque (INV-2).
- **No key material** is reachable from any mesh/transport object (INV-1).
- Flooding **terminates**: duplicates are dropped and TTL bounds hops (T4/T6).
- Frame identifiers **leak no plaintext or identity** (INV-4).

## 6. Non-goals for the scaffolding

- No native radio, pairing, or background scanning (Priority 10).
- No anti-Sybil, no anonymity set, no cover traffic (native-layer design).
- No message authenticity/forward-secrecy — those are **Priority 1 crypto**, and
  the seal they depend on is deferred (ADR-008 §12).

## 7. Gate before any real traffic crosses a mesh

1. **Seal-lift implemented and reviewed** (AES-GCM seal/open above the transport)
   — gated on Priority 1 activation and rollback-after-publication (ADR-008 §12).
2. **Sender authenticity** (signed identity / ratchet) bound into the envelope.
3. **Native metadata hardening** (address randomisation, padding, duty-cycling).
4. The adaptive flag turned on in a separate wiring PR.

Until all four hold, `ADAPTIVE_TRANSPORT_ENABLED` stays **false** and the mesh
carries opaque test bytes only.
