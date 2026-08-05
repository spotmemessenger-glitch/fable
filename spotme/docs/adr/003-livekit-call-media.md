# ADR-003 — Call media moves to LiveKit; messaging does not

**Status:** SUPERSEDED IN PART by [ADR-004](004-delete-p2p-calls.md) (2026-08-05).
Every statement below that describes peer-to-peer calls as a live path, a
fallback, or something both sides must agree to is no longer true: that code is
deleted. The SFU rationale, the TURN ordering, the cost model and the privacy
consequence all still stand — ADR-004 records only the removal and what it
changed. Originally: accepted, shipped dark (flag default OFF).
**Date:** 2026-08-05
**Supersedes nothing. Adjacent to:** ADR-002 (realtime transport abstraction)

## Context

The realtime architecture was split in two: messaging/presence, and call media.
ADR-002 covers the first and left Centrifugo deferred behind a loud fallback.
This ADR covers the second.

Calls today are peer-to-peer WebRTC. Signalling (ring / accept / decline / hang
up) rides the room transport as four small sealed actions; media rides
`RTCPeerConnection`s built in `socket-transport.js`, or Trystero when
`spotme.transport = p2p`.

The media half has a failure that no amount of care in our code fixes. Indian
mobile carriers place subscribers behind carrier-grade NAT, so two phones on
mobile data frequently cannot form a direct path at all. A TURN relay recovers
some of those calls; the 2026-07-25 measurement confirmed Cloudflare's relay
allocates, and confirmed one free provider answered nothing at all. But a relay
is a patch on a topology that also cannot do the next thing we want: a P2P mesh
costs each participant N-1 uplinks, which a phone stops sustaining at three or
four people.

## Decision

**Call media moves to a LiveKit SFU, behind a flag, default OFF. Everything
else stays exactly where it is.**

What moves:
- audio and video frames, for 1:1 calls, when both devices opt in.

What does NOT move, and why:
- **Messages, reactions, receipts, presence, typing** — no reason to. They work,
  they are sealed below the transport, and moving them would re-open exactly
  the V-19 class of problem ADR-002 §2 documents.
- **Call signalling** — it already works and is transport-agnostic. Moving it
  would mean a second implementation of ring/accept/busy that has to agree with
  the first, which ADR-002 named as the failure mode for transports.
- **Identity keys, device keys, E2EE sessions** — untouched. The calls module
  reads exactly one thing from the messaging world: whether a user is a member
  of a room.

### Why server media rather than better P2P

An SFU terminates each participant's media once and forwards it. That buys:

1. **Connectivity.** Every client makes one connection to a well-known, publicly
   addressable server instead of a connection to an unpredictable peer. This is
   the whole reason: client-to-server succeeds on networks where peer-to-peer
   cannot.
2. **Group calls at all.** Mesh is O(N²) connections and N-1 uplinks per phone.
   An SFU is one uplink regardless of participant count.
3. **One place to see failures.** A P2P call that fails leaves nothing on any
   server to look at.

### The cost, stated plainly

**LiveKit can see call media.** Frames are TLS-protected in transit and LiveKit
does not store them, but they are decrypted at the SFU. The peer-to-peer path
made that impossible. This is a real reduction in privacy and it is the price of
calls that connect.

Two things bound it:
- It applies to CALLS ONLY. Messages and attachments remain sealed end-to-end and
  never traverse this path.
- It is reversible per device (clear the flag) and per deployment (unset the env
  vars).

**The upgrade path is E2EE media.** LiveKit supports end-to-end encrypted tracks
via insertable streams with a key the server never holds. It is NOT wired now.
Doing it needs a key agreed between call participants, which means reusing the
E2EE session machinery another workstream currently owns — deliberately out of
scope here. Until then, no part of the product should describe calls as
end-to-end encrypted while this flag is on.

## TURN (Metered)

Even with an SFU, a client that cannot reach it directly needs a relay. The ICE
configuration served by `GET /api/turn` is now Metered first, Cloudflare second,
STUN-only last.

Metered returns five entries; the ordering matters more than the provider:

| URL | Why it is in the list |
|---|---|
| `stun:stun.relay.metered.ca:80` | candidate discovery, no relay cost |
| `turn:global.relay.metered.ca:80` | UDP relay, cheapest relayed path |
| `turn:…:80?transport=tcp` | TCP when UDP is blocked |
| `turn:…:443` | UDP on the HTTPS port |
| `turns:…:443?transport=tcp` | **TLS over TCP/443 — indistinguishable from HTTPS** |

The last row is the one that matters for the target networks: a carrier that
drops UDP wholesale still passes traffic that looks like HTTPS. Cloudflare's
endpoint was measured working on friendly networks but gives us no TLS/443
fallback, so it becomes the second choice rather than the first.

Offering a relay candidate does not force its use. ICE prefers host, then
server-reflexive, and falls back to relay only when both fail — so a call
between two phones on the same wifi still costs no relay bandwidth. Relay
traffic is metered and billed, which makes this ordering a cost decision as much
as a reachability one.

## Cost model at scale

Two independent meters.

**LiveKit Cloud** bills participant-minutes of bandwidth. For 1:1 calls each
participant both sends and receives, so a two-person call consumes roughly
2× the call duration in participant-minutes. Video dominates: audio-only is an
order of magnitude cheaper than video, which is worth remembering because most
calls in this product are likely to be audio.

**Metered TURN** bills relayed GB, and only for the fraction of calls that
cannot go direct. Its free tier is 0.5 GB/month without a card and 20 GB with
one, hard-stopping rather than billing overage. 20 GB is roughly 12–15 hours of
relayed 1:1 video, or far more audio. If the relayed fraction is the commonly
cited 10–20%, that covers a small user base and nothing more.

The honest summary: **cost scales with call MINUTES, not with users**, and video
minutes cost roughly an order of magnitude more than audio minutes. Before any
wide rollout, the number to know is how many call minutes per active user per
month — which we do not have, because the flag is off and no LiveKit call has
been placed in production.

**Self-hosting** is the escape valve. LiveKit is Apache-2.0 and the server is a
single Go binary; a self-hosted deployment turns a per-minute bill into a fixed
server cost plus egress. That trade favours self-hosting once call volume is
predictable and high, and favours the hosted service while it is neither. The
adapter reads `LIVEKIT_URL` and does not care which it points at, so this is a
configuration change and not a rewrite — that is the main reason the adapter
hand-mints its token instead of depending on a cloud-specific SDK path.

## Consequences

- With the flag off — the default everywhere — nothing changes. The LiveKit SDK
  is a separate 490 kB chunk that is never fetched.
- With the flag on and the server unconfigured, the client falls back to P2P and
  logs why. A silent downgrade would let someone believe they had tested this.
- Both devices must agree before media goes to the SFU. A one-sided switch
  produces a call that connects and carries nothing; `agreeCallMedia()` makes
  that unrepresentable, and an older client that omits the field negotiates the
  legacy path by construction.
- Rollback is `localStorage.removeItem('spotme.calls')` on a device, or unsetting
  `LIVEKIT_*` on the deployment. No data migration, no schema change, nothing to
  undo.

## Group calls

The room abstraction is already N-participant: the adapter emits
`(stream, identity)` per remote publisher and tracks departures per identity, and
an SFU does not care whether N is one or eight. What is missing is above it:

1. `rooms.js` keeps a single `call.remote`; it needs a map keyed by identity.
2. The call overlay in `chat.js` renders one remote video; it needs a grid.
3. Ring semantics for more than two people — who is called, what "busy" means,
   what happens when the person who started it leaves.
4. A participant cap, and a decision about whether group calls are audio-only
   first (materially cheaper, and the common case).

None of that is a LiveKit change. Turning it on is a config change; making the
UI able to show it is not.

## Configuration

Read by NAME only; values are set in Railway/Vercel by the owner.

| Variable | Where | Purpose |
|---|---|---|
| `LIVEKIT_URL` | api | `wss://` URL of the SFU; the server API is derived from it |
| `LIVEKIT_API_KEY` | api | token `iss` |
| `LIVEKIT_API_SECRET` | api | HS256 signing key for join tokens |
| `METERED_TURN_SUBDOMAIN` | web (Vercel) | `<subdomain>.metered.live` |
| `METERED_TURN_API_KEY` | web (Vercel) | credential-scoped key — **not** the account secretKey |

With none of these set, both endpoints answer "not configured here" and the app
behaves exactly as it does today.

## Verification

- Token claims, room-name derivation, membership refusal and grant scope:
  `backend/test/livekit-calls.spec.ts` (7 assertions, passing).
- Flag default and path negotiation: `web/test/calls-flag.test.js` (5, passing).
- A real two-browser call through the shipping adapter against a local LiveKit
  server: `web/test/livekit-call.harness.mjs` — audio and video decoded in both
  directions, SFU connect 229 ms.
- A relayed connection actually forming: `web/test/turn-relay.check.mjs` —
  verified `relay -> relay` through a local coturn.

**Unverified and stated as such:** no call has been placed over Metered's relay
(no credentials available to this workstream), none over a mobile network, and
none against a deployed backend.
