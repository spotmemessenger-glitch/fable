# ADR-012 — Adaptive Communication Network (transport supervisor + Bluetooth mesh)

**Status:** Planning + **SCAFFOLDING LANDED** (Priority 2, PR D). The scaffolding
under `web/src/lib/transport-supervisor/` is real, tested, and additive; it is
**flag-gated OFF (`ADAPTIVE_TRANSPORT_ENABLED = false`) and wired into nothing.**
The **seal-lift is DEFINED as an interface boundary only and is NOT implemented**
(see §7). No cryptographic behaviour changes in this PR.
**Date:** 2026-08-02 · **Priority:** 2 · **Follows:** ADR-002 (transport
abstraction), ADR-001 (V-19 key-provider fix), ADR-008 (signing-key storage /
§12 hard stop). **Companion:** `012a-bluetooth-mesh-threat-model.md`.

Aligned with the controlling roadmap (`MASTER-ENGINEERING-ROADMAP-V2.md`): the
adaptive communication layer is item ④ of the owner execution order and is
elevated to flagship. "AI Communication ADRs may proceed as planning"; this ADR
does exactly that and additionally lands the non-crypto, non-wired scaffolding.

---

## 1. Context — the problem the user should never see

Spot Me runs on Socket.IO today, with a legacy Trystero P2P escape hatch and an
opt-in (undeployed) Centrifugo adapter. ADR-002 already built the seam that
decides *which* transport a room uses in one place (`transport/room.js`,
`transport/select.js`). What does **not** exist:

- **Automatic switching.** The device is pinned to one transport by a
  `localStorage` flag a human sets. The roadmap's requirement is the opposite —
  *"users never pick a transport"*: the app should move between Socket.IO, a
  faster path, a relay, and **native offline Bluetooth** on its own, on quality,
  availability, cost, and battery.
- **Any offline path.** `views/bluetooth.js` is honest that today's "Bluetooth"
  scan finds Spot Me users *over the internet lobby*, and that true offline
  Bluetooth chat "arrives with the native app." There is no mesh.

## 2. The constraint that shapes everything — the seal boundary

`transport/room.js` documents, and `test/transport-seam.test.js` pins, the single
most important fact here: **AES-GCM seal/open currently live INSIDE
`socket-transport.js`, BELOW the transport.** Socket.IO seals under the adapter
(fine); a keyless adapter (Centrifugo) has *no* seal step, so routing chat
through it would put **plaintext** on the wire — the V-19 failure. Hence the seam
falls back to Socket.IO loudly rather than hand a room to a keyless transport.

An adaptive layer that may hand a room to **any** transport — including a
Bluetooth mesh whose relays are strangers' phones — cannot exist safely while
sealing lives below the transport. Reconciling that (ADR-002 §2 says adapters
carry opaque bytes and sealing happens *above* them) is the **seal-lift**. It is
crypto-adjacent and is **deferred** (§7).

## 3. Decision

Build the adaptive communication layer **scaffolding-first**: land the pure logic
and the typed boundaries now, behind an off flag, wired into nothing, with the
crypto relocation explicitly deferred and encoded as a test. This lets the design
be reviewed and the mechanics be proven without touching Priority 1, the live
message path, or any key.

Delivered in `web/src/lib/transport-supervisor/` (generalising — **not
modifying** — `transport/room.js`, `transport/ITransportAdapter.js`, `reach.js`):

| Module | Role |
|---|---|
| `ITransport.js` | Generalised transport contract: `connect/disconnect/send/receive/quality/costSignal/capabilities/status`. Inherits ADR-002's `FORBIDDEN_KEY_SURFACE` unchanged (INV-1). |
| `capabilities.js` | The **capability matrix** as data — range / needsInternet / offline / bandwidth / latency / battery / maxPayload — one row per candidate transport. |
| `registry.js` | Transport **registry** (factory; nothing registered at load — registration is wiring). |
| `selection.js` | **Scoring** (weighted, hard-constraint-gated) + **hysteresis** (margin / dwell / stickiness) to prevent flapping. Pure; `now` injected. |
| `envelope.js` | **SealedEnvelope** (opaque ciphertext) + **envelopeId** + bounded **dedup** window. |
| `ordering.js` | The **3-tier OrderingToken** (serverSeq → ratchetPos → senderClock), `compareTokens`, and a per-origin reorder buffer. |
| `mesh.js` | **MeshFrame** + **seen-set / TTL / hopcount** bounded-flooding, as **pure functions — no native BLE**. |
| `outbox.js` | Store-and-forward **outbox interface** generalising `reach.js`'s durable outbox, with an in-memory reference impl. |
| `invariants.js` | The **six encryption invariants** (INV-1..6) as executable predicates. |
| `seal-boundary.js` | The **seal-lift boundary — DEFINED, DEFERRED, throwing** (§7). |
| `index.js` | Barrel + the **flag** (`ADAPTIVE_TRANSPORT_ENABLED = false`). |

## 4. Selection: scoring + hysteresis

`scoreCandidate(candidate, context, weights)` returns a score in `[0,1]`, or
`null` when a **hard constraint disqualifies** the transport outright — no
internet for an internet-only link, no offline capability when offline is
required, a payload larger than the frame limit, or a link reporting *not
connected*. A disqualified transport scores `null`, never a low number, so it can
never win by weight. The soft score is a weighted sum over normalised axes
(latency, reliability, bandwidth, battery, cost, reachability); weights are
normalised on use.

`createSelector({ margin, dwellMs, stickiness })` applies **hysteresis** so the
best-score flickering does not thrash the connection: a challenger must clear the
incumbent's score by `margin`, the incumbent is protected for `dwellMs` after a
switch, and a `stickiness` bonus biases toward staying. **One override:** a
**disqualified incumbent** (its link died / lost internet) switches immediately —
availability beats flap-avoidance. Tested in `test/adaptive-selection.test.js`.

## 5. Envelope dedup + 3-tier ordering

Once a message can arrive over several paths (a flooding mesh, a replaying relay,
a reconnect), the same sealed bytes arrive more than once and out of order.

- **envelopeId** is derived from routing metadata + a **digest of the
  already-sealed ciphertext** (INV-4) — not a MAC, and proving nothing about
  authenticity (the seal does that). A bounded **dedup window** drops copies.
- The **OrderingToken** carries three tiers, authoritative first: `serverSeq`
  (server-stamped, global — the truth online), `ratchetPos` (Double Ratchet
  message number — the truth once P1 crypto is active, *the ratchet itself is
  deferred to P1; the token only reserves the slot*), and `senderClock`
  (per-sender Lamport counter — always present, so there is always *some* order,
  even mesh-only). `compareTokens` uses the highest tier **both** tokens carry.

Tested in `test/adaptive-envelope.test.js`.

## 6. Bluetooth mesh: bounded flooding (pure logic only)

A routing-table-free mesh floods; unbounded, that is a broadcast storm. Two
bounds tame it and are implemented here as **pure predicates over a frame and
local state**, with **no radio**:

- a **seen-set** (bounded + TTL-expiring) so a node forwards a frame at most
  once — this is what kills the storm; and
- a **TTL / hopcount** so a frame dies after a fixed number of hops.

`receiveMeshFrame(frame, { seen, selfId, now })` returns
`deliver-and-forward` / `deliver-only` / `drop-duplicate` / `drop-invalid`. A
relay **forwards ciphertext bit-identically** (INV-5) — only `hop` changes.
Tested in `test/adaptive-mesh.test.js`. The radio is Priority 10 (native app);
the trust analysis is in the companion threat model.

## 7. The seal-lift is DEFERRED (interface boundary only)

**This PR does not move any crypto.** `seal-boundary.js` gives the seal-lift a
name and a shape and nothing else:

- **What it would do:** move AES-GCM seal/open **above** the transport so every
  transport (Socket.IO, Centrifugo, BLE mesh) receives an already-sealed
  `SealedEnvelope` and can be keyless. That is the precondition for the selector
  to hand a room to the mesh without leaking plaintext.
- **Why deferred:** it is **crypto-adjacent** (it relocates the AES-GCM seal); it
  is a **real message-layer refactor**, not wiring (`room.js` §1 — `createNet`
  needs per-type channels, binary sends with progress, request/response, live
  streams the narrow contract does not model); and it is **gated on Priority 1
  activation** and the **ADR-008 §12 hard stop** (no signing-key
  generation/persistence/publication, prekeys, X3DH, ratchet, or multi-device
  until rollback-after-publication is executable or separately authorised).
- **How the deferral is enforced:** `createDeferredSealer()` returns an object
  whose `seal()`/`open()` **throw**; `SEAL_LIFT_STATUS.implemented === false`;
  and `assertSealLiftNotImplemented()` is asserted in the tests. Encoding the
  deferral as an executable check is what stops it drifting into existence.

## 8. The six encryption invariants (INV-1..6)

Expressed as predicates in `invariants.js`, asserted in
`test/adaptive-scaffold.test.js`. They constrain the scaffolding's shape so that
when the seal-lift is eventually done *above* the transport, the pieces it sits
on already refuse to leak.

| ID | Invariant | Enforced by |
|---|---|---|
| **INV-1** | Keys never cross the transport boundary | `assertNoKeySurface` (ADR-002 `FORBIDDEN_KEY_SURFACE`) |
| **INV-2** | Payload opacity — envelopes carry opaque ciphertext, no cleartext field | `assertOpaquePayload` |
| **INV-3** | The supervisor never seals or opens | `assertNoSealSurface` |
| **INV-4** | Identifiers derive from opaque inputs only (routing + ciphertext digest) | `assertIdInputsOpaque` |
| **INV-5** | Relays preserve ciphertext bit-identically (only hop changes) | `assertRelayPreservesCiphertext` |
| **INV-6** | No transport carries an unsealed message; keyless transports are disqualified, not fed plaintext | `assertSealedBeforeSend` |

## 9. IMPLEMENTED (scaffolding) vs DEFERRED

**IMPLEMENTED now (pure logic, tested, flag-off, not wired):**
- `ITransport` contract + key-surface prohibition; capability matrix; registry.
- Selection scoring + hysteresis (margin / dwell / stickiness).
- SealedEnvelope + envelopeId + bounded dedup.
- 3-tier OrderingToken + compareTokens + per-origin reorder buffer.
- MeshFrame + seen-set / TTL / hopcount bounded-flooding (pure functions).
- Store-and-forward outbox interface + in-memory reference impl.
- The six invariants as executable predicates.
- The seal-lift **interface boundary** (defined, throwing) + its deferral test.

**DEFERRED (explicitly NOT in this PR):**
- **Seal-lift** — moving AES-GCM seal/open above the transport. **Gated on
  Priority 1 activation + rollback-after-publication executable (ADR-008 §12).**
- **Native BLE radio** — GATT/L2CAP, background scanning, pairing. **Priority 10
  (native app).** The web layer cannot open the radio (`views/bluetooth.js`).
- **Real `ITransport` implementations** — adapting Socket.IO/Centrifugo/WebRTC to
  the generalised contract. Part of wiring.
- **Wiring** — registering transports, driving live selection, switching a live
  room. Turning the flag on. A separate, later PR.
- **`ratchetPos`** — the Double Ratchet position tier is reserved in the token
  but not computed; the ratchet is P1 crypto.

## 10. Rollback

The scaffolding is additive and inert, so rollback is deletion with **no data
migration, no crypto change, and zero Priority 1 impact**:

1. `git revert` the PR-D commit (single commit on `feat/adaptive-transport-scaffold`), **or** manually:
   - delete `web/src/lib/transport-supervisor/`,
   - delete `web/test/adaptive-selection.test.js`, `adaptive-mesh.test.js`, `adaptive-envelope.test.js`, `adaptive-scaffold.test.js`,
   - remove those four `&& node test/adaptive-*.test.js` invocations from `web/package.json`,
   - delete this ADR and `012a-bluetooth-mesh-threat-model.md`.
2. Nothing imports the supervisor, so no call sites change and the app bundle is unaffected (the modules are tree-shaken out — the production build transforms them into no chunk).
3. The flag is already off; there is no runtime state, feature, or stored data to unwind.

**Reversibility precondition for the DEFERRED seal-lift** (not this PR): per
ADR-008 §12 it may not proceed until rollback-*after-publication* is executable.
That gate is unchanged and unmet here.

## 11. Benchmark plan

Measured later against real transports; targets defined now so wiring has an
acceptance bar. Pure-logic items are measurable today.

| Area | Metric | Method | Target (initial) |
|---|---|---|---|
| Selection cost | wall-time per `choose()` over N candidates | micro-bench, `web/test/bench/` | < 1 ms for N ≤ 8 (pure, no I/O) |
| Anti-flap | switches per minute under a noisy quality trace within `margin` | synthetic trace into `createSelector` | **0** spurious switches within margin+stickiness |
| Failover | time to leave a disqualified incumbent | injected disqualification | immediate (≤ one decision tick; dwell overridden) |
| Mesh convergence | delivery ratio vs hop count / node count | simulated topology over `receiveMeshFrame` | ≥ 0.95 delivery at ≤ TTL hops; forwards bounded by seen-set |
| Dedup | duplicate-suppression rate; window memory | replay stream into `createDedupWindow` | 100 % within window; bounded memory at `capacity` |
| Ordering | out-of-order release correctness/latency | shuffled per-origin streams | in-order release; gap held until filled |
| BLE end-to-end | proximity chat latency, battery drain/min | **native app (P10)**; deferred | set at native bring-up; battery within matrix estimate |

## 12. Consequences

- **Positive:** the flagship design is reviewable and its mechanics proven with
  72 new pure-logic tests, at zero risk to P1, the live path, or crypto. The
  seal-lift's deferral is now a *test*, not a hope. The full suite stays green.
- **Negative / debt:** the value is latent until the seal-lift and wiring land;
  the capability-matrix numbers are illustrative until benchmarked; `ratchetPos`
  is a reserved slot dependent on P1.
- **Watch:** the seam's plaintext guard (`transport-seam.test.js`) remains the
  tripwire — if anyone adds sealing to a keyless adapter or points the chat path
  at one, that test must fail first.

## 13. References

- ADR-002 (transport abstraction; `FORBIDDEN_KEY_SURFACE`), ADR-001 (V-19),
  ADR-008 §12 (hard stop), ADR-004 series (ratchet integration).
- `transport/room.js`, `transport/ITransportAdapter.js`, `reach.js`,
  `views/bluetooth.js` (generalised, not modified).
- `MASTER-ENGINEERING-ROADMAP-V2.md` (owner execution order ④; AI-provider
  principle: route/fall back on quality, availability, cost, response time).
- Companion: `012a-bluetooth-mesh-threat-model.md`.
