# ADR-004 — The peer-to-peer call path is deleted; the SFU is the only one

**Status:** accepted, shipped dark (flag default OFF)
**Date:** 2026-08-05
**Supersedes in part:** [ADR-003](003-livekit-call-media.md) — every part of it
that treats peer-to-peer calling as a live path, a fallback, or something the
two devices negotiate.

## Context

ADR-003 added LiveKit alongside the existing peer-to-peer call path and made
both devices agree before media went to the SFU. That caution was correct for a
migration with users on the old path. There are none: the P2P call path has
never carried a real call between real users.

Keeping it anyway had a running cost that a feature nobody used could not repay:

- **Two media paths meant a negotiation**, and the negotiation had a silent
  failure mode. One side on the SFU and the other on a peer connection produced
  a call that connects, rings, shows "active" and carries nothing — no error to
  notice, just "I couldn't hear you".
- **The peer path could not become group calls.** A mesh costs each phone N-1
  uplinks. Every hour spent keeping it alive was spent on a topology with a
  hard ceiling of three or four participants.
- **It spread across three layers.** `RTCPeerConnection` construction, perfect
  negotiation, an `rtc` signalling action and a stream API in the transport;
  branches in `rooms.js`; a server-side action type. Every future change to
  calls had to be made twice or reasoned about twice.

## Decision

**Delete it.** Not disable, not flag off, not keep as a fallback.

Removed:

| Where | What |
|---|---|
| `web/src/lib/socket-transport.js` | `RTCPeerConnection` per peer, perfect-negotiation offer/answer/rollback, ICE candidate relay, `addStream` / `removeStream` / `replaceTrack`, `onPeerStream`, the `rtc` frame branch |
| `web/src/net.js` | the stream API those backed, and the `onStream` handler |
| `web/src/lib/rooms.js` | the media-path negotiation, the P2P attach/detach branch, the fallback on LiveKit failure |
| `backend/src/rooms/rooms.service.ts` | `rtc` from the ephemeral action allow-list — the server now refuses the frame rather than relaying a type nothing speaks |
| `web/src/lib/calls/select.js` | `agreeCallMedia()` and the path report — with one path there is nothing to agree or report |

**Trystero stays, and is now unrelated to calls.** It is reachable only through
`localStorage['spotme.transport'] = 'p2p'`, which selects a legacy MESSAGING
transport (ADR-002) and is covered by its own tests — `transport.test.js` pins
"p2p is still reachable — the legacy escape hatch is not broken". That is a
different subsystem with a different owner. Calls no longer touch it. Removing
the dependency is a one-line change once the messaging workstream retires that
mode; doing it here would have deleted a documented messaging option under the
banner of a calls cleanup.

## Consequences

### Flag off now means calls are UNAVAILABLE, not degraded

This is the sharpest change. Previously the flag chose between two working
paths, so "off" meant "calls, the old way". There is no old way. `rooms.js`
refuses with a readable message — *"Calls are not enabled on this device yet"* —
rather than starting a call that cannot connect. Same for a deployment with
`LIVEKIT_*` unset: `/api/v2/calls/config` answers `available: false` and the
client never offers the call.

A button that silently does nothing is worse than one that says why.

### There is no fallback, so failures must be spoken

Every failure in the media path is now fatal to that call. The client ends the
call and toasts the reason instead of quietly retrying on another transport.
This is a real reduction in resilience and the correct trade: a fallback to a
path that no longer exists was never resilience, and a call stuck on
"Connecting…" forever is the worst of both.

### Privacy: calls are not end-to-end encrypted

ADR-003 already recorded this; deleting the peer path removes the last
configuration in which it was not true. **LiveKit decrypts call media at the
SFU.** Frames are TLS-protected in transit and are not stored, but the server
can see them. There is no longer any call configuration where media stays
between the two devices.

**Messages are unaffected and remain end-to-end encrypted.** That distinction is
the thing to protect in every future edit, because the two are easy to conflate
and the conflation always flatters us.

Copy corrected under this ADR:
- `chat.js` system line — "Encrypted with keys made on your devices" →
  "**Messages are** encrypted with keys made on your devices"
- `chat.js` privacy panel — now says "your **messages**", and where calls are
  enabled adds: *"Calls are not end-to-end encrypted. Audio and video pass
  through a media server, which can see them, so that calls connect on mobile
  networks."*
- `docs/07-SECURITY-PLAN.md` — the "what the attacker does not get" list claimed
  call media was out of reach because WebRTC stayed peer-to-peer. Corrected: an
  attacker controlling the media server sees the call.
- `docs/06-ROADMAP.md` — the Phase 3 line promising "media never touches the
  server" is marked superseded rather than rewritten, since it records what was
  believed at the time.
- `socket-transport.js` header — claimed "call audio/video never touches the
  server".

**Documented upgrade path: LiveKit insertable-streams E2EE**, where call
participants agree a key the SFU never holds. Not implemented. Until it is, no
UI string, document or marketing text may describe calls as end-to-end
encrypted. When it is implemented, this ADR is the one to supersede.

### Group calls are now a shorter change than they were

Deleting the mesh is what made this cheap. `rooms.js` holds
`call.remotes: Map<identity, MediaStream>` instead of a single `call.remote`,
and the overlay renders a tile per entry. 1:1 is the same code with one entry —
group is not a mode, it is a longer map.

Behaviour worth naming, because 1:1 hides it: **the last participant leaving
ends the call; anyone else leaving does not.** In a two-person call those are
the same event, which is exactly how "hang up when someone leaves" would ship
and then drop a six-person call the moment one phone died.

Still open before group is announced: a participant cap, the ring semantics for
more than two people (who is rung, what "busy" means, what happens when the
person who started it leaves), and whether group is audio-only first — which is
roughly an order of magnitude cheaper and probably the common case.

**Group is behind the same flag as 1:1.** Turning `spotme.calls` on enables
both. If they should be separable, that is a deliberate second flag and not
something to discover after enabling.

## Verification

- `backend/test/livekit-calls.spec.ts` — token claims, derived room name,
  membership refusal, grant scope (7 passing)
- `web/test/calls-flag.test.js` — flag default OFF and only the exact string
  enabling it (3 passing). The `agreeCallMedia()` cases were REMOVED, not
  ported: they pinned a negotiation that no longer exists.
- `web/test/transport.test.js` — the messaging transport contract, unchanged and
  passing in isolation
- `web/test/livekit-call.harness.mjs` — a real two-browser call through the
  shipping adapter, audio and video decoded both directions
- `web/test/turn-relay.check.mjs` — passes only if a relayed candidate pair
  actually carries bytes

Unverified, unchanged from ADR-003: no call over Metered's relay, none on a
mobile network, none against a deployed backend.
