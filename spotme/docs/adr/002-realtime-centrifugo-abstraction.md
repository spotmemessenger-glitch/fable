# ADR-002 — A transport interface, and Centrifugo behind it

**Status:** Accepted · **Date:** 2026-07-31 · **Builds on:** [ADR-001](001-e2ee-v19-fix.md) · **Phase:** 2

## Context

The web client talks to one NestJS Socket.IO gateway (`rooms.gateway.ts`). It
works, and it has three limits worth naming precisely rather than in the
abstract:

1. **One instance holds the room map.** `rooms.gateway.ts` keeps
   `Map<roomId, Map<userId, Set<Socket>>>` in process memory and fans out with
   `client.to('r:' + roomId)`. Two instances behind a load balancer would each
   see half a room and neither would know it. Horizontal scale is not a tuning
   problem here; the topology forbids it.
2. **Recovery is hand-rolled and one-directional.** Clients replay from a
   per-room cursor over `RoomEvent`. That covers durable actions, but ephemeral
   ones (typing, presence `hello`) are simply lost on a drop, and a reconnect
   costs a full cursor query rather than a delta.
3. **Presence is a single global lobby room.** The Phase 0 audit recorded that
   this needs geo-sharding before it scales.

Centrifugo is a purpose-built broker for exactly (1) and (2): channel-based
pub/sub, JWT-authenticated connections, history with positioning and recovery,
and horizontal scale via a Redis/Nats broker.

### Corrections to the brief, made before designing against it

- **The npm client SDK is `centrifuge`, not `centrifuge-js`.** `centrifuge-js`
  does not exist on npm; `centrifuge` is at `5.7.0` (verified via `npm view`).
  A dependency named in a design doc that cannot be installed is how a plan
  survives review and then fails on `npm i`.
- **Server version:** Centrifugo is cloned at `fable/msg-stack/centrifugo`
  (Apache-2.0, so no licence constraint — unlike much of that folder). It is a
  `--depth 1` clone with no tags, so the exact tag is **not** pinned here.
  `CHANGELOG.md` stops at v5.1.2 by the project's own choice; releases moved to
  GitHub. **Pin the server version in the deployment config, not in prose**,
  and confirm the client/server protocol pair before rollout.

## Decision

### 1. `ITransportAdapter`, with Socket.IO as the reference implementation

One interface, three implementations, chosen at runtime:

| Key | Adapter | Status |
|---|---|---|
| `socketio` | `SocketIOAdapter` — wraps today's `socket-transport.js` | default |
| `centrifugo` | `CentrifugoAdapter` — `centrifuge` SDK | opt-in |
| `p2p` | existing Trystero path | legacy, already switchable |

Selected by `localStorage['spotme.transport']`, extending the flag that already
exists for `p2p` rather than inventing a second mechanism.

The contract is deliberately **narrow** — `connect`, `disconnect`, `subscribe`,
`unsubscribe`, `publish`, `presence`, `status` — because a wide one would leak
Socket.IO's semantics into it and the second implementation would then be a
Socket.IO emulator rather than a peer.

### 2. THE CONSTRAINT THAT OUTRANKS THE REST: no adapter may hold a room key

ADR-001's defence against V-19 is that `roomKey()` consults a **provider** and
has **no password fallback** for an `e2e_v2` room. That defence lives in
`socket-transport.js`. A new transport written without knowing about it would
naturally re-implement `roomKey(roomId, password)` — and every v2 room would
silently revert to the cyrb53 key the server can recompute. Both peers would
degrade identically, so nothing would surface. That is the exact failure the
Phase 1 adversarial review caught, and a transport rewrite is the single most
likely way to reintroduce it.

Therefore:

- **Adapters move opaque bytes.** They never derive, hold, cache or inspect a
  room key. Sealing and opening stay above the transport.
- `setRoomKeyProvider` / `clearRoomKey` remain the only way a key enters the
  system, for every adapter.
- `test/transport.test.js` asserts that no adapter exposes a key-shaped
  surface, so this is enforced by a failing test rather than by this paragraph.

### 3. Publishing goes through the server, never straight to the broker

Centrifugo will happily let a subscribed client publish into a channel. The
current gateway does two things on `action` that a broker does not
(`rooms.gateway.ts`):

- **Authorisation** — `policy()` → `refuse()` enforces group role, mute and ban.
  The audit already found that "the rooms gateway previously authorised
  NOTHING"; letting clients publish directly would restore that hole wholesale.
- **Persistence** — durable types append to `RoomEvent`, which is what makes
  offline replay work at all.

So client publications go to `POST /api/v2/realtime/centrifugo/publish`, which
runs the same policy and persistence path and then publishes server-side via
Centrifugo's HTTP API. **Client-side publish is disabled in the Centrifugo
channel config**, not merely unused — an unused capability is a capability.

### 4. Connection tokens are minted by us

`POST /api/v2/realtime/token` returns a short-lived Centrifugo connection JWT
bound to the authenticated principal, signed with a secret only the backend and
Centrifugo share. Channel subscription is likewise server-authorised, so a user
cannot subscribe to a room they are not a member of by guessing a `roomId` —
which, before Groups v2, is precisely how access control worked and did not.

### 5. Both transports coexist during transition

Socket.IO stays the default and stays wired. Centrifugo is opt-in per device.
There is no flag day: a device on `centrifugo` and a device on `socketio` must
still exchange messages, because they meet at the `RoomEvent` log and the
server-side publish path, not at the wire protocol.

## Consequences

- **Ephemeral events change shape.** Typing and presence are Socket.IO-shaped
  today; in Centrifugo they are channel publications with different delivery
  guarantees. The adapter normalises them, and anything relying on Socket.IO
  ordering must be found rather than assumed to be absent.
- **Recovery semantics differ per adapter.** Centrifugo can recover a missed
  stream from its own history; Socket.IO cannot and keeps using the `RoomEvent`
  cursor. Both are correct; they are not identical, and the UI must not assume
  one.
- **A new operational dependency.** Centrifugo is a process to run, configure
  and monitor. Until it is deployed the adapter is inert code behind a flag —
  which is honest, but means "Phase 2 is done" must not be read as
  "Centrifugo is serving traffic".
- **`msg-stack/centrifugo` is a reference clone, not a vendored dependency.**
  The deployment gets a pinned release image.

## Alternatives rejected

| Option | Why not |
|---|---|
| Socket.IO Redis adapter for scale-out | Solves (1) only; no history, positioning or recovery, and leaves the hand-rolled cursor as the sole replay path |
| Replace Socket.IO outright | A flag day on the message path of a live app, with no fallback, and no two-device test infrastructure yet |
| Let clients publish to Centrifugo directly | Bypasses group policy and `RoomEvent` persistence — reintroduces the "knowing a roomId is the whole access model" hole |
| Adapter owns encryption | Reintroduces V-19 by the most likely route available; see §2 |
