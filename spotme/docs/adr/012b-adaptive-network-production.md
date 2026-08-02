# ADR-012b — Adaptive Communication Network: PRODUCTION implementation

**Status:** IMPLEMENTED and **DARK** (every flag false; wired into nothing).
**Date:** 2026-08-02 · **Priority:** 2D · **Extends:** ADR-012 (scaffolding) ·
**Companions:** `012a-bluetooth-mesh-threat-model.md`,
`docs/adaptive-network/` (architecture, threat-model update, security review,
benchmarks, rollback, activation, ops, checklist).
**Unchanged and still controlling:** ADR-008 §12 hard stop; the seal-lift is
**NOT implemented** — `seal-boundary.js` still throws and the suite asserts it.

---

## 1. What this ADR covers

ADR-012 landed the pure scaffolding (contracts, scoring+hysteresis, envelope/
ordering/mesh primitives, invariants, the deferred seal boundary). This ADR
records the **production layer built on top of it** — everything the adaptive
network needs to run, minus the two things that remain gated (seal-lift → P1;
radio peripheral/background → P10 native):

| Area | Modules (under `web/src/lib/transport-supervisor/`) |
|---|---|
| Flags (layered, all false) | `flags.js` |
| Deterministic time + bounded timeouts | `clock.js` |
| Estimation + prediction | `ewma.js` (EWMA, trend fit, degradation anticipation) |
| Battery awareness | `battery.js` (Battery API; conservative unknown default) |
| Health | `health-fsm.js` (unknown/healthy/degraded/down/unavailable) |
| Monitoring loop | `monitor.js` (passive-first sampling; throw-isolated) |
| QoS | `qos.js` (call-signal > message > receipt > telemetry) |
| Migration | `migration.js` (make-before-break; shared receive pipeline) |
| The engine | `supervisor.js` (ranking, hysteresis, prediction penalty, event log, INV-6 choke point) |
| Congestion | `congestion.js` (AIMD window; transient/persistent backoff classes) |
| Durable store-and-forward | `durable-outbox.js` (IndexedDB; wipe-path registered), `drain.js` |
| Mesh production | `mesh-ack.js` (end-to-end acks, capped retransmit), `mesh-peers.js` (discovery records, reputation, RSSI, duty cycle), `mesh-engine.js` |
| Real transports | `adapters/` — SocketIO, Centrifugo, WebRTC (perfect negotiation), LAN (host-candidate verification), BLE central (GATT client, chunking, reconnect) |
| The one factory | `network.js` (`createAdaptiveNetwork` — master flag off ⇒ inert stub, zero timers) |

## 2. Decisions

1. **Ship dark, layered.** Seven flags, all `false`, resolved through a parent
   tree (`resolveFlags`) so a sub-system can never be effective while its
   parent is off. The factory constructs **nothing** with the master off —
   proven by a test that injects a clock which throws on any timer call.
2. **The supervisor is a router of ciphertext.** `send()` asserts INV-6
   (sealed, opaque, no plaintext field) at the single choke point; every
   adapter re-asserts it at its own edge. No module in the layer can seal,
   open, or hold a key (INV-1/INV-3 asserted over every factory's product).
3. **Selection stays the scaffold's.** Scoring and hysteresis
   (margin/dwell/stickiness) are used as landed in ADR-012 — the anti-flap
   proof carries over. Production adds the inputs (EWMA-smoothed quality,
   health states, battery context) and one output modifier: a bounded
   **prediction penalty** for links whose latency/loss trend projects across
   a ceiling within the horizon, so switching begins before a dying link
   actually dies (verified by a two-run timing test: prediction switches
   strictly earlier than raw scores).
4. **Make-before-break, dedup-absorbed.** A switch connects and attaches the
   target before releasing the incumbent (grace window for stragglers),
   re-queues unacked in-flight envelopes by envelopeId, and lets the shared
   receive pipeline (dedup + per-origin reorder) guarantee exactly-once,
   in-order delivery across the switch. The BLE→LAN→relay continuity test is
   the G2 gate, executed.
5. **Ack-or-retry, never send-and-forget.** The outbox releases an envelope
   only on `acked()` (server seq or receipt) or TTL. Retries reuse the same
   envelopeId. Failures classify as transient (fast exponential backoff,
   jittered) or persistent (slow), and an AIMD window discovered from the
   link bounds every drain wave. Droppable classes (receipt/telemetry) shed
   at their caps; MESSAGE never sheds.
6. **The mesh is availability engineering, not trust.** End-to-end acks with
   capped retransmit; peer **reputation** is a delivery-success EWMA with a
   misbehaviour penalty that only orders *which neighbour to try first* —
   it never authenticates (see the threat-model update on reputation
   gaming). TTL-forgery and malformed frames are misbehaviour. Duty cycling
   maps battery bands to scan schedules with a receive-only floor.
7. **Web-platform honesty.** BLE is implemented **central-only** — the full
   GATT-client protocol (service model, chunking within the 512-byte write
   cap, reconnect with backoff, RSSI where `watchAdvertisements` exists) —
   and reports `unavailable` with a reason on iOS/Firefox. Peripheral/
   GATT-server role, background radio, Wi-Fi Direct and mDNS are **Priority
   10 native** and are documented, not faked. LAN is the WebRTC
   host-candidate path with post-connect verification that the selected
   candidate pair is host↔host.

## 3. What remains deferred, and its gates

| Deferred | Gate | Enforced by |
|---|---|---|
| **Seal-lift** (AES-GCM above the transport) | P1 activation + rollback-after-publication (ADR-008 §12) | `seal-boundary.js` throws; `assertSealLiftNotImplemented` in two suites |
| **Chat over NEW transports** (BLE/LAN/mesh/Centrifugo) | the seal-lift above | activation guide step 0; `transport-seam.test.js` unchanged |
| **BLE peripheral / GATT server / background scan** | P10 native app | `SPOTME_GATT` documents the service the native side implements |
| **Wi-Fi Direct / mDNS true-offline LAN** | P10 native app | `lan-transport.js` header; capabilities say `offline:false` |
| **Signed delivery receipts** | P1 identity/signing | `mesh-ack.js` reserves the slot; acks are availability-only today |
| **Wiring + flag flips** | separate activation PR (see activation guide) | fence test: nothing imports the supervisor |

## 4. Testing

Eight new suites (116 checks) appended to `npm test`; full suite green (1124
checks across the whole web suite);
`test/bench/adaptive-network.bench.mjs` prints environment + p50/p95/p99
(see `docs/adaptive-network/benchmark-report.md` for the recorded run).
Three real defects were found by the new tests during this build and fixed:
a drain-pass livelock on deferred items, a scheduler-overflow starvation of
large backlogs, and a mesh fan-out design flaw that would have muted nodes
under `MULTIHOP_ENABLED=false` (each is documented at its fix site).

## 5. The one existing-file edit

`web/src/lib/db.js` — one line + comment: `dropDatabase('spotme-adaptive-outbox')`
added to `wipeDevice()`'s demolition list. Justification: the durable outbox
holds sealed envelopes **plus routing metadata** (who this device talks to);
registering the name **now** means "Clear all data" already covers the store
on the first day any activation writes to it. While every flag is off the
database never exists and the delete is a no-op success — behaviourally
invisible, asserted by the unchanged `wipe-device.test.js` plus a new check.
(`web/package.json` also grew the new test invocations, as every PR's tests do.)

## 6. Rollback

`docs/adaptive-network/rollback-plan.md`. Summary: revert the PR-2D commits, or
delete `transport-supervisor/`'s production files + the eight suites + the
package.json invocations + the db.js line. No data migration (no data is ever
written while dark), no crypto change, zero P1 impact.
