# Threat model UPDATE — adaptive network production layer

**Extends:** ADR-012a (mesh scaffolding threat model). That document's load-
bearing assumption is unchanged and restated first: **relays are untrusted;
content confidentiality/integrity rely entirely on the end-to-end seal, never
on the mesh — and the seal-lift is still deferred, so no real message may
traverse a new transport yet.** This update covers what the PRODUCTION layer
adds: acks, reputation, discovery records, a durable outbox, and switching
across transports.

## 1. New/updated threats

| # | Adversary | Threat | Mitigation (as built) | Residual |
|---|---|---|---|---|
| T11 | A2 malicious relay | **Ack forgery** — fake an ack so the origin stops retransmitting (targeted suppression) | Today an ack is availability-only: worst case the origin stops retrying ONE frame on ONE mesh path while the outbox still owes the envelope (ack-or-retry releases only on `drain.acked()`, which wiring ties to server seq / receipt — NOT to mesh acks). The signed-receipt slot (P1) upgrades acks to proof. | Until P1 receipts, a relay can suppress mesh-path delivery detectably-late rather than provably; the supervisor's other transports remain the recovery path |
| T12 | A2/A4 | **Reputation gaming** — behave well to earn score, then drop selectively; or frame a rival by delivering garbage "from" it | Reputation is availability accounting ONLY: it orders which neighbour is tried FIRST, never who is believed. Fan-out (default 3) + flooding means a gamed top slot cannot exclude other paths; misbehaviour credit is per-LINK (the link that handed us the frame), not per claimed origin, so framing a rival requires owning the victim's link. Scores are floored (0.05) and recover — no permanent blacklist an attacker can drive a victim into. | A patient adversary can still bias next-hop choice; bounded by fanout>1 and by flooding's path diversity. Acceptable while the mesh is proximity fallback, not backbone |
| T13 | A3 | **TTL forgery / hop manipulation** to amplify flooding or extend reach | Engine drops frames whose ttl exceeds the protocol max or whose hop/ttl geometry is impossible, and books misbehaviour against the delivering link | Protocol max is config; a wider mesh raises it deliberately (bench documents the diameter relationship) |
| T14 | A4 | **Ack-flood amplification** (acks flood too) | Acks carry ~4 short fields, dedup in their own bounded seen-set, and obey the same TTL/fanout discipline | Ack traffic ≈ frame traffic in the worst case; accepted, bounded |
| T15 | A5 tracker | **Replay ACROSS transports** — capture an envelope on BLE, re-inject via relay/server later to resurface or probe | envelopeId dedup is transport-agnostic (one window in the shared receive pipeline) and the reorder buffer rejects at/behind the per-origin high-water mark; beyond the bounded window, freshness is the ratchet's job (P1) — same honest residual as ADR-012a T5 | Replay of very old traffic past the window re-enters until P1 freshness lands; contentwise still opaque |
| T16 | A5 | **Discovery-record tracking** — a stable advertised id links sightings into a movement profile | The record carries a ROTATING device-id hash (15-min epochs, `DISCOVERY_ROTATION_MS`), no account id, ≤128 bytes; parse rejects overlong ids | The RADIO's own MAC randomisation is a platform/native concern (P10), as ADR-012a T7 said; rotation upstream must actually rotate (activation checklist item) |
| T17 | local attacker w/ device | **The durable outbox is a record** of roomIds/origins/timestamps (sealed payloads, but metadata) | The store joins `wipeDevice()` from day one (db.js registration, tested); TTL sweeps expire entries; nothing is written while flags are off | IndexedDB is not encrypted at rest beyond the platform's protections — same posture as every other store on the device |
| T18 | A6 battery-drain | **Forced scanning/retransmit spend** | Duty cycling with a receive-only floor at <15% battery; retransmit caps; AIMD collapses the window under failure; UNAVAILABLE states are not probed on timers | Radio-level abuse (connection request spam) is native-layer (P10) |

## 2. Metadata surface (privacy), stated honestly

What each party can observe with the production layer active (post-activation):

- **A mesh relay** learns: a frame of size S with frameId F passed at time T
  from link L, TTL/hop, and (if it later sees the ack) that some node
  delivered it. It learns **no content, no account ids, no roomId** — the
  mesh frame carries opaque payload + routing digests only.
- **A BLE neighbour** additionally learns radio presence and (Chromium) RSSI
  ≈ distance — the proximity surface ADR-012a already flagged for the
  Priority-8 discovery threat model; unchanged, still an owner gate before
  any mesh rollout.
- **The server** (relay/socket paths) learns exactly what it learns today —
  who/when/size — because the supervisor envelope rides inside the same
  sealed room actions; nothing new crosses.
- **The wire between adapters** carries the envelope wire-JSON: envelopeId
  (digest), roomId, origin (routing id), ordering counters, ciphertext.
  This equals today's routing metadata surface; INV-4 keeps ids free of
  key/plaintext inputs, asserted in tests.

## 3. What this layer can NEVER fix (and does not claim to)

- Content authenticity and freshness are the seal/ratchet's (P1). The mesh's
  acks, reputation, and dedup are **availability engineering**.
- Radio-layer anonymity (MAC rotation, padding, cover traffic) is native
  (P10) — ADR-012a §7's gate list stands verbatim, and activation of any
  mesh chat remains behind: seal-lift → sender authenticity → native
  metadata hardening → flag PR.
