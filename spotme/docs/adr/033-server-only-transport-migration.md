# ADR-033 — Server-side-only transport; the P2P path is removed, not frozen

**Status:** Accepted (owner decision, 2026-08-06) · **Supersedes:** the P2P
retention clause of [ADR-002](002-realtime-centrifugo-abstraction.md) ·
**Related:** [ADR-003](003-livekit-call-media.md), [ADR-004](004-e2ee-call-media-limits.md), [ADR-026](026-realtime-split-plane.md)

## Decision

Spot Me's transport layer is **server-side only**. The peer-to-peer path
(Trystero) is being **removed from the codebase**, not merely left unextended.

This corrects a narrower prior decision. ADR-002 (2026-07-31) kept the
Trystero path alive as a *messaging* fallback behind `spotme.transport=p2p`,
reasoning that "a mechanism already exists for `p2p` rather than inventing a
second one." That reasoning no longer holds: the owner's direction is that
the product runs on one transport family, end to end, and P2P is legacy to
delete rather than a fallback to preserve.

## What this changes versus ADR-002 / ADR-003

| Path | ADR-002/003 (until 2026-08-06) | ADR-033 (now) |
|---|---|---|
| Call media | P2P (Trystero/WebRTC) deleted; LiveKit is the only path | unchanged — already server-side |
| Messaging/presence | Centrifugo primary, **Trystero P2P retained as fallback** behind `spotme.transport=p2p`, pinned by `web/test/transport.test.js` | **Trystero removed entirely.** Centrifugo (or Socket.IO until Centrifugo is deployed) is the only messaging transport. No P2P fallback, no flag. |

## Why

The owner's standard for this product is that a fluent demo of a broken app
is worth nothing, and a maintained-but-unused fallback is exactly the kind of
surface area that produces a broken app nobody notices: two transport
implementations to keep correct, two code paths a bug can hide in, and a test
(`transport.test.js`) whose entire purpose was to keep the deleted path alive.
Removing it is not a regression in resilience — Centrifugo/Socket.IO already
being the primary path for the overwhelming majority of sessions — it is
removing dead-weight-that-still-runs.

## Consequences

- `web/src/lib/transport/*`, `web/src/net.js`, `web/src/lib/socket-transport.js`,
  and every caller that branches on `spotme.transport=p2p` lose that branch.
  Server-side (Centrifugo once deployed, Socket.IO until then) is the only
  path — no runtime fallback if the server transport is unreachable.
- `web/test/transport.test.js` is rewritten to assert the *absence* of
  Trystero imports and the p2p flag, not to pin their behavior.
- Any future PR that reintroduces a P2P code path for messaging or calls is a
  regression against this ADR, not a legitimate feature — including a
  well-intentioned "offline resilience" fallback. That idea needs a fresh
  ADR and an explicit owner decision, not a quiet reintroduction.
- Bluetooth mesh (roadmap item, still unbuilt) is a *separate* transport for
  a *separate* offline scenario and is not affected by this decision either
  way; it was never P2P-over-internet and this ADR takes no position on it.

## Non-decisions

This ADR does not itself deploy Centrifugo, LiveKit, or TURN — it only
removes the P2P alternative and records that server-side transport is now
the sole intended architecture. Deployment status of each server-side piece
is tracked separately (see the 2026-08-06 handover and deploy runbook).
