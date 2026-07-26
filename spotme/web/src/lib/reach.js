/**
 * Spot Me — direct reach.
 *
 * Replaces the old broadcast-through-one-shared-lobby request mechanism.
 * That design put every pending request, from every Spot Me user anywhere,
 * through ONE giant Trystero room — which meant a request could only cross
 * if both sides happened to be meshed into that same crowded room at the
 * same instant, and it never noticed a dead connection after the tab was
 * backgrounded (fixed for that mechanism, but the mechanism itself is gone).
 *
 * THE NEW SHAPE
 *
 * Every device joins exactly one room of its own at boot — its INBOX, a room
 * id derived from nothing but its own Spot Me id. To reach someone you already
 * know the id of (resolved by username search, seen nearby, seen over
 * Bluetooth), you join THEIR inbox and knock: your profile, a chat invite,
 * and the room to meet in. Nobody else's requests pass through your inbox —
 * it is addressed to exactly one id, not filtered client-side out of a firehose.
 *
 * NO PERMISSION GATE (owner decision 2026-07-26): a knock used to create a
 * pending request that sat on the recipient's side until they explicitly hit
 * Accept — which meant a chat only ever went live if both people were online
 * at the same moment AND one of them remembered to tap Accept. In practice
 * that left conversations stuck forever on "Sending request…" /
 * "Delivering request… (they need the app open)" even when both phones were
 * open and reachable. reach() and the knock handler below both open the
 * conversation immediately on their own side — there is no pending state to
 * get stuck in. The knock's only remaining job is delivery: getting your
 * profile and the room secret to the other device so ITS copy of the chat
 * can open too, which still requires them to be online at some overlapping
 * moment (see below) but needs no action from them once they are.
 *
 * WHAT THIS DOES NOT SOLVE
 *
 * Two people still both have to be online at some overlapping moment for a
 * knock to cross — that is P2P, not a bug in this file. It DOES make that
 * moment easier to catch: a personal inbox is far less crowded than one
 * global room carrying every Spot Me user's traffic, and resume() below
 * recovers immediately when a backgrounded tab comes back instead of waiting
 * on a heartbeat that may itself have been suspended.
 */
import { joinRoom } from '@trystero-p2p/torrent'
import { RTC_CONFIG, readyRTC } from '../net.js'
import { db } from './db.js'
import { rooms } from './rooms.js'
import { pushNote } from './notify.js'

const APP_ID = 'io.ysnapai.spotme'
const HEARTBEAT_MS = 10_000
const OUTBOX_TTL_MS = 24 * 60 * 60_000   // 24 hours — was 10 min, which silently abandoned most requests

/** Stable, non-cryptographic string hash — enough to derive a room id/secret
 * both sides can compute independently, never to protect anything. */
function stableHash (input) {
  let h1 = 0xdeadbeef ^ input.length
  let h2 = 0x41c6ce57 ^ input.length
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}

/** One inbox room id per Spot Me id — never guessable from a username alone. */
const inboxRoomId = (userId) => `inbox-${stableHash(`spotme-inbox-v1:${userId}`)}`

/**
 * Deterministic conversation for a PAIR, independent of who reaches out first.
 * Sorting the ids means both sides compute the identical room without
 * exchanging anything — the knock still carries it too, belt and suspenders.
 */
function directRoom (idA, idB) {
  const [a, b] = [idA, idB].sort()
  const key = `${a}:${b}`
  return {
    roomId: `dm-${stableHash(`spotme-dm-room-v1:${key}`)}`,
    secret: stableHash(`spotme-dm-secret-v1:${key}`) + stableHash(`spotme-dm-secret-v2:${key}`)
  }
}

function createReach () {
  const subscribers = new Set()
  let inbox = null           // my own inbox room — always joined
  let knock = null
  let knockAck = null
  let relayReady = false
  let lastTick = 0
  let heartbeat = null

  function notify () { for (const fn of subscribers) fn() }
  function safe (promise) { if (promise?.catch) promise.catch(() => {}) }

  const outbox = new Map()   // peerId -> { room, payload, knockAction, first }

  /** My own inbox: joined once at boot, left only by explicit teardown. */
  function joinInbox () {
    if (inbox || !db.ready()) return
    if (!relayReady) { readyRTC().then(() => { relayReady = true; joinInbox() }); return }
    const me = db.profile()
    if (!me?.id) return

    const room = joinRoom({ appId: APP_ID, password: 'spotme-inbox', rtcConfig: RTC_CONFIG }, inboxRoomId(me.id))
    inbox = room
    knock = room.makeAction('knock')
    knockAck = room.makeAction('knockAck')

    knock.onMessage = (payload, meta) => {
      if (!payload?.from?.id || !payload.roomId || !payload.secret) return
      if (db.isBlocked(payload.from.id)) return
      // The ack must self-identify as US (the one who just received the
      // knock), not echo back the sender's own id — otherwise the sender's
      // `ack.fromId !== peer.id` check can never match and "delivered" would
      // never fire no matter how many times the knock lands.
      const receipt = () => {
        safe(knockAck.send({ fromId: db.profile().id }, meta?.peerId ? { target: meta.peerId } : undefined))
      }
      // Already have this conversation (we opened it too, or they are
      // re-knocking before hearing our ack) — just re-ack, nothing new to open.
      if (db.convo(payload.roomId)) { receipt(); return }
      db.upsertConvo({
        roomId: payload.roomId, secret: payload.secret, kind: 'dm', mode: payload.mode || 'meet',
        peer: {
          id: payload.from.id, name: payload.from.name || 'Unknown',
          avatar: payload.from.avatar || null, lang: payload.from.lang || 'en'
        },
        title: payload.from.name || 'Unknown',
        last: { text: String(payload.text || '').slice(0, 300) || 'Chat started', ts: Date.now(), fromMe: false }
      })
      db.addContact({
        id: payload.from.id, name: payload.from.name || 'Unknown',
        avatar: payload.from.avatar || null, lang: payload.from.lang || 'en'
      })
      rooms.ensure(payload.roomId)
      receipt()
      pushNote(`${payload.from.name || 'Someone'} started a chat with you`,
        String(payload.text || 'Say hi').slice(0, 120), `chat:${payload.from.id}`)
      notify()
    }

    room.onPeerJoin = (peerId) => flushOutbox(peerId)
    room.onPeerLeave = () => {}

    /**
     * Closing the app must not abandon a hello that never got through. Any
     * conversation WE opened (`initiated`) that has not been acked yet is an
     * outbound debt still owed — reopen its outbox entry so delivery keeps
     * trying. Conversations opened because a knock arrived need no outbox at
     * all: the knock already reached us, and the recipient's own convo went
     * live on our first receipt of it.
     */
    for (const convo of db.convos()) {
      if (convo.initiated && !convo.delivered && convo.peer?.id) {
        openOutbox(convo.peer, {
          from: { id: me.id, name: me.name, avatar: me.avatar, lang: me.lang },
          roomId: convo.roomId, secret: convo.secret,
          text: convo.last?.text || '', mode: convo.mode
        })
      }
    }

    lastTick = Date.now()
    heartbeat = setInterval(() => { flushOutbox(); lastTick = Date.now() }, HEARTBEAT_MS)
    window.__reach = { inbox, outbox }
  }

  /**
   * Same tell as the lobby's own resume fix: a missed heartbeat means the tab
   * was very likely suspended and the underlying connections are probably
   * dead — rejoin rather than trust a corpse. Called on regaining foreground.
   */
  function resume () {
    if (!inbox) { joinInbox(); return }
    const missed = lastTick && Date.now() - lastTick > HEARTBEAT_MS * 3
    if (missed) {
      try { inbox.leave() } catch { /* already gone */ }
      inbox = null; knock = null; knockAck = null
      joinInbox()
      return
    }
    flushOutbox()
  }

  function flushOutbox (joinedPeerId = null) {
    for (const [peerId, entry] of outbox) {
      if (Date.now() - entry.first > OUTBOX_TTL_MS) { closeOutboxEntry(peerId); continue }
      const convo = db.convo(entry.payload.roomId)
      if (!convo || convo.delivered) { closeOutboxEntry(peerId); continue }
      const live = entry.room.getPeers ? entry.room.getPeers() : {}
      if (!joinedPeerId && Object.keys(live).length === 0) continue
      safe(entry.knockAction.send(entry.payload, joinedPeerId ? { target: joinedPeerId } : undefined))
    }
  }

  function closeOutboxEntry (peerId) {
    const entry = outbox.get(peerId)
    if (!entry) return
    try { entry.room.leave() } catch { /* already gone */ }
    outbox.delete(peerId)
  }

  /** Join the recipient's inbox and start delivering, unless already doing so. */
  function openOutbox (peer, payload) {
    if (outbox.has(peer.id)) return
    const room = joinRoom({ appId: APP_ID, password: 'spotme-inbox', rtcConfig: RTC_CONFIG }, inboxRoomId(peer.id))
    const knockAction = room.makeAction('knock')
    const ackAction = room.makeAction('knockAck')
    ackAction.onMessage = (ack) => {
      if (ack?.fromId !== peer.id) return
      closeOutboxEntry(peer.id)
      const convo = db.convo(payload.roomId)
      if (convo && !convo.delivered) db.upsertConvo({ roomId: payload.roomId, delivered: true })
    }
    room.onPeerJoin = (peerId) => flushOutbox(peerId)
    outbox.set(peer.id, { room, payload, knockAction, first: Date.now() })
  }

  /**
   * Reach someone directly by id: opens the conversation on THIS device right
   * away — no waiting on the other person — and joins THEIR inbox to deliver
   * the knock so their copy opens too, whenever they are next online.
   *
   * `initiated`/`delivered` are this module's own bookkeeping, not a
   * permission gate: they only decide whether flushOutbox() above still owes
   * this peer a delivery attempt. A convo we did not open ourselves (or one
   * already acked) is never re-sent.
   */
  function reach (peer, text, mode = 'meet') {
    const me = db.profile()
    const { roomId, secret } = directRoom(me.id, peer.id)
    const existing = db.convo(roomId)
    if (existing && (!existing.initiated || existing.delivered)) return roomId

    if (!existing) {
      db.upsertConvo({
        roomId, secret, kind: 'dm', mode, initiated: true, delivered: false,
        peer: { id: peer.id, name: peer.name, avatar: peer.avatar || null, lang: peer.lang || 'en' },
        title: peer.name,
        last: { text: text || 'Chat started', ts: Date.now(), fromMe: true }
      })
      db.addContact({ id: peer.id, name: peer.name, avatar: peer.avatar || null, lang: peer.lang || 'en' })
    }
    rooms.ensure(roomId)

    const payload = {
      from: { id: me.id, name: me.name, avatar: me.avatar, lang: me.lang },
      roomId, secret, text: String(text || '').slice(0, 300), mode
    }
    if (!relayReady) { readyRTC().then(() => { relayReady = true; reach(peer, text, mode) }); return roomId }
    openOutbox(peer, payload)
    return roomId
  }

  return {
    joinInbox,
    resume,
    reach,
    subscribe (fn) { subscribers.add(fn); return () => subscribers.delete(fn) },
    stop () {
      if (heartbeat) clearInterval(heartbeat)
      for (const peerId of [...outbox.keys()]) closeOutboxEntry(peerId)
      if (inbox) inbox.leave()
      inbox = null
    }
  }
}

export const reach = createReach()
