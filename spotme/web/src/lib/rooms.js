/**
 * Spot Me — room connection manager.
 *
 * Keeps a live connection (plus its message store) for every non-archived
 * conversation while the app is open, so messages land, unread counts rise
 * and previews update no matter which screen is showing. The chat view talks
 * to conversations exclusively through this module.
 *
 * Demo conversations get a local bot with the same interface as the real
 * transport, so every screen behaves identically either way.
 */
import { createNet, randomId } from '../net.js'
import { createStore } from '../store.js'
import { db, ROOM_PREFIX } from './db.js'
import { pushNote } from './notify.js'

/** Attachments bigger than this never ride the history backlog — the bytes
 * are lazily fetched on demand instead, so reconnects stay instant. */
const DETACH_BYTES = 4096

function dataURLToBuffer (dataURL) {
  const comma = dataURL.indexOf(',')
  const mime = dataURL.slice(5, dataURL.indexOf(';'))
  const binary = atob(dataURL.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return { buffer: bytes.buffer, mime }
}

function bufferToDataURL (payload, mime) {
  const bytes = payload instanceof ArrayBuffer ? new Uint8Array(payload) : new Uint8Array(payload.buffer || payload)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

/** Legacy demo conversations in old storage — inert, never networked. */
function inertNet () {
  const noop = () => {}
  return {
    sendMessage: noop, sendReaction: noop, sendProfile: noop, sendDelete: noop,
    sendTyping: noop, sendRead: noop, sendSeen: noop, sendCall: noop, sendLocup: noop,
    sendBinary: () => Promise.resolve(),
    fetchFrom: () => Promise.resolve(null),
    addStream: noop, removeStream: noop, replaceTrack: noop,
    peerIds: () => [], peerCount: () => 0, leave: noop
  }
}

const connections = new Map()   // roomId -> conn

/* How long a freshly joined room is left alone before "no peers" is allowed to
 * mean "dead". Finding anyone over public trackers took ~25s when measured, so
 * a shorter window would tear down rooms that were still handshaking. */
const REJOIN_GRACE_MS = 45_000

// Debug/test handle (same spirit as window.__lobby): lets automated tests
// drive sends without the file picker. Carries no secrets beyond what the
// user's own console already has access to.
if (typeof window !== 'undefined') {
  Promise.resolve().then(() => { window.__rooms = rooms })
}

function preview (message) {
  switch (message.kind) {
    case 'image': return message.viewOnce ? 'Private photo' : 'Photo'
    case 'voice': return `Voice note (${message.dur || 0}s)`
    case 'video': return 'Video'
    case 'file': return message.fileName || 'File'
    case 'location': return message.live ? 'Live location' : 'Location'
    case 'system': return message.sys === 'timer'
      ? (message.secs ? '⏱ Timer messages on' : '⏱ Timer messages off')
      : ''
    default: return message.text
  }
}

/** A 'timer' control message sets the per-chat disappearing-message mode —
 * WhatsApp semantics: either side can change it, both sides obey it. */
function applyTimerControl (roomId, message) {
  if (message.kind === 'system' && message.sys === 'timer') {
    db.upsertConvo({ roomId, msgTtl: message.secs || 0 })
  }
}

function createConnection (convo) {
  const store = createStore(convo.roomId, ROOM_PREFIX)
  const listeners = new Set()
  const seenByPeer = new Set()   // my view-once messages the peer has opened
  const timers = new Map()       // message id -> ttl timer

  const conn = {
    roomId: convo.roomId,
    store,
    net: null,
    peerCount: 0,
    typing: null,                // {name, until}
    readUpTo: 0,
    seenByPeer,
    call: { state: 'idle', video: false, local: null, remote: null },
    on (fn) { listeners.add(fn); return () => listeners.delete(fn) }
  }

  function emit (event) { for (const fn of listeners) fn(event) }

  /**
   * Timer-deleted messages are removed by every client that received them.
   * Cooperative, like everything ephemeral in P2P — the setting still gives
   * honest value: both standard clients clean up on schedule.
   */
  function scheduleTtl (message) {
    if (!message.ttl || timers.has(message.id)) return
    const deadline = message.ts + message.ttl * 1000
    const wait = Math.max(0, deadline - Date.now())
    timers.set(message.id, setTimeout(() => {
      store.remove(message.id)
      timers.delete(message.id)
      emit({ type: 'expired', id: message.id })
    }, wait))
  }

  function sweepExpired () {
    const now = Date.now()
    for (const message of store.list()) {
      if (message.ttl && message.ts + message.ttl * 1000 <= now) store.remove(message.id)
      else if (message.ttl) scheduleTtl(message)
    }
  }

  function onIncoming (message) {
    db.bump(convo.roomId, { text: preview(message), ts: message.ts, fromMe: false })
    applyTimerControl(convo.roomId, message)
    scheduleTtl(message)
    pushNote(convo.title || convo.peer?.name || 'New message', preview(message),
      `msg:${convo.roomId}`, { throttleMs: 15_000 })
    emit({ type: 'message', message })
  }

  const handlers = {
    profile: () => {
      const p = db.profile()
      // About rides the handshake (WhatsApp semantics); the phone number
      // never does — it is unverified and stays on the device.
      // The picture rides too: it is how the other side learns you have one.
      return { id: p.id, name: p.name, lang: p.lang, about: p.about || '', avatar: p.avatar || null }
    },
    onMessage (payload) {
      if (store.add(payload)) onIncoming(payload)
    },
    onHistory (messages) {
      const added = store.mergeHistory(messages)
      if (added > 0) {
        // Backlog updates the preview but is not "unread" — it may be old.
        const latest = store.list().at(-1)
        if (latest) {
          const convoNow = db.convo(convo.roomId)
          if (!convoNow?.last || latest.ts > convoNow.last.ts) {
            db.bump(convo.roomId, { text: preview(latest), ts: latest.ts, fromMe: latest.from === db.profile().id })
            db.clearUnread(convo.roomId)
          }
        }
        sweepExpired()
        emit({ type: 'history' })
      }
    },
    onReaction (payload) { store.addReaction(payload); emit({ type: 'reaction', payload }) },
    /**
     * The peer's name and picture, refreshed on every reconnect.
     *
     * Without this they are frozen at whatever was known when the chat was
     * created — and a chat started from username search is created with no
     * avatar at all, so the other person stayed a coloured initial forever
     * however many pictures they set.
     */
    onProfile (payload, peerId) {
      store.addProfile(peerId, payload)
      const current = db.convo(convo.roomId)
      if (!current || current.kind === 'group' || !payload?.name) return
      const peer = current.peer || {}
      const next = {
        ...peer,
        id: peer.id || payload.id || null,
        name: payload.name,
        lang: payload.lang || peer.lang || 'en',
        avatar: payload.avatar || peer.avatar || null
      }
      if (next.name === peer.name && next.avatar === peer.avatar && next.id === peer.id) return
      db.upsertConvo({ roomId: convo.roomId, peer: next })
      // Refresh an existing contact card, but never create one — adding a
      // contact stays the owner's deliberate act.
      if (next.id && db.contacts().some((c) => c.id === next.id)) db.addContact(next)
      emit({ type: 'peer', peer: next })
    },
    /** The sender corrected their text — patch it in place and mark it. */
    onEdit (payload) {
      if (!payload?.id || typeof payload.text !== 'string') return
      const target = store.list().find((m) => m.id === payload.id)
      // Only the author may rewrite their own words.
      if (!target || target.from !== payload.from) return
      store.patch(payload.id, { text: payload.text, editedAt: payload.editedAt || Date.now() })
      const latest = store.list().at(-1)
      if (latest?.id === payload.id) {
        db.bump(convo.roomId, { text: preview(latest), ts: latest.ts, fromMe: false })
      }
      emit({ type: 'edited', id: payload.id })
    },
    onDelete (payload) {
      if (payload?.id && store.remove(payload.id)) emit({ type: 'deleted', id: payload.id })
    },
    onTyping (payload) {
      conn.typing = payload?.on ? { name: payload.name || '', kind: payload.kind || 'typing', until: Date.now() + 4000 } : null
      emit({ type: 'typing' })
    },
    onRead (payload) {
      if (payload?.upTo > conn.readUpTo) {
        conn.readUpTo = payload.upTo
        emit({ type: 'read' })
      }
    },
    onSeen (payload) {
      if (payload?.id) {
        seenByPeer.add(payload.id)
        emit({ type: 'seen', id: payload.id })
      }
    },
    onPeers (count) {
      // Track when the peer was last connected, so the header can say
      // "Last seen 14:32" instead of a vague waiting message.
      if (count > 0 || conn.peerCount > 0) {
        db.upsertConvo({ roomId: convo.roomId, peerSeen: Date.now() })
      }
      /**
       * Their presence in THIS room is proof they accepted: nobody else knows
       * its id and secret. The lobby's 'acc' signal is a single best-effort
       * message that is simply lost if the two are not connected there at that
       * instant — which left the requester stuck on "waiting" even after the
       * other person had accepted and was sitting in the room.
       */
      if (count > 0) {
        if (db.convo(convo.roomId)?.pending) {
          db.upsertConvo({ roomId: convo.roomId, pending: false })
        }
        /* Every successful connection files them as a contact, not just the
         * one that cleared a pending flag. Connecting IS the introduction, so
         * being asked to request someone a second time — after having already
         * talked to them — is the app forgetting a person it has met. */
        if (convo.peer?.id && convo.kind !== 'group') db.addContact(convo.peer)
      }
      conn.peerCount = count
      emit({ type: 'peers', count })
    },
    /** Attachment bytes arrived; envelope rides in metadata. */
    onBinary (payload, context) {
      const meta = context?.metadata
      if (!meta?.id) return
      const message = { ...meta, data: bufferToDataURL(payload, meta.mime || 'application/octet-stream') }
      delete message.mime
      if (store.add(message)) {
        emit({ type: 'rxdone', id: meta.id })
        onIncoming(message)
      }
    },
    onBinaryProgress (progress, context) {
      const meta = context?.metadata
      if (meta?.id) emit({ type: 'rxprogress', id: meta.id, progress, meta })
    },
    /** A peer asks for bytes we hold (lazy fetch of detached attachments). */
    onFetch (data) {
      const m = data?.id ? store.list().find((x) => x.id === data.id) : null
      if (!m?.data) return null
      if (m.viewOnce && seenByPeer.has(m.id)) return null
      return dataURLToBuffer(m.data).buffer
    },
    /** A live-location share moved (or ended) — patch the message in place. */
    onLocup (payload) {
      if (!payload?.id) return
      if (payload.stop) store.patch(payload.id, { live: false })
      else store.patch(payload.id, { lat: payload.lat, lon: payload.lon })
      emit({ type: 'locup', id: payload.id })
    },
    onCall (payload) {
      const call = conn.call
      switch (payload?.type) {
        case 'offer':
          if (call.state !== 'idle') { conn.net.sendCall({ type: 'decline', busy: true }); return }
          conn.call = { state: 'ringing-in', video: Boolean(payload.video), local: null, remote: null }
          emit({ type: 'call' })
          break
        case 'accept':
          if (call.state === 'ringing-out' && call.local) {
            conn.net.addStream(call.local)
            call.state = call.remote ? 'active' : 'connecting'
            emit({ type: 'call' })
          }
          break
        case 'decline':
          teardownCall(false)
          emit({ type: 'call', declined: true, busy: Boolean(payload.busy) })
          break
        case 'end':
          teardownCall(false)
          emit({ type: 'call', ended: true })
          break
      }
    },
    onStream (stream) {
      conn.call.remote = stream
      if (conn.call.local) conn.call.state = 'active'
      emit({ type: 'call' })
    }
  }

  function teardownCall (notifyPeer = true) {
    const { local, state } = conn.call
    if (local) {
      try { conn.net.removeStream(local) } catch { /* not added yet */ }
      local.getTracks().forEach((t) => t.stop())
    }
    if (notifyPeer && state !== 'idle') conn.net.sendCall({ type: 'end' })
    conn.call = { state: 'idle', video: false, local: null, remote: null }
  }

  /** Ring the peer. Media is only attached once they accept. */
  conn.startCall = async function (video) {
    if (conn.call.state !== 'idle') return
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Calls need HTTPS (use the vercel.app address)')
    const local = await navigator.mediaDevices.getUserMedia({ audio: true, video })
    conn.call = { state: 'ringing-out', video, local, remote: null }
    conn.net.sendCall({ type: 'offer', video })
    emit({ type: 'call' })
  }

  conn.acceptCall = async function () {
    if (conn.call.state !== 'ringing-in') return
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Calls need HTTPS (use the vercel.app address)')
    const local = await navigator.mediaDevices.getUserMedia({ audio: true, video: conn.call.video })
    conn.call.local = local
    conn.net.sendCall({ type: 'accept', video: conn.call.video })
    conn.net.addStream(local)
    conn.call.state = conn.call.remote ? 'active' : 'connecting'
    emit({ type: 'call' })
  }

  conn.declineCall = function () {
    if (conn.call.state === 'ringing-in') conn.net.sendCall({ type: 'decline' })
    teardownCall(false)
    emit({ type: 'call' })
  }

  conn.endCall = function () {
    teardownCall(true)
    emit({ type: 'call' })
  }

  conn.toggleMute = function () {
    const track = conn.call.local?.getAudioTracks()[0]
    if (track) track.enabled = !track.enabled
    emit({ type: 'call' })
    return track ? !track.enabled : false
  }

  if (convo.kind === 'demo' || String(convo.peer?.id || '').startsWith('demo-')) {
    // Demo accounts are gone from the product; old stored ones stay readable
    // but never touch the network.
    conn.net = inertNet()
  } else {
    // History backlog: never offer opened view-once photos, and strip heavy
    // attachment bytes (they'd re-ship megabytes on every reconnect — the
    // receiver lazily fetches bytes on tap instead).
    conn.net = createNet(convo.roomId, convo.secret, handlers,
      () => store.list()
        .filter((m) => !(m.viewOnce && seenByPeer.has(m.id)))
        .map((m) => (m.data && m.data.length > DETACH_BYTES
          ? { ...m, data: null, detached: true, mime: m.data.slice(5, m.data.indexOf(';')) }
          : m)))
  }

  sweepExpired()
  return conn
}

export const rooms = {
  /**
   * Connect (idempotent). Returns the connection, or null without a convo.
   *
   * A cached connection whose WebRTC died stays in this map forever, and
   * handing that corpse back is why a stuck chat never recovered: leaving the
   * chat does not leave the room (by design — the connection should survive
   * navigation), so reopening found the same dead object and nothing ever
   * rejoined. Only a full page reload cleared it.
   *
   * Rebuilding is deliberately conservative, because "no peers" is ALSO what a
   * perfectly healthy room looks like when the other person is simply offline,
   * and tearing that down on sight would spam the trackers with rejoins:
   *   - only here, on an explicit open — never on a timer;
   *   - only when the room currently holds no peers;
   *   - only after a grace window, since a fresh join legitimately takes
   *     tens of seconds to find anyone over public trackers.
   */
  ensure (roomId) {
    const existing = connections.get(roomId)
    if (existing) {
      const settling = Date.now() - (existing.openedAt || 0) < REJOIN_GRACE_MS
      if (settling || existing.net.peerCount() > 0) return existing
      // Past the grace window with nobody connected. It may be alive and
      // merely lonely, but a dead one never heals itself, and rejoining is
      // also how we find a peer who has since come back.
      try { existing.net.leave() } catch { /* already gone */ }
      connections.delete(roomId)
    }
    const convo = db.convo(roomId)
    if (!convo) return null
    const conn = createConnection(convo)
    conn.openedAt = Date.now()
    connections.set(roomId, conn)
    return conn
  },

  get: (roomId) => connections.get(roomId) || null,

  /** Bring every non-archived conversation online. Called at boot. */
  connectAll () {
    for (const convo of db.convos()) {
      if (!convo.archived) this.ensure(convo.roomId)
    }
  },

  /** Build + persist + send a message. Returns the full envelope. */
  sendMessage (roomId, partial) {
    const conn = this.ensure(roomId)
    if (!conn) return null
    const p = db.profile()
    const message = {
      id: randomId(8),
      from: p.id,
      name: p.name,
      lang: p.lang,
      ts: Date.now(),
      kind: 'text',
      text: '',
      ...partial
    }
    conn.store.add(message)
    conn.net.sendMessage(message)
    db.bump(roomId, { text: preview(message), ts: message.ts, fromMe: true })
    applyTimerControl(roomId, message)
    if (message.ttl) {
      // Sender's copy obeys the same clock.
      const t = setTimeout(() => conn.store.remove(message.id), message.ttl * 1000)
      void t
    }
    return message
  },

  /**
   * Send an attachment (image/voice/file). Bytes go BINARY with the envelope
   * as metadata and real progress; the local store keeps the full data URL.
   * onProgress receives 0..1, then 1 on completion or -1 on failure.
   */
  sendAttachment (roomId, partial, onProgress) {
    const conn = this.ensure(roomId)
    if (!conn || !partial?.data) return null
    const p = db.profile()
    const message = {
      id: randomId(8),
      from: p.id,
      name: p.name,
      lang: p.lang,
      ts: Date.now(),
      text: '',
      ...partial
    }
    conn.store.add(message)
    db.bump(roomId, { text: preview(message), ts: message.ts, fromMe: true })
    const { buffer, mime } = dataURLToBuffer(message.data)
    const metadata = { ...message, data: null, mime }
    try {
      const sending = conn.net.sendBinary(buffer, {
        metadata,
        onProgress: (pr) => onProgress?.(Math.min(pr, 0.99))
      })
      if (sending?.then) sending.then(() => onProgress?.(1)).catch(() => onProgress?.(-1))
      else onProgress?.(1)
    } catch { onProgress?.(-1) }
    if (message.ttl) setTimeout(() => conn.store.remove(message.id), message.ttl * 1000)
    return message
  },

  /** Pull detached attachment bytes from whoever is online and holds them. */
  async fetchAttachment (roomId, id) {
    const conn = this.ensure(roomId)
    if (!conn) throw new Error('Conversation not found')
    const peer = conn.net.peerIds?.()[0]
    if (!peer) throw new Error('They are offline — media transfers while you are both online')
    const m = conn.store.list().find((x) => x.id === id)
    const bytes = await conn.net.fetchFrom({ id }, { target: peer })
    if (!bytes) throw new Error('No longer available')
    const dataURL = bufferToDataURL(bytes, m?.mime || 'image/jpeg')
    conn.store.patch(id, { data: dataURL, detached: false })
    return dataURL
  },

  /**
   * Rewrite a message you already sent. WhatsApp semantics: the text changes
   * on both sides and both sides show that it was edited — an edit that only
   * the author could see would be a way to lie about what was said.
   */
  editMessage (roomId, id, text) {
    const conn = this.ensure(roomId)
    if (!conn) return null
    const message = conn.store.list().find((m) => m.id === id)
    const me = db.profile().id
    if (!message || message.from !== me) return null
    const next = String(text || '').trim()
    if (!next || next === message.text) return null
    const editedAt = Date.now()
    conn.store.patch(id, { text: next, editedAt })
    conn.net.sendEdit({ id, text: next, from: me, editedAt })
    const latest = conn.store.list().at(-1)
    if (latest?.id === id) db.bump(roomId, { text: preview(latest), ts: latest.ts, fromMe: true })
    return next
  },

  /** Delete on both sides, without residue. */
  deleteMessage (roomId, id) {
    const conn = this.ensure(roomId)
    if (!conn) return
    conn.store.remove(id)
    conn.net.sendDelete({ id })
  },

  /** Live-location update from the sharer: patch locally + tell the peer.
   * {id, lat, lon} moves the pin; {id, stop:true} ends the share. */
  locup (roomId, data) {
    const conn = connections.get(roomId)
    if (!conn || !data?.id) return
    if (data.stop) conn.store.patch(data.id, { live: false })
    else conn.store.patch(data.id, { lat: data.lat, lon: data.lon })
    conn.net.sendLocup(data)
  },

  react (roomId, target, emoji) {
    const conn = this.ensure(roomId)
    if (!conn) return
    const payload = { target, emoji, from: db.profile().id }
    conn.store.addReaction(payload)
    conn.net.sendReaction(payload)
  },

  typing (roomId, on, kind = 'typing') {
    const conn = connections.get(roomId)
    conn?.net.sendTyping({ on, name: db.profile().name, kind })
  },

  markRead (roomId) {
    const conn = connections.get(roomId)
    if (conn) conn.net.sendRead({ upTo: Date.now() })
    db.clearUnread(roomId)
  },

  /** Tell the sender their view-once was opened (and delete locally after). */
  viewOnceOpened (roomId, id) {
    const conn = connections.get(roomId)
    if (!conn) return
    conn.net.sendSeen({ id })
    conn.store.remove(id)
  },

  leave (roomId) {
    const conn = connections.get(roomId)
    if (conn) {
      conn.net.leave()
      connections.delete(roomId)
    }
  }
}
