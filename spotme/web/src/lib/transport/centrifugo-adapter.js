/**
 * Spot Me — the Centrifugo adapter. ADR-002.
 *
 * THE PACKAGE IS `centrifuge`, NOT `centrifuge-js`. The latter does not exist
 * on npm; the brief named it and the name was corrected before any code was
 * written against it. See ADR-002, "Corrections to the brief".
 *
 * IT IS IMPORTED DYNAMICALLY, on purpose. Centrifugo is opt-in behind
 * `localStorage['spotme.transport']` and is not yet deployed. A static import
 * would put the SDK in every user's bundle and would make the whole app fail to
 * build on a machine that has not run `npm i centrifuge`. A dynamic import
 * turns "not installed" into "this transport is unavailable", which is the
 * truth, and lets the selector fall back to Socket.IO instead of a blank page.
 *
 * PUBLISHING DOES NOT GO TO THE BROKER. Centrifugo would accept a client
 * publication directly, and that would bypass the two things the NestJS gateway
 * does on every action: group policy (role, mute, ban) and appending to
 * RoomEvent, which is what makes offline replay work. So publish() POSTs to the
 * server, which authorises, persists, and then broadcasts. Client-side publish
 * must also be disabled in the Centrifugo channel config — an unused capability
 * is still a capability.
 *
 * NO KEY MATERIAL LIVES HERE (ADR-002 §2). `payload` is opaque base64 in and
 * opaque base64 out. Sealing and opening stay above the transport, and
 * test/transport.test.js fails if this file ever grows a key-shaped member.
 */
import { API_BASE } from '../api.js'
import { freshTokens } from '../socket-transport.js'
import { TransportStatus, TransportEvents } from './ITransportAdapter.js'

/** Channel naming. Kept in one place so the server's ACL can mirror it exactly. */
export const roomChannel = (roomId) => `room:${roomId}`

export function createCentrifugoAdapter ({ url } = {}) {
  let client = null
  let state = TransportStatus.IDLE
  const subs = new Map()   // roomId -> Centrifugo subscription

  /** Where the broker lives. Absent config is a normal "unavailable", not a crash. */
  const endpoint = url || import.meta.env?.VITE_CENTRIFUGO_URL || ''

  /** Our own short-lived connection JWT, minted by the backend. */
  async function connectionToken () {
    const { accessToken } = (await freshTokens()) || {}
    if (!accessToken) throw new Error('not signed in')
    const res = await fetch(`${API_BASE}/api/v2/realtime/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` }
    })
    if (!res.ok) throw new Error(`realtime token: HTTP ${res.status}`)
    const data = await res.json()
    if (!data?.token) throw new Error('realtime token: no token in response')
    return data.token
  }

  async function connect () {
    if (!endpoint) { state = TransportStatus.FAILED; throw new Error('VITE_CENTRIFUGO_URL is not set') }
    state = TransportStatus.CONNECTING

    let Centrifuge
    try {
      ({ Centrifuge } = await import('centrifuge'))
    } catch {
      state = TransportStatus.FAILED
      throw new Error('the `centrifuge` package is not installed — this transport is unavailable')
    }

    client = new Centrifuge(endpoint, {
      // getToken is called again on expiry, so a refresh needs no reconnect.
      getToken: connectionToken,
      // Centrifugo recovers a missed stream from its own history on reconnect.
      // Socket.IO cannot and keeps using the RoomEvent cursor — both are
      // correct, they are not identical, and nothing above may assume one.
      minReconnectDelay: 500,
      maxReconnectDelay: 20_000
    })

    client.on('connected', () => { state = TransportStatus.CONNECTED })
    client.on('connecting', () => { state = TransportStatus.RECONNECTING })
    client.on('disconnected', () => { state = TransportStatus.CLOSED })
    client.on('error', () => { state = TransportStatus.FAILED })

    await new Promise((resolve, reject) => {
      const cleanup = () => { client.off('connected', ok); client.off('error', bad) }
      const ok = () => { cleanup(); resolve() }
      const bad = (ctx) => { cleanup(); reject(new Error(`centrifugo: ${ctx?.error?.message || 'connect failed'}`)) }
      client.on('connected', ok)
      client.on('error', bad)
      client.connect()
    })
  }

  async function disconnect () {
    for (const [roomId, sub] of subs) {
      try { sub.unsubscribe(); sub.removeAllListeners?.() } catch { /* already gone */ }
      subs.delete(roomId)
    }
    try { client?.disconnect() } catch { /* already gone */ }
    client = null
    state = TransportStatus.CLOSED
  }

  /**
   * `password` is accepted and IGNORED — it exists only so the two adapters
   * share a call signature. Centrifugo never sees a room secret, and this
   * adapter would have nothing legitimate to do with one.
   */
  async function subscribe (roomId, { onRoomEvent, onPresence } = {}) {
    if (!client) throw new Error('subscribe: not connected')
    if (subs.has(roomId)) return subs.get(roomId)

    const channel = roomChannel(roomId)
    const sub = client.newSubscription(channel, {
      // Ask the server to replay what we missed rather than re-querying the
      // RoomEvent cursor for the whole room.
      recoverable: true,
      delta: 'fossil'
    })

    if (typeof onRoomEvent === 'function') {
      sub.on('publication', (ctx) => onRoomEvent(TransportEvents.ROOM_EVENT, ctx?.data, { recovered: false }))
    }
    if (typeof onPresence === 'function') {
      sub.on('join', (ctx) => onPresence(TransportEvents.PRESENCE, { userId: ctx?.info?.user, action: 'join' }))
      sub.on('leave', (ctx) => onPresence(TransportEvents.PRESENCE, { userId: ctx?.info?.user, action: 'leave' }))
    }
    // A recovered stream is replayed through the SAME handler as a live one, so
    // nothing downstream needs to know which it was — the flag is passed on for
    // callers that legitimately care.
    sub.on('subscribed', (ctx) => {
      if (ctx?.recovered && typeof onRoomEvent === 'function') {
        for (const pub of ctx.publications || []) {
          onRoomEvent(TransportEvents.ROOM_EVENT, pub?.data, { recovered: true })
        }
      }
    })

    sub.subscribe()
    subs.set(roomId, sub)
    return sub
  }

  async function unsubscribe (roomId) {
    const sub = subs.get(roomId)
    if (!sub) return
    try { sub.unsubscribe(); sub.removeAllListeners?.() } catch { /* already gone */ }
    subs.delete(roomId)
  }

  /** Through the server, never straight to the broker. See the header. */
  async function publish (roomId, frame) {
    const { accessToken } = (await freshTokens()) || {}
    if (!accessToken) throw new Error('publish: not signed in')
    const res = await fetch(`${API_BASE}/api/v2/realtime/centrifugo/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        roomId,
        type: frame?.type,
        payload: frame?.payload ?? '',
        meta: frame?.meta,
        target: frame?.target
      })
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error(body?.error || body?.message || `publish: HTTP ${res.status}`)
    }
    return res.json().catch(() => ({}))
  }

  async function presence (roomId) {
    const sub = subs.get(roomId)
    if (!sub?.presence) return []
    try {
      const { clients } = await sub.presence()
      return Object.values(clients || {}).map((c) => ({ userId: c?.user }))
    } catch {
      return []
    }
  }

  const status = () => state

  return {
    name: 'centrifugo',
    connect,
    disconnect,
    subscribe,
    unsubscribe,
    publish,
    presence,
    status
  }
}
