/**
 * Spot Me — call media over LiveKit. ADR-003.
 *
 * WHAT THIS REPLACES, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * A call has two halves. SIGNALLING — ring, accept, decline, hang up — is four
 * tiny JSON messages already carried by the room transport, sealed like every
 * other action, and it works. MEDIA is the half that breaks: two phones behind
 * Indian carrier NAT frequently cannot form a peer connection at all.
 *
 * Only the media half moves here. `rooms.js` still sends and receives the same
 * call actions in the same order; when this path is active, the step that used
 * to be `conn.net.addStream(local)` becomes "join a LiveKit room and publish",
 * and the remote stream arrives through the same `onStream` handler as before.
 * The state machine, the UI and the signalling are untouched.
 *
 * That boundary is the entire reason this is a small file. Moving signalling
 * here too would mean a second implementation of ring/accept/busy semantics
 * that has to agree with the first — the "second implementation becomes an
 * emulator of the first" failure ADR-002 named for transports.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SFU AT ALL — the honest trade
 *
 * A peer-to-peer call is private in a way this is not: with LiveKit, media is
 * decrypted at the SFU. Frames are TLS-protected in transit and LiveKit does
 * not store them, but the server can see them, which the P2P path made
 * impossible. That is a real reduction and ADR-003 states it plainly rather
 * than burying it. It buys calls that connect on networks where P2P cannot,
 * and it is the precondition for group calls, which a P2P mesh cannot carry
 * past three or four participants on a phone.
 *
 * End-to-end encrypted media is possible here later (LiveKit supports
 * insertable streams with an external key), and ADR-003 records it as the
 * upgrade path. It is NOT wired now, and nothing in this file should be read as
 * claiming otherwise.
 *
 * ---------------------------------------------------------------------------
 * GROUP CALLS
 *
 * The abstraction is already a room with N participants: `onRemoteStream` is
 * called with `(stream, identity)` for every remote publisher, and
 * `onParticipantLeft` for every departure. An SFU does not care whether that N
 * is one or eight. What is missing for group is not in this file — it is the
 * caller: `rooms.js` keeps a single `call.remote`, and the UI renders one
 * remote video. See ADR-003 §Group for the short list.
 */

import { API_BASE } from '../api.js'
import { authHeaders } from '../auth-headers.js'
import { noteCallPath } from './select.js'

/** How long we wait for the SFU before declaring the call unconnectable. */
const CONNECT_TIMEOUT_MS = 15_000

/**
 * Ask the server whether LiveKit exists on this deployment.
 *
 * Cached for the tab: the answer is deployment config, not per-call state, and
 * asking on every call would put a network round trip in front of the ring.
 * A failure caches as `false` — a caller must fall back rather than retry.
 */
let configPromise = null
export function livekitAvailable () {
  if (!configPromise) {
    configPromise = authHeaders()
      .then((headers) => fetch(`${API_BASE}/api/v2/calls/config`, { headers }))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => Boolean(j?.available))
      .catch(() => false)
  }
  return configPromise
}

/**
 * ICE servers for the SFU leg.
 *
 * LiveKit ships its own TURN, but a client that can only reach the internet
 * over TLS/443 still needs a relay it can actually reach — which is what the
 * Metered entry from /api/turn provides (see api/turn.js for the ordering).
 * Handing these to LiveKit MERGES them with its defaults rather than replacing
 * them, so this adds reachability and removes none.
 *
 * Failure is non-fatal: LiveKit's own ICE config is usually enough, and a call
 * that could have connected must not be refused because a credential mint was
 * slow.
 */
async function iceServers () {
  try {
    const res = await fetch(`${API_BASE}/api/turn`)
    if (!res.ok) return []
    const json = await res.json()
    return Array.isArray(json?.iceServers) ? json.iceServers : []
  } catch {
    return []
  }
}

/**
 * A short-lived, room-scoped join token for THIS user.
 *
 * The server derives the LiveKit room name from `roomId` and checks membership
 * before minting — this call carries no identity of its own beyond the bearer
 * token, and deliberately cannot ask for a different room than the one it names.
 */
async function mintToken (roomId) {
  const res = await fetch(`${API_BASE}/api/v2/calls/token`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ roomId })
  })
  if (!res.ok) throw new Error(`call token refused: HTTP ${res.status}`)
  const json = await res.json()
  if (!json?.token || !json?.url) throw new Error('call token response was incomplete')
  return json
}

/**
 * Join the media room for a conversation and publish a local stream.
 *
 * Returns a handle: `{ room, stats, disconnect }`. The caller keeps it for the
 * duration of the call and calls `disconnect()` exactly once, in teardown.
 *
 * @param {object}      options
 * @param {string}      options.roomId              Spot Me conversation room id
 * @param {MediaStream} options.localStream         already-acquired mic/camera
 * @param {function}    options.onRemoteStream      (stream, identity) => void
 * @param {function}    [options.onParticipantLeft] (identity) => void
 * @param {function}    [options.onFailed]          (error) => void, after connect
 */
export async function joinCallMedia ({
  roomId,
  localStream,
  onRemoteStream,
  onParticipantLeft,
  onFailed
}) {
  /**
   * Timings, kept because "the call took a while to connect" is otherwise
   * unattributable. The SDK download, the token round trip and the ICE
   * negotiation fail for entirely different reasons and are fixed in entirely
   * different places; one number for all three tells you nothing.
   */
  const timings = {}
  const mark = async (name, work) => {
    const t0 = Date.now()
    try {
      return await work()
    } finally {
      timings[name] = Date.now() - t0
    }
  }

  // Dynamic so the SDK is a separate chunk: a user who never enables the flag
  // never downloads it, and the default path pays nothing for this file
  // existing.
  const { Room, RoomEvent } = await mark('sdkMs', () => import('livekit-client'))

  const [{ token, url }, ice] = await mark('tokenMs', () =>
    Promise.all([mintToken(roomId), iceServers()]))

  const room = new Room({
    adaptiveStream: true,
    // Drop layers nobody is watching. On a 1:1 call this is nearly a no-op; on
    // a group call it is the difference between a phone keeping up and not.
    dynacast: true,
    ...(ice.length ? { rtcConfig: { iceServers: ice } } : {})
  })

  const startedAt = Date.now()

  /**
   * ONE MediaStream per remote participant, carrying all of their tracks.
   *
   * LiveKit subscribes each track separately and hands each one its own
   * MediaStream — audio arrives in one event, video in another. The caller
   * (`rooms.js`) keeps a single `call.remote` and assigns whatever it is given,
   * so emitting two different streams means the second silently replaces the
   * first: attach the video-only stream and the call goes mute, attach the
   * audio-only one and the picture never appears.
   *
   * The two-browser harness caught exactly this — it reported `remote tracks:
   * video` on a call whose audio was demonstrably flowing. Keeping one stream
   * per participant and adding tracks to it means the object identity never
   * changes, so a caller that assigns it twice is assigning the same thing.
   */
  const streams = new Map()

  const streamFor = (identity) => {
    let stream = streams.get(identity)
    if (!stream) {
      stream = new MediaStream()
      streams.set(identity, stream)
    }
    return stream
  }

  room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    const identity = participant?.identity
    const stream = streamFor(identity)
    stream.addTrack(track.mediaStreamTrack)
    onRemoteStream?.(stream, identity)
  })

  room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
    const stream = streams.get(participant?.identity)
    if (!stream) return
    try { stream.removeTrack(track.mediaStreamTrack) } catch { /* already gone */ }
  })

  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    streams.delete(participant?.identity)
    onParticipantLeft?.(participant?.identity)
  })

  // A call that dies after connecting must say so. Silence here is the failure
  // mode where a frozen picture reads as "they went quiet".
  room.on(RoomEvent.Disconnected, (reason) => {
    if (Date.now() - startedAt > 1000) {
      onFailed?.(new Error(`call ended: ${reason ?? 'disconnected'}`))
    }
  })

  await mark('connectMs', () => room.connect(url, token, { autoSubscribe: true, maxRetries: 2 }))

  // Publish what the caller already captured rather than asking LiveKit to open
  // the devices itself. `rooms.js` acquired this stream before ringing, the UI
  // is already previewing it, and a second getUserMedia would prompt twice and
  // can fail outright on a device with one camera.
  await mark('publishMs', async () => {
    for (const track of localStream.getTracks()) {
      await room.localParticipant.publishTrack(track)
    }
  })

  return {
    room,
    timings,

    /**
     * How this call actually connected, and whether media is arriving.
     *
     * MEASURED, NOT INFERRED. What candidates were OFFERED says nothing about
     * which pair carried media, and "we configured a relay" is precisely the
     * claim that must not be mistaken for "a relay was used". Likewise
     * `framesDecoded` rather than "a track object arrived": a subscribed track
     * that never decodes a frame is the black rectangle users report as "it
     * connected but I can't see anything".
     *
     * Read through the SDK's PUBLIC surface — `remoteParticipants` and
     * `track.getRTCStatsReport()`. An earlier version reached into
     * `room.engine.pcManager.subscriber.pc`, which does not exist under that
     * name in livekit-client 2.x; the harness then reported a working call as
     * a total failure. Private internals make a diagnostic that lies after an
     * SDK bump, which is worse than no diagnostic.
     *
     * Note what "direct" means with an SFU: client-to-SERVER direct. Even then
     * it is not peer-to-peer — it is the second hop that is absent.
     */
    async stats () {
      const out = {
        connectedMs: Date.now() - startedAt,
        relay: null,
        localCandidateType: null,
        remoteCandidateType: null,
        protocol: null,
        framesDecoded: 0,
        audioBytes: 0,
        videoBytes: 0
      }

      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) {
          const report = await publication.track?.getRTCStatsReport?.()
          if (!report) continue
          for (const entry of report.values()) {
            if (entry.type === 'inbound-rtp') {
              if (entry.kind === 'video') {
                out.framesDecoded += entry.framesDecoded || 0
                out.videoBytes += entry.bytesReceived || 0
              } else if (entry.kind === 'audio') {
                out.audioBytes += entry.bytesReceived || 0
              }
            }
            if (entry.type === 'candidate-pair' && entry.state === 'succeeded' && entry.nominated) {
              const local = report.get(entry.localCandidateId)
              const remote = report.get(entry.remoteCandidateId)
              if (local) {
                out.relay = local.candidateType === 'relay'
                out.localCandidateType = local.candidateType ?? null
                out.protocol = local.protocol ?? null
              }
              if (remote) out.remoteCandidateType = remote.candidateType ?? null
            }
          }
        }
      }
      return out
    },

    async disconnect () {
      try {
        await room.disconnect()
      } catch {
        // Already gone. Teardown must never throw — it runs from the same path
        // that handles a call the other side already ended.
      }
    }
  }
}

/**
 * Connect media for a call, falling back to the peer-to-peer path if LiveKit
 * cannot serve it.
 *
 * Returns a handle, or null meaning "use the legacy path". Null is not an
 * error state — it is the default for every device without the flag — but when
 * it follows a REQUEST for LiveKit the reason is recorded and logged, because
 * a silent downgrade is how someone comes to believe they tested this.
 */
export async function connectCallMedia (options) {
  if (!(await livekitAvailable())) {
    noteCallPath('livekit', 'webrtc-p2p',
      'livekit is not configured on this deployment (LIVEKIT_URL / LIVEKIT_API_KEY / ' +
      'LIVEKIT_API_SECRET unset); this call used the peer-to-peer path')
    return null
  }

  try {
    const handle = await withTimeout(joinCallMedia(options), CONNECT_TIMEOUT_MS)
    noteCallPath('livekit', 'livekit')
    return handle
  } catch (error) {
    noteCallPath('livekit', 'webrtc-p2p',
      `livekit media failed (${error?.message || error}); this call used the peer-to-peer path`)
    return null
  }
}

function withTimeout (promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`livekit did not connect within ${ms}ms`)), ms))
  ])
}
