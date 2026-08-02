# Adaptive Communication Network — Architecture (as built)

**Scope:** the production layer under `web/src/lib/transport-supervisor/`
(ADR-012b), shipped **dark** (all flags false, wired into nothing).
**Read with:** ADR-012 (scaffolding), ADR-012a + `threat-model-update.md`
(security), `activation-guide.md` (how it ever turns on).

---

## 1. Layering

```mermaid
flowchart TB
  subgraph APP["App (unchanged; nothing imports the supervisor today)"]
    UI[views / rooms.js / reach.js]
  end
  subgraph SEAL["Seal boundary — DEFERRED (ADR-008 §12; seal-boundary.js THROWS)"]
    SB["future: seal/open ABOVE the transport (P1 activation)"]
  end
  subgraph SUP["transport-supervisor/ — flag-gated, dark"]
    NET[network.js createAdaptiveNetwork]
    ENG[supervisor.js — rank + hysteresis + prediction + event log]
    MON[monitor.js — EWMA quality, health FSM]
    MIG[migration.js — make-before-break + receive pipeline]
    DRA[drain.js — QoS + AIMD + backoff]
    OUT[(durable-outbox.js IndexedDB)]
    MESH[mesh-engine.js — acks, reputation, duty cycle]
  end
  subgraph ADP["adapters/ (ITransport; lazy toward the live path)"]
    SIO[socketio-transport]
    CEN[centrifugo-transport]
    RTC[webrtc-transport]
    LAN[lan-transport]
    BLE[ble-central-transport]
  end
  subgraph LIVE["Existing live path (FROZEN — consumed via public APIs only)"]
    ST[socket-transport.js seals INSIDE today]
    TA[transport/ adapters]
  end
  UI -.->|"today: unchanged path"| ST
  NET --> ENG --> MON
  ENG --> MIG
  NET --> DRA --> OUT
  NET --> MESH
  ENG --> ADP
  SIO -.lazy import.-> TA
  CEN -.lazy import.-> TA
  TA --> ST
  SB -.->|"prerequisite for chat over NEW transports"| ENG
```

Key structural facts:

- **Opaque envelopes only.** Everything the layer moves is a `SealedEnvelope`
  whose ciphertext it cannot read; `assertSealedBeforeSend` (INV-6) runs at
  the supervisor's send choke point AND at every adapter edge.
- **The barrel is pure.** `index.js` imports no live-path module; adapters
  live behind their own barrel and reach `socket-transport.js`/`transport/*`
  only via lazy dynamic import inside `connect()` (fence-tested).
- **One factory.** `createAdaptiveNetwork` is the only composition point;
  master flag off ⇒ an inert stub with zero timers (tested with a clock that
  throws on use).

## 2. The supervisor loop

```mermaid
sequenceDiagram
  participant CK as clock (injected)
  participant MON as monitor
  participant T as each ITransport
  participant ENG as supervisor
  participant SEL as selector (scaffold hysteresis)
  participant MIG as migration executor
  CK->>MON: tick (2s)
  MON->>T: status() / quality() / costSignal()  — passive, throw-isolated
  MON->>MON: EWMA latency/loss/jitter/bw; health FSM; (every 3rd tick) trend prediction
  MON-->>ENG: snapshot
  ENG->>ENG: candidates = caps row + smoothed live + prediction penalty
  ENG->>SEL: chooseScored(scored, now)  — margin / dwell / stickiness
  alt no switch
    ENG->>ENG: log decision (reason, scores) — done
  else switch decided
    ENG->>MIG: execute(from → to)
    MIG->>MIG: connect(to) BOUNDED → attach receive → resend unacked (same envelopeIds) → grace → detach(from)
    ENG->>ENG: log migration report
  end
```

- **Prediction** is a least-squares slope over the smoothed series projected
  one horizon ahead; crossing the ceiling applies a bounded score penalty so
  the ordinary hysteresis machinery executes the early exit — no second
  decision path.
- **Decisions are serialized** on one promise chain: two ticks can never run
  two migrations concurrently.
- **Shadow mode** (`AUTO_TRANSPORT_ENABLED=false`): rank + log, never
  migrate — the staged-rollout posture.

## 3. Transport health state machine (as implemented)

```mermaid
stateDiagram-v2
  [*] --> UNKNOWN
  UNKNOWN --> HEALTHY: connected (probation) / good samples
  HEALTHY --> DEGRADED: smoothed latency ≥ 800ms or loss ≥ 0.15
  DEGRADED --> HEALTHY: back under RECOVER bars (500ms / 0.08 — hysteresis)
  HEALTHY --> DOWN: loss ≥ 0.6 or lifecycle failed/closed/reconnecting
  DEGRADED --> DOWN: same
  DOWN --> HEALTHY: lifecycle up + samples recover
  UNKNOWN --> UNAVAILABLE: platform cannot serve (iOS BLE, no broker URL)
  HEALTHY --> UNAVAILABLE: hard unavailability reported
  DOWN --> UNAVAILABLE: hard unavailability reported
  UNAVAILABLE --> HEALTHY: capability appears (rechecked on observation, not probed on a timer)
  note right of DEGRADED : selectable, scores lower,\ncandidate for proactive migration
  note right of UNAVAILABLE : distinct from DOWN —\nnot worth spending battery probing
```

Staleness rule: any state not refreshed within 45 s reads as UNKNOWN — a
confident answer nobody has checked is not an answer.

## 4. Send path and receive path

```mermaid
flowchart LR
  subgraph SEND["send (sealed envelope in)"]
    A[drain.submit] --> B[(outbox enqueue — durable FIRST)]
    B --> C{QoS queue\ncall-signal > msg > receipt > telemetry}
    C --> D{AIMD window\ncanSend?}
    D --> E[supervisor.send — INV-6 assert]
    E --> F[current ITransport.send — bounded]
    F -->|ok| G[await ack… same envelopeId retries]
    F -->|fail| H[backoff class: transient / persistent]
    G -->|acked| I[outbox markDelivered]
  end
  subgraph RECV["receive (any transport, any order)"]
    R1[adapter receive] --> R2[dedup by envelopeId]
    R2 --> R3[per-origin reorder buffer]
    R3 --> R4[deliver exactly-once, in order]
  end
```

## 5. Mesh node (production behaviour over mesh.js)

```mermaid
flowchart TB
  IN[receiveFrom link] --> V{shape + TTL-forgery check}
  V -->|bad| M[reputation.misbehaved → drop]
  V --> D{seen-set}
  D -->|dup| X[drop duplicate]
  D --> P[deliver + END-TO-END ACK\nack floods back, frameId only]
  P --> F{relay? MULTIHOP + fanout}
  F -->|yes| O[forward() — payload BIT-IDENTICAL, hop+1\nto best neighbours by reputation, split horizon]
  ORIG[originate] --> TRACK[ack tracker: capped, jittered retransmit\nexhaustion surfaces to the outbox]
  TICK[clock tick] --> TRACK
  BATT[battery] --> DUTY[duty cycle: active/background/low/critical\ncritical = receive-only]
```

## 6. Where the platform ends (documented, not faked)

| Capability | Web today | Native (P10) |
|---|---|---|
| BLE central (GATT client, chunked writes, notifications, reconnect) | **Implemented** (`ble-central-transport.js`) | same protocol |
| BLE peripheral / GATT server / advertising | impossible on the web | implements `SPOTME_GATT` + discovery record |
| Background scanning / connections | impossible | duty-cycle schedules map onto real scan windows |
| RSSI | `watchAdvertisements` (Chromium, flagged) else null→neutral | always |
| Wi-Fi Direct / mDNS true-offline LAN | impossible — LAN = WebRTC host-candidates (signalling still online) | native transport |
| iOS Web Bluetooth | absent — adapter reports UNAVAILABLE with reason | native |
