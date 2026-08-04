# ADR-012 — Adaptive Communication Network (first-class platform)

**Status:** Proposed — **PLANNING ONLY** (owner directive 2026-08-01; the
transport-work hold stands for implementation). **Depends on:** ADR-002 (the
transport abstraction and its one hard rule), the shipped `ITransportAdapter`
seam.

## Context — the seam exists; the adaptivity does not

The web app already has: Socket.IO as the primary transport; an
`ITransportAdapter` seam with **Centrifugo** and **P2P** implementations
behind opt-in flags; replay/reconnect/cursor logic that is
regression-tested; and ADR-002's non-negotiable — **key material never
crosses the adapter**: a transport moves ciphertext envelopes and knows
nothing about their contents. A BLE proximity scanner exists
(device-unproven) on the discovery side; the native track carries a
Bluetooth ambition. What does not exist: any automatic selection between
transports, offline queueing across transport changes, or Bluetooth as a
*messaging* path.

## Decision (design; implementation is separately scheduled by the owner)

### 1. The user never chooses a transport

The owner's rule, verbatim, as the design's first constraint: **"Users must
never manually choose transport."** There is no transport menu, no mode
toggle. The UI may *state* the current reality ("offline — nearby delivery
active") because honesty is not a choice; it never asks.

### 2. The transport set

| Transport | Role |
|---|---|
| Socket.IO | primary internet transport (today's default, unchanged) |
| Centrifugo | alternative internet transport behind the same adapter (already built, flag-gated) |
| P2P (WebRTC data) | direct path when both ends are reachable; serverless fallback when the server is not |
| **Native Bluetooth** | OFFLINE MESSAGING — nearby delivery with no infrastructure at all; native-app capability (Capacitor), envelope-only like every other adapter |
| Wi-Fi Direct | future work, same adapter contract |
| Mesh (multi-hop) | future work; store-and-forward across nearby devices — explicitly out of MVP scope because relay-node trust and retention need their own ADR |

### 3. Automatic selection

A transport supervisor owns a priority/health table: each adapter reports
reachability (probe/heartbeat), and the supervisor routes sends to the best
healthy transport — internet transports first, P2P when advantageous or when
the server is unreachable, Bluetooth when there is no route out but a peer is
in range. Switching is hysteresis-damped (no flapping on a flaky link), and
in-flight sends complete or re-queue — never silently drop. Selection inputs
are health, latency class, and battery class; never user choice.

### 4. Offline synchronization

One durable outbound queue ABOVE the adapter layer (the existing
send-retry/replay machinery is the seed): messages queue with their room
cursor, drain over whichever transport comes healthy, and the existing
replay/cursor logic reconciles duplicates — dedup by envelope id is already
how `store.add` behaves. A message handed to Bluetooth and later also
delivered via server must land exactly once; the cursor rules already
guarantee this for reconnects and extend to transport switches.

### 5. Security invariants (unchanged, restated as gates)

- **Key material never crosses the adapter** (ADR-002) — Bluetooth and mesh
  included: an offline peer exchange moves the same E2E envelopes the server
  would, or it moves nothing.
- Identity/trust rules (ADR-005/006/007) are transport-independent: a
  Changed/Revoked peer is blocked identically on every transport — the A5
  gate sits above the adapter, so no transport can bypass enforcement.
- Bluetooth adds a physical-proximity metadata surface (who was near whom);
  the discovery privacy gates (V2 P8's threat-model requirement) apply
  before any offline-messaging rollout.

### 6. Evidence before adoption

Per V2 §8: each transport's switch-in/switch-out is benchmarked (time to
detect failure, time to first delivery on the new transport), the
no-message-loss property is regression-tested across forced switches, and
the manual device matrix covers real-radio Bluetooth (emulators cannot).

## Non-goals

No relay/mesh trust model in this ADR (own ADR when scheduled). No
Redis/Dragonfly horizontal-scale decision (explicitly not lifted — that
remainder of P3 stays blocked). No change to what a transport may see.

## Rollback / activation

Adapter-by-adapter flags (the pattern already shipped for Centrifugo/P2P);
the supervisor itself ships dark behind a flag, with Socket.IO-only as the
permanent fallback configuration. Rollback = flags off = exactly today's
behaviour; the queue drains over the primary.
