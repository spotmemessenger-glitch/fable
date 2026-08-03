# ADR-026 — Realtime ownership: a split control/data plane

**Status: ACCEPTED — owner decision recorded 2026-08-03 (delegated engineering approval, Platform Phase 1 landing mission).** · **Date:** 2026-08-03
**Relates to:** ADR-002 (transport interface), the platform-migration Phase 1
foundations (`feat/platform-phase-1`), and the Dragonfly runtime note.

> Accepted 2026-08-03 under delegated engineering approval. Nothing is wired in
> by acceptance — this records the direction; implementation remains future,
> separately reviewed work. Acceptance does not itself deploy anything.

## Context

Realtime today is **Socket.IO** (primary) with abandoned Centrifugo and P2P
seams (`09-TECH-STACK.md §Realtime`, ADR-002). Three different workloads are
being served by one mental model:

1. **Control** — auth, room membership, presence, receipts, typing, match/status
   events. Low volume, needs the server's identity and authorization context,
   already lives in the Nest gateway.
2. **Data fan-out** — high-volume broadcast to many subscribers (Discovery
   nearby streams, Live Nearby Events, Exchange match streams). This is where
   Socket.IO's per-node fan-out and sticky-session scaling hurt first.
3. **Calls** — 1:1 voice/video, already working over **Trystero/WebRTC**
   (`rooms.js`). Peer-to-peer media that does not belong on any server broker.

Forcing all three through one transport couples their scaling and failure
modes: a fan-out spike degrades control-plane latency; a broker choice for
fan-out drags calls along for no reason.

## Decision (proposed)

Adopt a **split-plane** realtime architecture:

- **Control plane = Socket.IO** on the existing Nest gateway. Keeps the
  server's auth/authz context; unchanged for clients. Source of truth for state
  (REST remains authoritative; realtime is an accelerant).
- **Data plane = Centrifugo** for high-volume, subscribe-heavy fan-out. Clients
  subscribe with short-lived server-minted tokens (the control plane mints
  them); Centrifugo never becomes an authorization authority.
- **Calls stay on Trystero/WebRTC.** Explicitly out of scope — no regression to
  the working P2P media path.
- **Broker = Valkey (dev/CI) / Dragonfly Cloud (prod)**, reached only via
  `REDIS_URL` (env). Same Redis-protocol runtime already chosen for BullMQ; the
  `{…}` hash-tag key convention applies to broker keys too.
- **pgvector: deferred.** No vector store until a feature with a measured need
  (semantic search / recommendations) justifies it. Not part of this split.

## Consequences

- **Positive:** fan-out scales independently of control; calls untouched; one
  Redis-protocol runtime (Dragonfly) backs queue + broker; the transport
  interface (ADR-002) already lets the data plane be introduced behind a seam.
- **Cost / risk:** a second realtime system to operate and observe; token
  minting and channel-authorization must be designed so Centrifugo stays a dumb
  pipe; client SDK surface grows. All deferred until accepted.
- **Reversible:** until adopted and wired, this changes nothing. The seam (ADR-002)
  means the data plane can be trialled on one stream and rolled back by config.

## Evidence

- Current transport: `spotme/backend/src/realtime/`, `spotme/web/src/lib/transport/`,
  ADR-002; calls on `spotme/web/src/lib/rooms.js` (Trystero/WebRTC).
- Runtime: `REDIS_URL` (env) → Valkey (dev) / Dragonfly Cloud (prod);
  `spotme/docker-compose.dev.yml`, `spotme/backend/src/queue/` (hash-tag convention).

## Open questions for the owner

1. Accept the split-plane direction, or keep consolidating on Socket.IO + Redis
   adapter for fan-out?
2. Confirm Centrifugo as the data-plane broker vs. a Socket.IO Redis-adapter
   scale-out (fewer moving parts, less throughput headroom).
3. Confirm pgvector stays deferred until a named feature needs it.
