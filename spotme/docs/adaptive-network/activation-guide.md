# Activation guide — turning the adaptive network ON (a FUTURE PR, not now)

Everything below describes work that is **not authorised by P2D**. This PR
ships dark. Activation is its own reviewed PR (or several), and its order is
fixed by the gates, not by preference.

## Step 0 — THE SEAL-LIFT GATE (hard, crypto, ADR-008 §12)

**No chat may activate over any NEW transport (BLE, LAN, mesh, Centrifugo)
until the seal-lift lands.** Today AES-GCM seal/open live INSIDE
`socket-transport.js`, below the transport; the supervisor therefore cannot
be handed sealed chat frames for new transports — `seal-boundary.js` throws,
`SEAL_LIFT_STATUS.implemented === false`, and two suites assert it stays so.

The seal-lift itself is gated on **Priority 1 activation and
rollback-after-publication being executable (ADR-008 §12)** and is a
message-layer refactor with owner sign-off (WS4 §8.2, §18.2). Until then the
ONLY transport that may carry supervisor envelopes is SocketIO, where the
existing room seal wraps them below (double-sealed, both layers opaque).

The mesh additionally keeps ADR-012a §7's full gate list: seal-lift →
sender authenticity → native metadata hardening → its own flag PR.

## Steps 1..n — the layered flag order (each its own review)

| Step | Flip | What starts running | Prerequisite |
|---|---|---|---|
| 1 | `TRANSPORT_SUPERVISOR_ENABLED` (+ master) | monitoring, health, ranking, event log — **shadow mode**: decisions logged, nothing migrates, nothing carries chat | wiring PR registers transports + calls `createAdaptiveNetwork` |
| 2 | `AUTO_TRANSPORT_ENABLED` | migrations execute between transports that carry supervisor envelopes (initially: SocketIO only ⇒ effectively no-op switching; real once ≥2 transports are chat-legal) | step 1 soak; event-log review shows sane rankings, zero flapping |
| 3 | `OFFLINE_MESSAGING_ENABLED` | durable outbox + drain (store-and-forward for supervisor envelopes) | step 1; wipe path already covers the store (shipped in P2D) |
| 4 | `LOCAL_NETWORK_ENABLED` | LAN transport becomes registerable | **seal-lift (step 0)** for chat frames |
| 5 | `BLUETOOTH_MESH_ENABLED` | BLE central + mesh engine (single-hop) | **seal-lift** + ADR-012a §7 gates + P10 native peer for web↔native pairs |
| 6 | `MULTIHOP_ENABLED` | relaying (fanout > 0) | step 5 soak + mesh-trust owner ruling (WS4 §18.1.3/4) |

Also flip in the same PR as step 1: the scaffold's `ADAPTIVE_TRANSPORT_ENABLED`
(index.js) — two independent offs, one documented on-path. Both are code
constants by design; there is no runtime override to flip.

## Wiring PR contents (step 1), sketched

1. Build `createAdaptiveNetwork({ flags, deliver, selfId, isOnline })` in one
   app-boot site; `deliver` feeds the room store the same way replay does.
2. Register transports: `createSocketIoTransport({ roomId, … })` per active
   room (Centrifugo may register — it will sit at UNAVAILABLE honestly).
3. Wire `drainer.kick()` to `online`/`visibilitychange`/socket-reconnect —
   the same resume triggers reach.js uses.
4. WebRTC/LAN signalling: create a room action (e.g. `sup-rtc`) via the
   PUBLIC `room.makeAction` seam and pass its send/onMessage pair as the
   adapter's `signal`. No existing file changes.
5. BLE: `connect()` must be called from a user gesture (requestDevice spec);
   the Bluetooth screen's existing tap is the natural site. Do NOT modify
   `views/bluetooth.js` for shadow mode — a new flag-gated screen section
   arrives with step 5's own PR.
6. Update the fence test in the SAME PR: the "nothing imports the
   supervisor" check must be consciously replaced by "only the wiring site
   imports it" — the fence failing IS the review trigger, by design.

## Verification per step

- `npm test` green (the fence change is explicit, everything else stays).
- Event log inspection: `network.supervisor.events()` — decisions carry
  machine-readable reasons and scores; migrations carry reports.
- `npm run build` + bundle scan: supervisor code appears ONLY once wiring
  lands, and its size delta is reviewed.
- Battery soak on a real handset before steps 5–6 (duty-cycle verification).
