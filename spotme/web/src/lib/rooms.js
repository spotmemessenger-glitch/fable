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
// For the receiving half of the "Last seen & online" setting — discovery does
// not import rooms, so this direction is acyclic.
import { lobby } from './discovery.js'
import { alertMessage } from './notify.js'
import { pokePeer } from './push.js'
/* DELIBERATELY NOT ROUTED THROUGH THE TRANSPORT SEAM. This is key material, and
 * `setRoomKeyProvider` is on FORBIDDEN_KEY_SURFACE by name — an adapter that can
 * be handed a key is an adapter that will eventually derive one, which is how
 * V-19 survived its first fix. Rooms come from transport/room.js; keys are
 * installed here, directly, and never cross an adapter. See ADR-002 §2 and the
 * header of transport/socketio-adapter.js.
 *
 * `clearRoomKey`/`clearRoomCursor` join it for the same reason: they are the
 * teardown half of that key material, and `leave()` must be able to reset a room
 * or deleting a chat reuses its dead key. */
import { setRoomKeyProvider, freshTokens, clearRoomKey, clearRoomCursor } from './socket-transport.js'
import {
  objectStorageEnabled, uploadAttachment, downloadAttachment,
} from './media-transfer.js'
import { roomKeyForConvo } from './crypto/identity-store.js'
import { E2E_V2 } from './crypto/e2e-v2.js'
/* A5. `maySend` is SYNCHRONOUS on purpose — reading a trust record is not, and
 * putting IndexedDB between a keypress and a bubble is the objection that made
 * `identityStatus()` synchronous too. The verdict is computed where trust is
 * already being consulted, below, and merely read here. */
import {
  maySend, reportBlocked, markKeyProposed, setRoomTrust,
} from './crypto/identity-enforcement.js'
import { readRecord } from './crypto/identity-pin-store.js'

/** Attachments bigger than this never ride the history backlog — the bytes
 * are lazily fetched on demand instead, so reconnects stay instant. */
const DETACH_BYTES = 4096

/**
 * How much of an attachment travels in one transport send.
 *
 * THIS IS THE FIX FOR "everything stops after a photo". Handing the transport
 * a whole multi-megabyte photo produced two failures at once:
 *
 *   - It writes ~16KB chunks in a loop, pausing only when the data channel's
 *     buffer is full, and gives up on that pause after ten seconds — by
 *     BREAKING OUT of the loop and resolving the send as though it finished.
 *     The sender saw "Sent"; the receiver held a pile of chunks missing their
 *     terminator and showed nothing. On a relayed mobile link a large photo
 *     hit that timeout nearly every time.
 *   - Every room with the same peer shares ONE data channel, so while those
 *     chunks were queued nothing else got through: text, read receipts and
 *     presence all sat behind the photo, which is why the chat looked dead and
 *     the header fell back to "Last seen".
 *
 * Slicing bounds both. Each slice drains well inside the ten-second window,
 * and between slices the channel empties, so ordinary messages interleave with
 * a transfer instead of queueing behind it.
 */
const SLICE_BYTES = 128 * 1024

/** How long to wait for the receiver to confirm a whole attachment landed. */
const ACK_TIMEOUT_MS = 90_000

/** Half-received attachments are dropped rather than held forever. */
const ASSEMBLY_TTL_MS = 5 * 60_000

/** The longest burst the wheel offers (chat.js BURST_OPTIONS ends at 3 min).
 *  A peer-supplied duration is clamped to it — see onSeen. */
const MAX_BURST_SECS = 180

function concatSlices (slices) {
  const total = slices.reduce((sum, s) => sum + s.byteLength, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const slice of slices) { out.set(slice, at); at += slice.byteLength }
  return out
}

const toBytes = (payload) => payload instanceof Uint8Array
  ? payload
  : new Uint8Array(payload instanceof ArrayBuffer ? payload : payload.buffer)

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

/**
 * May we record when this peer was last online?
 *
 * Their announcement carries the answer (`seen`), set from their own
 * "Last seen & online" row. Unknown peers default to yes — a peer we have never
 * seen in the lobby has expressed no preference, and refusing by default would
 * silently break the header for everyone on an older build.
 *
 * 'contacts' is honoured symmetrically: we record only if they are in OUR
 * contacts, which is the closest a client can get without asking the server who
 * is in theirs. Cooperative by design, as the setting's own subtitle says.
 */
function peerAllowsSeen (peerId) {
  if (!peerId) return true
  const announced = lobby.peers().find((p) => p.id === peerId)?.seen
  if (announced === 'nobody') return false
  if (announced === 'contacts') return db.contacts().some((c) => c.id === peerId)
  return true
}

/** Legacy demo conversations in old storage — inert, never networked. */
function inertNet () {
  const noop = () => {}
  return {
    sendMessage: noop, sendReaction: noop, sendProfile: noop, sendDelete: noop,
    // `sendEdit` was the one member of createNet's surface missing here, and
    // `editMessage` calls it AFTER it has already patched the store — so
    // editing your own text in a legacy demo convo threw a TypeError with the
    // text already changed and the sheet still open, saying nothing.
    sendTyping: noop, sendRead: noop, sendSeen: noop, sendCall: noop, sendLocup: noop, sendEdit: noop,
    sendBinary: () => Promise.resolve(),
    sendBinAck: noop,
    fetchFrom: () => Promise.resolve(null),
    addStream: noop, removeStream: noop, replaceTrack: noop,
    peerIds: () => [], peerCount: () => 0, livePeerIds: () => [], leave: noop
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
  /* The store needs to know who "I" am for two reasons: so a quota shed
   * sacrifices what the other person can re-send before it touches what only
   * this device holds, and so the shed can be reported honestly instead of
   * discovered on a reload. */
  const store = createStore(convo.roomId, ROOM_PREFIX, {
    selfId: () => db.profile()?.id,
    onShed: (info) => emit({ type: 'shed', ...info })
  })
  const listeners = new Set()
  const seenByPeer = new Set()   // my view-once messages the peer has opened
  /* my view-once messages the peer is opening RIGHT NOW: id -> {secs, at}.
   * Without this the sender learned nothing until the photo was already gone —
   * the one moment they most want to see is the one they were not told about. */
  const openingByPeer = new Map()
  const timers = new Map()       // message id -> ttl timer
  const assembling = new Map()   // message id -> partially received attachment
  const pendingAcks = new Map()  // message id -> {resolve, reject, timer}

  const conn = {
    roomId: convo.roomId,
    store,
    net: null,
    peerCount: 0,
    typing: null,                // {name, until}
    readUpTo: 0,
    seenByPeer,
    openingByPeer,
    call: { state: 'idle', video: false, local: null, remote: null },
    on (fn) { listeners.add(fn); return () => listeners.delete(fn) },
    /* So a message can be placed into an already-open thread from outside this
     * closure — `reach()` doing exactly that for the line carried by a knock. */
    emit (event) { emit(event) }
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
    // The record is re-read rather than closed over: a chat muted after this
    // connection was built must go quiet immediately, not on next reload.
    const current = db.convo(convo.roomId)
    alertMessage({
      roomId: convo.roomId,
      title: current?.title || current?.peer?.name || convo.peer?.name || 'New message',
      body: preview(message),
      muted: Boolean(current?.muted)
    })
    emit({ type: 'message', message })
  }

  /**
   * An attachment whose bytes live in object storage (Phase 5).
   *
   * The envelope arrived over the socket; the slices are fetched, decrypted and
   * reassembled here. Progress is emitted per slice through the SAME
   * `rxprogress` event the inline path uses, so nothing in the UI needs to know
   * which transport carried the file.
   *
   * A failure leaves the message DETACHED rather than absent — the bubble
   * stays, `tap to load` is offered, and the bytes can be fetched again. That
   * matters most for the case it is hardest to distinguish: a view-once photo
   * someone else already claimed answers 403, and a private photo already
   * opened and destroyed answers 404, and neither should look like a message
   * that never arrived.
   */
  async function receiveFromStorage (meta) {
    const total = Math.max(1, Number(meta.total) || 1)
    emit({ type: 'rxprogress', id: meta.id, progress: 0, meta })
    try {
      const bytes = await downloadAttachment(convo.roomId, meta.id, total, {
        password: convo.secret,
        onProgress: (pr) => emit({ type: 'rxprogress', id: meta.id, progress: pr, meta })
      })
      const { seq, total: _t, viaStorage: _v, mime, ...envelope } = meta
      const message = {
        ...envelope,
        data: bufferToDataURL(bytes, mime || 'application/octet-stream')
      }
      // Tell the sender it landed before anything below can throw — their
      // "Sent" indicator is waiting on exactly this.
      conn.net.sendBinAck({ id: meta.id })
      if (store.add(message)) {
        emit({ type: 'rxdone', id: meta.id })
        onIncoming(message)
      } else {
        store.patch(meta.id, { data: message.data, detached: false })
        emit({ type: 'rxdone', id: meta.id })
      }
    } catch (error) {
      const { seq, total: _t, viaStorage: _v, ...envelope } = meta
      // Keep the envelope so the message is visible and retryable.
      if (!store.add({ ...envelope, data: null, detached: true })) {
        store.patch(meta.id, { detached: true })
      }
      emit({ type: 'rxfail', id: meta.id, error: error?.message || 'transfer failed' })
    }
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
      if (!payload?.id) return
      /* Two distinct moments arrive on this channel now. "opening" fires the
       * instant they tap, carrying how long they have — that is what lets the
       * sender watch the same countdown instead of waiting blind. The plain
       * form still means it is over. */
      if (payload.opening) {
        /* A burned photo cannot be being viewed. Replay can deliver an
         * "opening" that was overtaken by its own burn, and without this the
         * sender's bubble springs back into a countdown for a photo that is
         * already gone. Burned is final; nothing revives it. */
        if (seenByPeer.has(payload.id)) return
        /* Clamped at both ends to what the burst wheel can actually produce.
         * Unbounded above, a peer sending secs=86400 pinned the sender's UI in
         * "Viewing now" for a day — a countdown is a claim about the other
         * person's screen, so it may only say what this app can mean. */
        openingByPeer.set(payload.id, {
          secs: Math.min(MAX_BURST_SECS, Math.max(1, Number(payload.secs) || 10)),
          at: Date.now()
        })
        emit({ type: 'viewing', id: payload.id })
        return
      }
      openingByPeer.delete(payload.id)
      seenByPeer.add(payload.id)
      emit({ type: 'seen', id: payload.id })
    },
    /* The peer is sending and this device can open none of it, and re-agreeing
     * the key did not rescue it. Deliberately NOT persisted onto the convo
     * record: this is a live property of the key agreement, and a stale
     * "broken" flag outliving a repair would be its own bug — the kind that
     * makes a working chat permanently accuse itself. The view holds it while
     * the screen is open, and an incoming message that DOES decrypt clears it. */
    /* `type` LAST, not first. `info` carries the FRAME's type ('msg', 'read',
     * …), so spreading it after `type: 'undecryptable'` overwrote the event
     * type with the frame type — the event arrived as `{type:'msg'}`, the
     * `case 'undecryptable'` in chat.js never matched, and the banner this was
     * built for was dead code that its own test could not catch, because that
     * test asserts at the transport boundary and never crosses this file. */
    onUndecryptable (info) { emit({ ...info, type: 'undecryptable' }) },

    /**
     * A send threw, so the bubble must stop claiming it was sent.
     *
     * `sendAttachment` has patched `failed` since the voice-note work, and
     * `buildReadRow` has drawn "Not delivered" for it just as long — but TEXT
     * went out through `sendMessage`, which is fire-and-forget, so nothing ever
     * set the flag on it. `read ? 'Read' : 'Sent'` is a DEFAULT, not a receipt:
     * a text message that never left the device still rendered a tick.
     *
     * That is precisely the case ADR-001 created, as net.js's own comment says:
     * an e2e_v2 room has no password fallback, so a room whose key cannot be
     * agreed REFUSES to encrypt — correct behaviour, reported to the user as a
     * tick and silence.
     *
     * Scoped to 'message'. Typing, read receipts and presence fail all the time
     * on a flaky link and mean nothing to a user; marking a bubble undelivered
     * because a typing indicator died would be noise dressed as information.
     */
    onSendError (what, error, id) {
      if (what !== 'message' || !id) return
      if (!conn.store.patch(id, { delivered: false, failed: true })) return
      emit({ type: 'sendfailed', id })
    },

    onPeers (count) {
      // Track when the peer was last connected, so the header can say
      // "Last seen 14:32" instead of a vague waiting message — unless they
      // asked us not to. `peerAllowsSeen` is the receiving half of the
      // "Last seen & online" setting; without it the choice never left the
      // device that made it.
      if ((count > 0 || conn.peerCount > 0) && peerAllowsSeen(convo.peer?.id)) {
        db.upsertConvo({ roomId: convo.roomId, peerSeen: Date.now() })
      }
      /* Every successful connection files them as a contact — reach.js already
       * does this the moment a chat opens, but this is the safety net for
       * conversations that started some other way (a shared room link). */
      if (count > 0 && convo.peer?.id && convo.kind !== 'group') db.addContact(convo.peer)
      conn.peerCount = count
      emit({ type: 'peers', count })
    },
    /**
     * One slice of an attachment arrived. The envelope rides on slice 0; every
     * slice carries {id, seq, total} so the pieces can be put back together and,
     * more importantly, so a transfer that stops early is DETECTABLE rather than
     * silently indistinguishable from one that finished.
     */
    onBinary (payload, context) {
      const meta = context?.metadata
      if (!meta?.id) return

      /* Phase 5: the bytes are in object storage, not in this frame.
       *
       * One envelope arrives with an empty payload and `viaStorage` set, and
       * the slices are fetched and decrypted from storage instead of being
       * reassembled from the wire. Handled BEFORE the assembly bookkeeping
       * below, because an envelope declaring total=N with no slices coming
       * would otherwise sit in `assembling` until it expired and the message
       * would never appear at all.
       *
       * The fetch is deliberately not awaited: onBinary is a transport
       * callback, and blocking it would stall every other frame behind one
       * download. */
      if (meta.viaStorage) {
        void receiveFromStorage(meta)
        return
      }

      sweepAssemblies()
      const total = meta.total || 1
      const seq = meta.seq || 0
      let entry = assembling.get(meta.id)
      if (!entry) {
        entry = { envelope: null, slices: new Array(total), have: 0, total }
        assembling.set(meta.id, entry)
      }
      entry.expires = Date.now() + ASSEMBLY_TTL_MS
      if (seq === 0) entry.envelope = meta
      if (seq < entry.total && !entry.slices[seq]) {
        entry.slices[seq] = toBytes(payload)
        entry.have++
      }
      if (entry.have < entry.total || !entry.envelope) return
      assembling.delete(meta.id)

      const envelope = entry.envelope
      const message = {
        ...envelope,
        data: bufferToDataURL(concatSlices(entry.slices), envelope.mime || 'application/octet-stream')
      }
      delete message.mime
      delete message.seq
      delete message.total
      // Tell the sender it truly landed, before anything below can throw —
      // their "Sent" indicator is waiting on exactly this.
      conn.net.sendBinAck({ id: envelope.id })
      if (store.add(message)) {
        emit({ type: 'rxdone', id: envelope.id })
        onIncoming(message)
      } else {
        // The history backlog already delivered this envelope without its
        // bytes. Adding is refused for a known id, so fill in the bytes
        // instead — otherwise a photo that has now fully arrived would sit
        // there as "tap to load" forever.
        store.patch(envelope.id, { data: message.data, detached: false })
        emit({ type: 'rxdone', id: envelope.id })
      }
    },
    onBinaryProgress (progress, context) {
      const meta = context?.metadata
      if (!meta?.id) return
      const total = meta.total || 1
      const seq = meta.seq || 0
      emit({
        type: 'rxprogress',
        id: meta.id,
        progress: Math.min((seq + progress) / total, 1),
        meta
      })
    },
    /** The receiver has the whole attachment — the send is genuinely done. */
    onBinAck (payload) {
      const waiter = payload?.id && pendingAcks.get(payload.id)
      if (!waiter) return
      pendingAcks.delete(payload.id)
      clearTimeout(waiter.timer)
      waiter.resolve()
    },
    /** A peer asks for bytes we hold (lazy fetch of detached attachments). */
    onFetch (data) {
      const m = data?.id ? store.list().find((x) => x.id === data.id) : null
      if (!m?.data) return null
      /* From the first OPEN, not from the burn. The gate used to key on
       * seenByPeer alone, which is only populated when the countdown ends, so
       * for the whole viewing window a second request was served the bytes in
       * full — and a burn signal lost on the way left them servable forever. */
      if (m.viewOnce && (seenByPeer.has(m.id) || openingByPeer.has(m.id))) return null
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

  function sweepAssemblies () {
    const now = Date.now()
    for (const [id, entry] of assembling) {
      if (entry.expires <= now) assembling.delete(id)
    }
  }

  /** Resolves when the peer confirms the attachment; rejects on the deadline. */
  function awaitAck (id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingAcks.delete(id)
        reject(new Error('The attachment did not reach them'))
      }, ACK_TIMEOUT_MS)
      pendingAcks.set(id, { resolve, reject, timer })
    })
  }

  /**
   * Push an attachment slice by slice, then wait for the receipt.
   *
   * Awaiting each slice is what keeps the shared data channel usable: the next
   * one is not queued until the last has drained, so text messages sent during
   * a transfer are not stuck behind megabytes of photo.
   */
  conn.deliverAttachment = async function (message, buffer, mime, onProgress) {
    const total = Math.max(1, Math.ceil(buffer.byteLength / SLICE_BYTES))
    const envelope = { ...message, data: null, mime }

    /* OBJECT-STORAGE PATH (Phase 5, opt-in per device).
     *
     * Bytes go client -> bucket; the socket carries one envelope frame of a few
     * hundred bytes instead of ~1.33x the file as base64. The payload is
     * EMPTY — not omitted, because sendAction seals whatever it is given and an
     * empty sealed payload is what tells a receiver "the bytes are not here".
     * `viaStorage` in the sealed envelope is the actual signal, and the object
     * keys are derived from (roomId, attachId, seq) on both sides rather than
     * transmitted.
     *
     * A failure here throws, and sendAttachment's catch marks the message
     * failed — which is correct: unlike the socket path there is no server log
     * holding a partial copy, so a half-finished upload has delivered nothing
     * and must not read as "Sent". */
    if (objectStorageEnabled()) {
      const { total: stored } = await uploadAttachment(convo.roomId, message.id, buffer, {
        // The room secret, exactly as createNet is given it. For an e2e_v2
        // room the registered key provider wins and this is never consulted
        // (ADR-001) — the upload path must not be the one door with a
        // password fallback.
        password: convo.secret,
        onProgress: (pr) => onProgress?.(Math.min(pr, 0.99))
      })
      /* Record it on OUR copy too, so the history backlog we hand a joining
       * peer carries the same two facts the live envelope does. Without this a
       * receiver that learns of the message from Alice's backlog rather than
       * from the server's replay gets an envelope with no idea the bytes are in
       * storage — and the harness showed what that costs: it falls through to
       * the peer path, fetches the 28-byte sealed-empty payload, and renders a
       * successfully-loaded EMPTY image. */
      store.patch(message.id, { viaStorage: true, total: stored })
      await conn.net.sendBinary(new Uint8Array(0), {
        metadata: { ...envelope, seq: 0, total: stored, viaStorage: true }
      })
      onProgress?.(1)
      try {
        await awaitAck(message.id)
        store.patch(message.id, { delivered: true, failed: false })
      } catch {
        // Same reasoning as the durable socket path below: the bytes are in
        // storage and the envelope is in the log, so a late receipt is not a
        // failed send.
        store.patch(message.id, { delivered: false, failed: false })
      }
      return
    }

    for (let seq = 0; seq < total; seq++) {
      // Durable transport: slices land in the server log even with nobody
      // online — the receiver assembles them from replay + lazy fetch.
      if (!conn.net.DURABLE && conn.net.livePeerIds().length === 0) throw new Error('They went offline mid-transfer')
      const slice = buffer.slice(seq * SLICE_BYTES, (seq + 1) * SLICE_BYTES)
      const metadata = seq === 0
        ? { ...envelope, seq, total }
        : { id: message.id, seq, total }
      await conn.net.sendBinary(slice, {
        metadata,
        // Cap below 1: the transfer is not done until the receipt arrives.
        onProgress: (pr) => onProgress?.(Math.min((seq + pr) / total, 0.99))
      })
    }
    /* Every slice is in the server log now, and on a durable transport that IS
     * the upload finished. Holding the bar at 99% until the receipt arrived
     * meant an upload that completed in 250ms displayed "99%" for the next 85
     * seconds whenever the recipient simply had the app closed — which is the
     * normal case, and the whole reason the transport was made durable. What
     * is still outstanding at this point is DELIVERY, and delivery belongs on
     * the tick row, not on an upload percentage. */
    if (conn.net.DURABLE) onProgress?.(1)
    try {
      await awaitAck(message.id)
      store.patch(message.id, { delivered: true, failed: false })
    } catch (err) {
      /* On a durable transport a missing receipt is NOT a failure. Every slice
       * is already in the server log and will be replayed when they next open
       * the app — the receipt is merely late, usually because their tab is
       * backgrounded (iOS suspends them within seconds).
       *
       * Calling that "Not delivered" was worse than saying nothing: it told
       * the sender their voice note had gone nowhere while it sat safely on
       * the server, and the only remedy it suggested was to send it again.
       * Failure is now reserved for a send that actually threw. */
      if (!conn.net.DURABLE) throw err
      store.patch(message.id, { delivered: false, failed: false })
    }
    onProgress?.(1)
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

  const isDemo = convo.kind === 'demo' || String(convo.peer?.id || '').startsWith('demo-')

  function joinNet () {
    // Demo accounts are gone from the product; old stored ones stay readable
    // but never touch the network.
    if (isDemo) { conn.net = inertNet(); return }

    /* AN e2e_v2 ROOM MUST NEVER BE JOINED WITH ITS v1 PASSWORD.
     *
     * `convo.secret` is still on the record — it has to be, for v1 rooms and
     * for the knock wire format — and it is exactly the cyrb53 value the server
     * can recompute. Registering a provider FIRST means roomKey() has no
     * password path for this room: it re-agrees the ECDH key, or the room does
     * not open. Without this the fix evaporated on the first page reload, and
     * silently, because both peers degraded identically. */
    if (convo.e2eVersion === E2E_V2) {
      /* `opts` carries `forceRefetch` down from the transport's self-heal.
       *
       * TWO CALLBACKS, AND THE DIFFERENCE BETWEEN THEM IS THE POINT.
       *
       * `onPeerKeyChanged` fires only for a FIRST key — nothing is being
       * replaced, so caching it is safe. It writes to BOTH the record and the
       * captured `convo` object: the record so a reload does not repeat the
       * fetch, and the object because this closure is what the next re-derive
       * reads; persisting to only one leaves the room repairing itself forever.
       *
       * `onPeerKeyProposed` fires when the server returns a key that is NOT the
       * one this device trusts. It deliberately persists NOTHING. Until this
       * change that case went through the same path as a first key and was
       * written straight over the pin, so a server that could provoke a decrypt
       * failure — which is exactly what drives `forceRefetch` — could rotate the
       * key it serves and have every client adopt it silently. The proposal is
       * recorded in the trust store by `roomKeyForConvo` and surfaced; it is not
       * adopted, and the room keeps deriving against the pinned key. */
      setRoomKeyProvider(convo.roomId, (opts) => roomKeyForConvo(convo, freshTokens, {
        ...opts,
        onPeerKeyChanged: (peerKey) => {
          convo.peerKey = peerKey
          db.upsertConvo({ roomId: convo.roomId, peerKey })
        },
        /* F2: a key change PROVEN by undecryptable frames is adopted so the
         * conversation continues — persisted to record and closure exactly
         * like a first key, and logged. The trust store has already recorded
         * the change (server-refetch provenance), so Verify shows it. */
        onPeerKeyAdopted: ({ adopted, previous }) => {
          convo.peerKey = adopted
          db.upsertConvo({ roomId: convo.roomId, peerKey: adopted })
          console.warn(
            `spotme identity: adopted ${convo.peer?.name || 'this contact'}'s changed key after ` +
            `decrypt failure (healed). previous=${String(previous).slice(0, 12)}… adopted=${String(adopted).slice(0, 12)}…`
          )
        },
        onPeerKeyProposed: ({ proposed, pinned }) => {
          /* A5. Still no write — the pin is untouched and the room keeps
           * deriving against it. What changes is that the room is marked
           * blocking IMMEDIATELY, here, rather than after a store read: this
           * callback already knows the answer, and the gap between knowing a
           * substituted key exists and refusing to send to it is precisely the
           * window an attacker provoking a decrypt failure is operating in.
           *
           * With enforcement OFF this records an advisory verdict and nothing
           * is refused, which is today's behaviour. */
          markKeyProposed(convo.roomId)
          console.warn(
            `spotme identity: ${convo.peer?.name || 'this contact'} is publishing a ` +
            'different key than the one this device trusts. It has NOT been adopted. ' +
            `pinned=${String(pinned).slice(0, 12)}… proposed=${String(proposed).slice(0, 12)}…`
          )
        }
      }))

      /* Seed the room's verdict from what is already stored. FIRE AND FORGET
       * for the same reason `observePeerKey` is: a room must not wait on
       * IndexedDB to open, and a room with no verdict yet is ALLOWED — it has
       * not sent anything either. A `Changed` peer therefore blocks a moment
       * after the room appears rather than before it, which is the right
       * trade: the alternative is a chat list that stalls on a wedged origin. */
      if (convo.peer?.id) {
        void readRecord(convo.peer.id)
          .then((record) => setRoomTrust(convo.roomId, record))
          .catch(() => { /* store unavailable — see identity-enforcement.js: not a block */ })
      }
    }
    // History backlog: never offer opened view-once photos, and strip heavy
    // attachment bytes (they'd re-ship megabytes on every reconnect — the
    // receiver lazily fetches bytes on tap instead).
    conn.net = createNet(convo.roomId, convo.secret, handlers,
      () => store.list()
        .filter((m) => !(m.viewOnce && seenByPeer.has(m.id)))
        .map((m) => (m.data && m.data.length > DETACH_BYTES
          ? { ...m, data: null, detached: true, mime: m.data.slice(5, m.data.indexOf(';')) }
          : m)),
      /* The peer's id, so the server can verify this device belongs in a DM
       * room instead of taking the room id as proof. A DM id is a pure function
       * of two PUBLIC ids, so it was never proof of anything. Harmless to send
       * — the server already stores both ids and never trusts this one on its
       * own; it only checks that it re-derives the room. */
      convo.peer?.id)
  }

  /**
   * Rejoin the room WITHOUT replacing this object.
   *
   * An open chat takes its connection once, on mount, and subscribes to it.
   * Swapping in a freshly built one therefore left the visible chat holding a
   * corpse — listening to an emitter nothing would ever emit on again, and
   * writing through a second store instance aimed at the same storage key.
   * Only the transport is disposable; the store, the listeners and the call
   * state belong to the conversation and must survive a reconnect.
   */
  conn.rejoin = function () {
    try { conn.net.leave() } catch { /* already gone */ }
    joinNet()
    conn.openedAt = Date.now()
    conn.peerCount = 0
    emit({ type: 'peers', count: 0 })
  }

  joinNet()
  sweepExpired()
  return conn
}

/**
 * Nobody on the other end — ask the push service to wake their phone.
 *
 * This is the ONLY thing that can raise an alert on a closed device, because
 * no server is told a message exists. The sender noticing "there is nobody
 * here" is the entire trigger.
 *
 * Groups are skipped: waking a room of twenty needs a fan-out the rate limiter
 * is not shaped for, and getting it wrong means twenty phones buzzing per
 * message. One-to-one is where the value is; groups can follow deliberately.
 */
function wakeIfUnreachable (conn, roomId) {
  if (conn.net.livePeerIds().length > 0) return
  const convo = db.convo(roomId)
  if (!convo || convo.kind === 'group') return
  pokePeer(convo.peer?.id)
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
      // Health, not headcount. A peer whose connection has already failed is
      // still listed as present until the transport gives up on it, so asking
      // "are there peers?" kept handing back a room that could not carry a
      // byte — the state a chat lands in when a transfer kills the channel.
      if (existing.net.livePeerIds().length > 0) return existing
      if (Date.now() - (existing.openedAt || 0) < REJOIN_GRACE_MS) return existing
      // Past the grace window with nobody connected. It may be alive and
      // merely lonely, but a dead one never heals itself, and rejoining is
      // also how we find a peer who has since come back. The object stays put
      // so an open chat keeps receiving; only its transport is replaced.
      existing.rejoin()
      return existing
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
  /**
   * Put a message into a room's thread without sending anything.
   *
   * THE BUG THIS EXISTS FOR. The first line of a new chat travels INSIDE the
   * knock — `reach()` puts it in the payload, and both sides wrote it to the
   * convo's `last` preview and fired a push notification with it. Neither side
   * ever added it to the message store. So the notification quoted the text,
   * the inbox row quoted the text, and opening the chat showed an empty thread:
   * "it shows in notifications but not the actual message", reported from two
   * real handsets. `inbox.js` states the intent plainly — the typed line is
   * "what both sides see as the first message once the chat opens" — so this is
   * a gap between the two, not a design choice.
   *
   * Idempotent by id, which is what makes it safe on the receiving side: a
   * knock can arrive live over P2P AND again from the relay, and `store.add`
   * refuses a duplicate id (and honours tombstones, so a deleted first message
   * does not come back).
   */
  injectLocal (roomId, message) {
    const conn = this.ensure(roomId)
    if (!conn || !message?.id) return false
    if (!conn.store.add(message)) return false
    db.bump(roomId, { text: preview(message), ts: message.ts, fromMe: message.from === db.profile()?.id })
    conn.emit({ type: 'message', message })
    return true
  },

  sendMessage (roomId, partial) {
    const conn = this.ensure(roomId)
    if (!conn) return null
    /* A5. THE CHOKE POINT. `views/chat.js` calls this from a dozen places —
     * text, location, reactions, partials, timers — so the gate belongs here
     * and not at each caller, where the thirteenth would forget it. Returning
     * null is the existing failure contract; `reportBlocked` is what stops a
     * refusal being indistinguishable from a message that quietly went
     * nowhere. OFF by default: `maySend` is true unless enforcement is on. */
    if (!maySend(roomId)) { reportBlocked(roomId); return null }
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
    wakeIfUnreachable(conn, roomId)
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
    // The other choke point. A photo to a peer whose key changed is the same
    // decision as a message to them, and a gate on only one of the two is not a gate.
    if (!maySend(roomId)) { reportBlocked(roomId); return null }
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
    wakeIfUnreachable(conn, roomId)
    db.bump(roomId, { text: preview(message), ts: message.ts, fromMe: true })
    const { buffer, mime } = dataURLToBuffer(message.data)
    // Deliberately not awaited: the caller needs the message back now so the
    // bubble appears immediately, while the bytes go out in the background.
    // Progress ends at 1 only once the receiver confirms, and at -1 if it
    // never does — a photo that quietly went nowhere must not read as "Sent".
    Promise.resolve()
      .then(() => conn.deliverAttachment(message, buffer, mime, onProgress))
      .catch(() => {
        conn.store.patch(message.id, { delivered: false, failed: true })
        onProgress?.(-1)
      })
    if (message.ttl) setTimeout(() => conn.store.remove(message.id), message.ttl * 1000)
    return message
  },

  /**
   * Send a failed attachment again from the bytes still in the local store.
   *
   * A failed send used to be terminal: a socket blip 150ms into a 37-slice
   * voice note left the row reading "Not delivered" forever, with the only
   * remedy being to record the whole thing over. The bytes never went anywhere
   * — they are right here — so the honest recovery is to push them again.
   *
   * This resends from slice 0 rather than resuming at the last acknowledged
   * seq. Resuming needs the server to answer "which slices do you have", which
   * it does not do yet; duplicate slices are already harmless (the receiver
   * ignores a seq it holds, and the log now reports DISTINCT seqs held).
   */
  /**
   * Send a failed TEXT message again.
   *
   * `retryAttachment` below refuses text explicitly, and the "Not delivered"
   * row only offered a Retry button for attachments — so a text message that
   * failed to send was the end of the road. There was no queue behind it
   * either: `sendAction` recovers only a `not joined` error, and socket.io
   * splices a packet out of its send buffer once the ack times out, so a
   * fifteen-second outage discarded the message for good.
   *
   * The text never left this device. It is sitting in the store, fully intact,
   * one call away from being sent — the only thing missing was the offer.
   */
  retryMessage (roomId, id) {
    const conn = this.ensure(roomId)
    if (!conn) return false
    const message = conn.store.list().find((m) => m.id === id)
    if (!message || (message.kind && message.kind !== 'text')) return false
    conn.store.patch(id, { failed: false })
    // `onSendError` flips it back if this attempt fails too, exactly as the
    // first attempt did — so a retry that fails is honest rather than silent.
    conn.net.sendMessage(message)
    wakeIfUnreachable(conn, roomId)
    return true
  },

  retryAttachment (roomId, id, onProgress) {
    const conn = this.ensure(roomId)
    if (!conn) return false
    const message = conn.store.list().find((m) => m.id === id)
    if (!message?.data || !message.kind || message.kind === 'text') return false
    conn.store.patch(id, { failed: false })
    const { buffer, mime } = dataURLToBuffer(message.data)
    Promise.resolve()
      .then(() => conn.deliverAttachment(message, buffer, mime, onProgress))
      .catch(() => {
        conn.store.patch(id, { delivered: false, failed: true })
        onProgress?.(-1)
      })
    return true
  },

  /**
   * Pull detached attachment bytes from whoever is online and holds them.
   *
   * Asking only the first peer and giving up was wrong twice over: a group may
   * have several people holding the bytes, and the first id listed can belong
   * to a connection that has already died, in which case the request used to
   * hang with no deadline and the button sat on "Loading…" forever.
   */
  async fetchAttachment (roomId, id) {
    const conn = this.ensure(roomId)
    if (!conn) throw new Error('Conversation not found')
    const m = conn.store.list().find((x) => x.id === id)

    /* OBJECT STORAGE FIRST, when that is where the bytes are.
     *
     * A Phase 5 attachment has no RoomEvent slices at all — only a 28-byte
     * envelope — so asking peers and the server log for them finds nothing and
     * the message sits on "tap to load" permanently. The two-origin harness
     * caught exactly this on the offline path: the envelope replayed, the
     * bytes were sitting in storage the whole time, and nothing knew to fetch
     * them. Falls through to the peer path on failure, so an attachment sent
     * before this existed still loads the old way. */
    /* `viaStorage` OR the device flag: the marker has to survive server replay,
     * peer history backlog and a live send, and relying on all three to carry
     * it is how the empty-image bug above happened. Object keys are DERIVED
     * from (roomId, attachId), so trying storage costs one request and is
     * always safe — a wrong guess 403s and falls through. */
    if (m && (m.viaStorage || objectStorageEnabled())) {
      try {
        const bytes = await downloadAttachment(conn.roomId, id, Math.max(1, Number(m.total) || 1), {
          password: db.convo(roomId)?.secret
        })
        if (!bytes?.length) throw new Error('empty object')
        const url = bufferToDataURL(bytes, m.mime || 'image/jpeg')
        conn.store.patch(id, { data: url, detached: false })
        return url
      } catch (error) {
        // "Opened and destroyed" is an answer, not a failure to retry — a
        // client that cannot tell the two apart asks forever.
        if (/destroyed/i.test(error?.message || '')) throw error
      }
    }

    // The server log holds every slice ever sent through it, so a durable
    // transport can serve bytes with the sender long gone — 'server' is a
    // pseudo-peer the transport resolves internally.
    const peers = conn.net.DURABLE
      ? ['server', ...conn.net.livePeerIds()]
      : conn.net.livePeerIds()
    if (peers.length === 0) throw new Error('They are offline — media transfers while you are both online')
    let bytes = null
    let lastError = null
    for (const peer of peers) {
      try {
        bytes = await conn.net.fetchFrom({ id }, { target: peer })
        if (bytes) break
      } catch (error) { lastError = error }
    }
    /* EMPTY IS A FAILURE, NOT A LOAD. A Phase 5 attachment's RoomEvent row
     * holds a sealed EMPTY payload — the bytes are in storage — so the peer
     * path "succeeds" here with zero bytes and the UI renders a blank image as
     * though it had loaded. `!bytes` alone did not catch it because an empty
     * Uint8Array is truthy. */
    if (!bytes?.length) throw new Error(lastError ? 'That transfer did not complete — try again' : 'No longer available')
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

  /**
   * The photo has been opened. THE BURN HAPPENS HERE, not when the countdown
   * reaches zero.
   *
   * "Exactly one view" used to rest entirely on finish() completing inside the
   * same page session: opening wrote nothing durable, so killing the app
   * mid-view left the photo intact, masked and openable again — reproduced end
   * to end, and it needed no tooling at all. Ten to sixty seconds is a very
   * long time to leave a promise resting on the tab staying alive.
   *
   * So the moment the photo is opened, before a pixel is shown:
   *   - the local copy is removed and TOMBSTONED, which no history backlog,
   *     re-send or replay can undo;
   *   - `burn` goes to the server, which deletes the stored slices.
   * `opening` still rides along so the sender sees the live countdown.
   */
  viewOnceOpen (roomId, id, secs) {
    const conn = connections.get(roomId)
    if (!conn) return
    conn.net.sendSeen({ id, opening: true, secs, burn: true })
    conn.store.remove(id)
  },

  /** The countdown finished (or they closed early) — the sender's bubble stops
   *  watching. The burn already happened at open; this repeats it because the
   *  delete is idempotent and a lost `opening` frame must not leave bytes. */
  viewOnceOpened (roomId, id) {
    const conn = connections.get(roomId)
    if (!conn) return
    conn.net.sendSeen({ id, burn: true })
    conn.store.remove(id)
  },

  /**
   * Delete this conversation's live state. Every caller pairs this with
   * `db.removeConvo`, so it is the "this chat is gone" path, not teardown.
   *
   * THE KEY AND CURSOR HAVE TO GO WITH IT, and until now neither did.
   * `clearRoomKey` had no production caller at all, so the registered provider
   * — a closure over the convo record that was about to be deleted, holding its
   * dead `peerKey` — outlived the conversation. A DM roomId is a pure function
   * of the two account ids (`reach.js` `directRoom`), so re-starting the chat
   * lands on the SAME room and `roomKey()` finds that orphan still installed:
   * deleting and starting again derived from the dead key and failed exactly as
   * before. That made the app's own repair advice self-defeating.
   *
   * The cursor goes too, or the re-created chat resumes mid-history with a hole
   * where the messages it never managed to open used to be.
   */
  leave (roomId) {
    const conn = connections.get(roomId)
    if (conn) {
      conn.net.leave()
      connections.delete(roomId)
    }
    clearRoomKey(roomId)
    clearRoomCursor(roomId)
  }
}
