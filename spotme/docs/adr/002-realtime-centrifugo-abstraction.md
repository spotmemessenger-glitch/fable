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
  room key.
- `setRoomKeyProvider` / `clearRoomKey` remain the only way a key enters the
  system, for every adapter.
- `test/transport.test.js` asserts that no adapter exposes a key-shaped
  surface, so this is enforced by a failing test rather than by this paragraph.

#### CORRECTION (2026-07-31): sealing is BELOW the adapter, not above it

This section originally said "sealing and opening stay above the transport".
That is what the design intends and **not** what the code does, which matters
enough to write down rather than quietly restate.

AES-GCM `seal`/`open` live *inside* `socket-transport.js` (`sendAction`,
`dispatch`). `SocketIOAdapter` **wraps** that module, so on the Socket.IO path
the crypto sits underneath the adapter and everything is correctly sealed.
`CentrifugoAdapter` wraps nothing — its `publish()` POSTs `frame.payload`
straight through. Pointing the chat path at `createTransport()` and selecting
`centrifugo` would therefore send **plaintext** to the server: V-19 again,
through a door `FORBIDDEN_KEY_SURFACE` cannot watch, because that test asserts
an adapter holds *no* key and a keyless adapter satisfies it trivially.

Consequences, all of which are in the code today:

- `web/src/lib/transport/room.js` is the seam every screen goes through. It
  resolves the transport from `localStorage['spotme.transport']` in one place
  and, when asked for `centrifugo`, falls back to Socket.IO **loudly** — the
  reason string names plaintext, and `activeTransport()` reports it.
- `test/transport-seam.test.js` pins the hazard directly: it feeds
  `CentrifugoAdapter.publish()` readable text and asserts that exact text
  reaches the wire. If someone adds sealing to the adapter, that check fails,
  and that failure is the signal to revisit the seam.
- **Phase 3 must lift `seal`/`open` above the transport before Centrifugo can
  carry a message.** That is a refactor of the message layer, not a wiring
  change, and it — not the broker deployment — is the real prerequisite.

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

#### IMPLEMENTED 2026-07-31 — and how "the same path" was made literal

This endpoint returned a hard 501 until now, because `policy()` and `refuse()`
were **private methods on `RoomsGateway`** and the only way to authorise an HTTP
publication was to write a second copy. A second authorisation path that starts
identical and drifts is exactly how the "gateway authorised NOTHING" hole gets
reopened through a new door, so the refusal was the correct answer at the time.

Both are now `RoomsAuthService` (`rooms/rooms-auth.service.ts`), exported by
`RoomsModule` and injected into both callers — the *same provider instance*, not
a shared shape. `EPHEMERAL` moved to `RoomsService` alongside `isPersisted` for
the same reason: two lists of what may cross the wire would drift.

The route's order is broker-config → shape → membership → policy → persistence →
broadcast. Membership is the `RoomMember` row that `join` writes, because HTTP
has no join handshake to lean on. Persisting before the broker is known to be
reachable would append events nobody receives.

Verified by running, against the local backend on `:4100`:

| Case | Result |
|---|---|
| no token | **401** |
| authed, broker unconfigured | **503** `centrifugo is not configured` |
| authed, not a `RoomMember` | **403** `not a member of this room` |
| unknown action type | **400** `unknown action type: exfiltrate` |
| member, `type: msg` | **200** `{"seq":2196}`, one `RoomEvent` row written |
| member, `type: typing` | **200** `{}`, **no** row — ephemeral stays ephemeral |
| **muted group member** | **403** `you are muted in this group` |
| broker answers 200 + `{error}` | **503**, not reported as delivery |

The muted-member row is the one that matters: that string is the gateway's own
wording, produced by the gateway's own code, on the HTTP path.

**The broker was a stub** speaking Centrifugo's `POST /api/publish` dialect —
Centrifugo is not deployed, so the 200 path cannot be proven against the real
thing. The controller ran unmodified; only the broker underneath was simulated.
The stub recorded channel `room:<roomId>` and a frame identical in shape to the
gateway's `action` emit.

Known gaps, deliberately not filled: no push notification on this path (the
gateway skips push for users holding a live socket, and presence here lives in
the broker); `meta.burn` view-once destruction is socket-path only; and Express
caps a JSON body at 100kb, well under the 8MB the socket allows, so attachment
slices need a raised limit before media can travel this way.

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

## Alternatives considered

### A. Raw WebSockets (`ws` server + browser `WebSocket`)

Drop both Socket.IO and Centrifugo and speak WebSocket directly.

**For:** no broker to operate, no client SDK, smallest possible dependency
surface, and full control of the frame format — which matters here, because the
base64-not-Buffer rule already exists precisely because a framing detail cost a
day.

**Against, and decisive:** everything Socket.IO currently gives free would have
to be rebuilt and then *debugged in production* — reconnection with backoff,
heartbeat/liveness, multiplexing many rooms over one socket, message
acknowledgement, and browser fallback where WebSocket is blocked by a corporate
proxy. None of that is hard in isolation; all of it is where realtime systems
actually break, and none of it addresses bottleneck (1), the in-process room
map. Raw WebSockets is a *smaller* system, not a more scalable one. It would
also mean writing our own history/recovery, which is the second thing we are
trying to stop hand-rolling.

**Rejected:** maximum effort, maximum new bug surface, and it solves neither
stated problem.

### B. Socket.IO Redis adapter (`@socket.io/redis-adapter`)

Keep Socket.IO, add the Redis adapter so several Node instances share a room.

**For:** by far the smallest diff. No new client SDK, no new protocol, no new
service to expose publicly, and the existing gateway code is untouched. It
genuinely fixes bottleneck (1).

**Against:** it fixes *only* (1). There is still no channel history, no stream
positioning and no recovery — a reconnecting client still re-queries the
`RoomEvent` cursor for the whole room, and ephemeral events are still lost on
every drop. It also does nothing for (3). And it adds Redis as a hard
availability dependency for message fan-out, where today a single instance
either works or is down.

**Rejected as the destination, but explicitly retained as the cheap fallback:**
if Centrifugo proves not worth operating, this is the smaller move that still
unblocks horizontal scale. It is a real option, not a straw man.

### C. Centrifugo behind a transport interface — chosen

Purpose-built broker: channels, JWT connection auth, history with positioning
and recovery, and horizontal scale via a Redis or Nats engine.

**Against, honestly:** a new service to run, monitor and secure; a second wire
protocol to reason about; and the client SDK is a real dependency (see below).
It is more moving parts than (B).

**Chosen because** the interface makes the decision reversible. Both transports
coexist, selection is per-device, and if Centrifugo is a mistake we fall back to
(B) or stay on Socket.IO without touching a line of message-handling code.

### D. Others rejected outright

| Option | Why not |
|---|---|
| Replace Socket.IO outright, no interface | A flag day on the message path of a live app, with no fallback, and no two-device test infrastructure yet |
| Let clients publish to Centrifugo directly | Bypasses group policy and `RoomEvent` persistence — reintroduces the "knowing a roomId is the whole access model" hole |
| Adapter owns encryption | Reintroduces V-19 by the most likely route available; see §2 |

## Dependency analysis — `centrifuge` 5.7.0

Verified against the registry on 2026-07-31, not assumed. **Two claims commonly
made about this package are wrong and are corrected here**, because a design doc
that repeats a comfortable number is how the number survives into a decision.

| Property | Verified value |
|---|---|
| Package name | **`centrifuge`** — `centrifuge-js` does NOT exist on npm. The confusion is understandable: the GitHub repo *is* `centrifugal/centrifuge-js`. |
| Version / licence | 5.7.0, **MIT** — no copyleft exposure, unlike much of `msg-stack/` |
| Runtime dependencies | **`events` and `protobufjs` — it is NOT zero-dependency** |
| Last publish | 2026-06-15 (~6 weeks before this ADR), 100 published versions — actively maintained, not abandoned |

**On the "~15KB gzipped, zero dependencies" claim — both parts are false as
stated, but the practical outcome is close to the spirit of it:**

- `dist.unpackedSize` is **3.85 MB**. That figure covers CJS + ESM + protobuf
  builds + type definitions + sourcemaps, and is *not* the browser payload.
- The `exports` map has two entries: `.` (default, JSON protocol) and
  `./build/protobuf`. **`protobufjs` is only reachable through the second
  one.** Our adapter does `await import('centrifuge')` — the default JSON
  path — so a bundler tree-shakes protobufjs out entirely. The `browser` field
  maps `events` to a shim.
- **The real gzipped delta is therefore small but UNMEASURED.** Do not quote a
  number until it is: install it, build, and diff `dist/assets/index-*.js`
  against the current 354 kB / 115 kB gzipped baseline. That is a two-minute
  check and it beats a figure copied from a README.

**Security posture:** MIT, maintained, no native code, no postinstall script.
The dependency is loaded via **dynamic `import()`**, so a device that never
selects the Centrifugo transport never executes it — the blast radius of a
future advisory is limited to opted-in devices. Run `npm audit` at install
time; it has not been run, because the package is not installed.

**Conclusion:** justified, but **not yet added**. The adapter is written against
it and degrades to "this transport is unavailable" when it is missing, which is
why nothing is installed for a broker that is not deployed.

## Bottleneck and horizontal scaling strategy

### Where it breaks today

| Layer | Limit | Why |
|---|---|---|
| **Node.js event loop** | One core per instance | Node is single-threaded for JS. Fan-out, JSON serialisation and `RoomEvent` writes all contend for the same loop; a slow Prisma call delays unrelated sockets. Vertical scale stops at one core's throughput. |
| **In-process room map** | Hard ceiling of 1 instance | `Map<roomId, Map<userId, Set<Socket>>>` lives in memory and fan-out is `client.to('r:'+roomId)`. **Two instances each see half a room and neither knows.** This is not a tuning limit — the topology forbids adding a second instance at all. |
| **Socket memory** | ~10s of thousands/instance | Each Socket.IO connection carries engine.io state, buffers and a JS object graph. |
| **Presence** | One global lobby room | Every nearby-discovery client in one room; fan-out is O(users) per event. The Phase 0 audit already flagged this as needing geo-sharding. |

The binding constraint is the **second row**, and no amount of hardware moves it.

### The strategy

1. **Move fan-out off Node.** Centrifugo is Go — goroutines and real parallelism
   across cores, with connections held in a process built for holding
   connections rather than one also running Prisma and business logic. Its
   memory per connection is materially lower than an engine.io socket's.
2. **Make the Node tier stateless.** Once fan-out belongs to the broker, the
   NestJS instances hold no room state, and *that* is what makes them
   horizontally scalable — the scaling win comes from removing state, not from
   adding Centrifugo.
3. **Scale the broker with an engine.** A single Centrifugo node uses its
   in-memory engine; multiple nodes need **Redis or Nats** so a publication on
   node A reaches a subscriber on node B. That engine becomes a hard
   availability dependency for fan-out and must be planned for, not discovered.
4. **Shard presence by geography**, using `h3` cells as the channel key
   (Apache-2.0, already cloned at `geo-stack/h3`). This is the fix for row four
   and is independent of the transport choice.

**Deliberately unquantified:** no number here is measured. Connection ceilings,
memory per connection and fan-out latency depend on message size, room fan-out
and hardware, and Centrifugo is not deployed. The §"Performance targets"
(reconnect < 2s, presence < 500ms, zero dropped messages post-ack) are
**targets, not results** — treat any claim otherwise as unverified.

## Rollback strategy

The interface exists so this decision is reversible without a deploy.

**Per device, immediately — no release, no server change:**

```js
localStorage.setItem('spotme.transport', 'socketio')
```

Takes effect on the next connect. `createTransport()` reads the flag on every
call, so a reload is enough; nothing is cached across it.

**Rollback is also automatic.** `createTransport()` catches a failed Centrifugo
connect and returns the Socket.IO adapter instead — a dead broker degrades the
app rather than killing it. Critically, it returns `{ requested, actual, reason }`,
so a fallback is **visible** rather than inferred: you cannot believe you are
testing Centrifugo when you are not. Silent fallback would be worse than no
fallback.

**Fleet-wide, without touching clients:** stop returning tokens. With
`CENTRIFUGO_TOKEN_HMAC_SECRET_KEY` unset, `POST /api/v2/realtime/token` answers
**503**, every Centrifugo connect fails, and every device falls back on its next
connect. One environment variable is the kill switch.

**What rollback does NOT undo:** nothing. Socket.IO is never modified or
removed, `rooms.gateway.ts` is untouched, and no data written under one
transport is unreadable under the other — both meet at the `RoomEvent` log, not
at the wire protocol. There is no migration to reverse, which is the property
that makes this safe to try.

**If Centrifugo is abandoned entirely**, alternative (B) — the Socket.IO Redis
adapter — remains available and still fixes the one bottleneck that blocks
horizontal scale.
