# Production checklist — adaptive network (P2D)

## Shipped in this PR (all verified on the branch)

- [x] Real ITransport adapters ×5, contract-asserted, key-surface-free,
      INV-6 at every edge, bounded timeouts on every connect/send
- [x] Supervisor engine: EWMA estimation, health FSM (incl. honest
      UNAVAILABLE), trend prediction with a strictly-earlier-switch proof,
      hysteresis untouched from the scaffold, machine-readable event log
- [x] Zero user interaction: no choice API (asserted), no view imports
      (fence), owner rule structural
- [x] Make-before-break migration; session continuity BLE→LAN→relay with
      0 loss / 0 dup / 0 reorder under scripted loss+latency
- [x] Durable outbox (IndexedDB) + wipe-path registration + honest
      memory-only degradation; ack-or-retry drain; AIMD window;
      transient/persistent backoff classes; QoS with shed valve
- [x] Mesh production: end-to-end acks w/ capped retransmit + exhaustion
      surfacing, reputation (availability-only), rotating discovery records,
      RSSI prior, battery duty cycling w/ receive-only floor, churn +
      partition-heal + storm tests on real engine topologies
- [x] Layered flags, ALL FALSE; master-off factory constructs zero timers
      (booby-trapped-clock proof)
- [x] 116 new checks in 8 suites; FULL suite green (1124/1124); lint clean;
      build green; bundle contains zero supervisor code
- [x] Benchmarks recorded with environment (see benchmark-report.md)
- [x] Seal-lift STILL throwing; asserted twice; ADR-008 §12 untouched
- [x] Docs: ADR-012b, architecture (+ diagrams), threat-model update,
      security review, benchmark report, rollback, activation, ops

## Deliberately NOT in this PR (gated)

- [ ] Seal-lift (P1 activation + rollback-after-publication, ADR-008 §12)
- [ ] Chat over BLE/LAN/mesh/Centrifugo (behind the seal-lift)
- [ ] Wiring + any flag flip (activation-guide.md, own PR + fence update)
- [ ] BLE peripheral / background radio / Wi-Fi Direct / mDNS (P10 native)
- [ ] Signed delivery receipts (P1 identity; slot reserved in mesh-ack)
- [ ] Mesh-trust ADR + proximity-metadata ruling (owner; WS4 §18.1)
- [ ] Real-radio device matrix + battery soak (P10; bench doc names the gap)

## Review gates for the NEXT PR (activation) — carried from here

- [ ] Fence test consciously updated (wiring site becomes the one importer)
- [ ] Reputation still never gates trust (grep + review)
- [ ] db.js wipe line NOT removed
- [ ] Discovery-id rotation actually rotates (epoch source wired)
- [ ] BLE connect() called from a user gesture only
- [ ] Event-log soak reviewed before AUTO_TRANSPORT flips
