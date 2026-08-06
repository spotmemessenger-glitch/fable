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
 * WHAT THIS DOES NOT SOLVE (mostly — see the relay below)
 *
 * Two people still both have to be online at some overlapping moment for a
 * knock to cross P2P — that is inherent to P2P, not a bug in this file. It
 * DOES make that moment easier to catch: a personal inbox is far less
 * crowded than one global room carrying every Spot Me user's traffic, and
 * resume() below recovers immediately when a backgrounded tab comes back
 * instead of waiting on a heartbeat that may itself have been suspended.
 *
 * THE RELAY (owner decision 2026-07-26): P2P alone still loses a knock if
 * the SENDER goes offline before the recipient ever comes online — nothing
 * durable held it, so there was nothing left to retry. reach() now also
 * persists the same knock payload to a tiny server relay (api/knock.js,
 * backed by the Upstash Redis already used for push — see that file for
 * why), best-effort and non-blocking. The recipient's device checks the
 * relay on boot and on regaining focus, feeds anything found through the
 * exact same receiveKnock() path a live P2P knock uses, then acks it. The
 * relay only ever holds the OPENING knock, never anything exchanged after
 * the chat is live — everything past that stays P2P-only, unchanged.
 */
// Rooms come from the transport seam; setRoomKey stays a direct import because
// it is KEY MATERIAL, which no adapter may carry (ADR-002 §2, FORBIDDEN_KEY_SURFACE).
import { joinRoom } from './transport/room.js'
import { setRoomKey, freshTokens, serverMode } from './socket-transport.js'
import { RTC_CONFIG, readyRTC } from '../net.js'
import { db } from './db.js'
import { rooms } from './rooms.js'
import { pushNote } from './notify.js'
import { pokePeer } from './push.js'
import { E2E_V1, E2E_V2, deriveRoomKey } from './crypto/e2e-v2.js'
import { loadIdentity, fetchPeerKey } from './crypto/identity-store.js'

const APP_ID = 'io.ysnapai.spotme'
const HEARTBEAT_MS = 10_000
const OUTBOX_TTL_MS = 24 * 60 * 60_000   // 24 hours — was 10 min, which silently abandoned most requests

import { API_BASE as API_ORIGIN } from './api.js'
import { authHeaders } from './auth-headers.js'
const KNOCK_ENDPOINT = `${API_ORIGIN}/api/knock`

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
 * Place the line a knock carried into the room's thread.
 *
 * Never throws: a first message that cannot be shown must not take the knock —
 * and therefore the whole conversation — down with it.
 */
function firstMessage (roomId, { id, from, name, lang, text }) {
  try {
    rooms.injectLocal(roomId, {
      id, from, name, lang, ts: Date.now(), kind: 'text', text
    })
  } catch { /* the conversation still opens; only its opening line is missing */ }
}

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
    // V-19: this secret is a NON-CRYPTOGRAPHIC hash of two ids the server
    // stores, so the server can recompute it. It is retained ONLY because
    // existing rooms were built with it and changing it would make their
    // history unreadable forever. New rooms take the e2e_v2 path below and
    // never use this value. See ADR-001.
    secret: stableHash(`spotme-dm-secret-v1:${key}`) + stableHash(`spotme-dm-secret-v2:${key}`)
  }
}

/**
 * Try to make this room an e2e_v2 room: fetch the peer's published public key,
 * agree a key with our own non-exportable identity, and install it before the
 * room is ever joined.
 *
 * Returns the sender's public key on success, null on any failure — and null is
 * an ORDINARY outcome, not an error. Every account that predates this feature
 * has no published key, so falling back to v1 is the common case for now. The
 * caller records which scheme was actually used; what must never happen is a
 * room labelled v2 that is really v1.
 */
async function prepareV2 (peerId, roomId) {
  try {
    const identity = await loadIdentity()
    if (!identity?.privateKey) return null
    const { accessToken } = await freshTokens()
    const peer = await fetchPeerKey(peerId, accessToken)
    if (!peer?.publicKey) return null
    const key = await deriveRoomKey({ identity, peerPublicKeyB64: peer.publicKey, roomId })
    setRoomKey(roomId, key)              // must precede joinRoom, or PBKDF2 wins the cache
    // BOTH keys come back. `myKey` goes on the wire so the peer can agree;
    // `peerKey` is persisted so THIS device can re-derive after a reload —
    // returning only our own key (an earlier bug) made that impossible.
    return { myKey: identity.publicKeyB64, peerKey: peer.publicKey }
  } catch {
    return null
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
  /** roomId -> our public key for that room, or null once agreement has been
   *  attempted and failed. Presence of the roomId means "already attempted",
   *  which is what stops reach() re-entering forever. */
  const v2State = new Map()

  /**
   * Open the conversation a knock describes, whichever transport it arrived
   * over — a live P2P message or a server-relay fetch. Idempotent: a room we
   * already hold is a safe no-op, so callers never need to dedupe first.
   * Returns 'invalid' | 'blocked' | 'duplicate' | 'created' so a caller can
   * decide what needs an ack and what does not.
   */
  function receiveKnock (payload) {
    if (!payload?.from?.id || !payload.roomId || !payload.secret) return 'invalid'
    if (db.isBlocked(payload.from.id)) return 'blocked'
    if (db.convo(payload.roomId)) return 'duplicate'

    /* The sender says this is a v2 room and hands us their public key. Agree the
     * same key from our own identity and install it BEFORE the room is joined,
     * exactly as the sending side does — otherwise PBKDF2 over the (worthless)
     * v1 secret wins the cache and neither side can open the other's messages.
     * Agreement that fails downgrades this room to v1 and RECORDS that, rather
     * than leaving a room that claims v2 and is not. */
    const wantsV2 = payload.e2eVersion === E2E_V2 && typeof payload.senderKey === 'string'
    let e2eVersion = wantsV2 ? E2E_V2 : E2E_V1
    if (wantsV2) {
      loadIdentity()
        .then((identity) => identity?.privateKey
          ? deriveRoomKey({ identity, peerPublicKeyB64: payload.senderKey, roomId: payload.roomId })
          : null)
        .then((key) => {
          if (key) { setRoomKey(payload.roomId, key); rooms.ensure(payload.roomId); return }
          // Agreement failed: record the DOWNGRADE rather than leaving a room
          // labelled v2 that is really keyed v1, and drop the now-meaningless
          // peerKey so the boot re-derivation does not keep retrying it.
          db.upsertConvo({ roomId: payload.roomId, e2eVersion: E2E_V1, peerKey: null })
          rooms.ensure(payload.roomId)
        })
        .catch(() => {
          db.upsertConvo({ roomId: payload.roomId, e2eVersion: E2E_V1, peerKey: null })
          rooms.ensure(payload.roomId)
        })
    }

    db.upsertConvo({
      roomId: payload.roomId, secret: payload.secret, kind: 'dm', mode: payload.mode || 'meet',
      // `peerKey` is THEIR key, on both sides — the sender's knock carries it
      // as `senderKey`, and from here it is stored under the same name the
      // initiator uses so boot re-derivation works identically either way.
      e2eVersion, peerKey: payload.senderKey || null,
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
    /* THE FIRST LINE IS A MESSAGE, NOT JUST A PREVIEW.
     *
     * It used to reach `last` and `pushNote` and stop there, so the
     * notification quoted the text and the thread was empty when the chat was
     * opened — "it shows in notifications but not the actual message". The id
     * rides in the knock so the live P2P copy and the relay copy land as ONE
     * message; a sender on an older build sends none, and the fallback keeps
     * that deterministic per room so its two copies still collapse. */
    if (payload.text) {
      firstMessage(payload.roomId, {
        id: payload.msgId || `k_${stableHash(`${payload.roomId}:${payload.from.id}:${payload.text}`)}`,
        from: payload.from.id, name: payload.from.name || 'Unknown',
        lang: payload.from.lang || 'en', text: String(payload.text).slice(0, 300)
      })
    }
    // A v2 room is joined by the agreement continuation above, NOT here. Joining
    // now would derive a key from the v1 password and win the cache before
    // agreement finishes, leaving both sides unable to open each other's
    // messages — the failure would look like "chat is broken", not "crypto is
    // misconfigured", which is exactly the kind that costs a day to find.
    if (!wantsV2) rooms.ensure(payload.roomId)
    pushNote(`${payload.from.name || 'Someone'} started a chat with you`,
      String(payload.text || 'Say hi').slice(0, 120), `chat:${payload.from.id}`)
    notify()
    return 'created'
  }

  /**
   * Best-effort backup for a knock reach() just sent P2P: hand the same
   * payload to the server relay so it survives us going offline before the
   * recipient ever comes online. Never blocks or throws — P2P delivery above
   * is still the primary path, this only covers its one blind spot.
   */
  /* The relay authenticates now: it holds room SECRETS, and it used to hand
   * them to anyone who named a user id. `authHeaders()` fails open to an
   * unauthenticated attempt, which earns a clean 401 rather than a hang — and
   * `safe()` already swallows that, so a token that is not ready yet degrades
   * to "P2P only", which is what this path was before the relay existed. */
  function relayStore (toId, payload) {
    safe(authHeaders().then((headers) => fetch(KNOCK_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'store', toId, knock: payload })
    })))
  }

  /**
   * Pull anything the relay is holding for us, open each one exactly like a
   * live knock would, then ack (delete) what we fetched so it is not handed
   * back again next time. Called on boot and on regaining foreground.
   */
  async function checkRelay () {
    const me = db.profile()
    if (!me?.id) return
    let knocks
    try {
      // The server reads the inbox owner off the token; the query parameter it
      // used to trust is gone.
      const res = await fetch(KNOCK_ENDPOINT, { headers: await authHeaders() })
      if (!res.ok) return
      const data = await res.json()
      knocks = Array.isArray(data?.knocks) ? data.knocks : []
    } catch { return }
    if (!knocks.length) return
    for (const payload of knocks) receiveKnock(payload)
    safe(authHeaders().then((headers) => fetch(KNOCK_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'ack', roomIds: knocks.map((k) => k.roomId) })
    })))
  }

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
      /* THE TRANSPORT ALREADY KNOWS WHO SENT THIS. USE IT.
       *
       * `meta.peerId` is server-authenticated — rooms.gateway builds every
       * frame's `from` out of `client.data.userId`, which comes from the JWT
       * `sub`, so a peer cannot forge it. This handler had it in hand, used it
       * only to address the ack, and took `payload.from.id` on trust for
       * everything that mattered.
       *
       * That let any authenticated user post a knock claiming to be anyone.
       * `receiveKnock` then stores the ATTACKER's chosen `roomId`, `secret` and
       * `peer.id` — so the victim opens a chat labelled with a friend's name,
       * in a room the attacker picked, under a key the attacker chose, and
       * reads and writes everything in it. No cryptography is broken; it is
       * simply never invoked.
       *
       * A knock that disagrees with the transport is not a knock.
       *
       * ONLY IN SERVER MODE, and the distinction is not pedantic. `selfId` is
       * `db.profile().id` on the socket transport but `torrent.selfId` — a
       * per-session connection id — under the `spotme.transport = p2p` escape
       * hatch. There, peer ids are not account ids and never claimed to be, so
       * comparing them would reject every legitimate knock. Enforce the rule
       * where the guarantee exists; do not invent one where it does not. */
      if (serverMode && meta?.peerId && payload?.from?.id !== meta.peerId) return
      const status = receiveKnock(payload)
      if (status === 'invalid' || status === 'blocked') return
      // The ack must self-identify as US (the one who just received the
      // knock), not echo back the sender's own id — otherwise the sender's
      // `ack.fromId !== peer.id` check can never match and "delivered" would
      // never fire no matter how many times the knock lands.
      safe(knockAck.send({ fromId: db.profile().id }, meta?.peerId ? { target: meta.peerId } : undefined))
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
    // A `window.__reach = { inbox, outbox }` debug handle used to live here. It
    // published live room objects and every pending knock — profile, roomId and
    // room secret — to anything sharing the page: an injected script, a browser
    // extension, a devtools snippet. Hardening key derivation while leaving the
    // keys reachable from `window` would have been theatre.
    checkRelay()
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
    checkRelay()
  }

  function flushOutbox (joinedPeerId = null) {
    for (const [peerId, entry] of outbox) {
      if (Date.now() - entry.first > OUTBOX_TTL_MS) { closeOutboxEntry(peerId); continue }
      const convo = db.convo(entry.payload.roomId)
      if (!convo || convo.delivered) { closeOutboxEntry(peerId); continue }
      const live = entry.room.getPeers ? entry.room.getPeers() : {}
      // A durable transport persists the knock server-side, so an empty inbox
      // is no reason to hold delivery — the recipient replays it on next boot.
      if (!entry.room.DURABLE && !joinedPeerId && Object.keys(live).length === 0) continue
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

    /* THE CONVO IS WRITTEN FIRST, ALWAYS.
     *
     * An earlier revision kicked off key agreement and returned `roomId` before
     * upsertConvo ran, so the caller opened a thread for a conversation that
     * did not exist yet — every new chat bounced off "Conversation not found"
     * on the first tap. Persist the record, THEN agree the key, THEN join. */
    if (!existing) {
      db.upsertConvo({
        roomId, secret, kind: 'dm', mode, initiated: true, delivered: false,
        e2eVersion: E2E_V1, peerKey: null,      // upgraded below iff agreement lands
        peer: { id: peer.id, name: peer.name, avatar: peer.avatar || null, lang: peer.lang || 'en' },
        title: peer.name,
        last: { text: text || 'Chat started', ts: Date.now(), fromMe: true }
      })
      db.addContact({ id: peer.id, name: peer.name, avatar: peer.avatar || null, lang: peer.lang || 'en' })
    }

    /* Key agreement must SETTLE before the room is joined — the agreed key has
     * to be installed before anything is sealed with it. reach() stays
     * synchronous for its callers by re-entering once agreement resolves, the
     * same shape the relayReady gate further down already uses. */
    if (!v2State.has(roomId)) {
      v2State.set(roomId, null)
      prepareV2(peer.id, roomId).then((agreed) => {
        v2State.set(roomId, agreed || null)
        if (agreed) {
          // peerKey is THEIR key on both sides of the conversation, so either
          // device can re-derive after a reload. Storing our own key here (an
          // earlier bug) left the initiator unable to re-derive at all.
          db.upsertConvo({ roomId, e2eVersion: E2E_V2, peerKey: agreed.peerKey })
        }
        reach(peer, text, mode)
      })
      return roomId
    }

    const agreed = v2State.get(roomId)
    // A room is v2 only if agreement actually produced a key. Never label a
    // room by what was attempted — only by what happened.
    const e2eVersion = agreed ? E2E_V2 : (db.convo(roomId)?.e2eVersion || E2E_V1)
    const senderKey = agreed?.myKey ?? null

    rooms.ensure(roomId)

    /* One id for this knock's opening line, deterministic per room so that
     * reach()'s own re-entry after key agreement, the live P2P knock and the
     * relay copy all resolve to the SAME message instead of three. */
    const msgId = `k_${stableHash(`${roomId}:${me.id}:${String(text || '')}`)}`

    const payload = {
      from: { id: me.id, name: me.name, avatar: me.avatar, lang: me.lang },
      roomId, secret, text: String(text || '').slice(0, 300), mode,
      // The recipient needs our public key to agree the same key. `secret` still
      // rides along for v1 rooms and for peers on an older build; a v2 recipient
      // ignores it entirely.
      e2eVersion, senderKey, msgId
    }

    // Our own opening line belongs in our own thread too — without this the
    // sender watched their first message vanish as the chat opened.
    if (text) {
      firstMessage(roomId, {
        id: msgId, from: me.id, name: me.name, lang: me.lang,
        text: String(text).slice(0, 300)
      })
    }
    // Both are plain HTTP, independent of WebRTC/TURN readiness — no reason
    // to make them wait behind the relayReady gate below.
    relayStore(peer.id, payload)
    pokePeer(peer.id)
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
