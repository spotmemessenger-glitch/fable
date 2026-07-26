/**
 * Spot Me — app-level state.
 *
 * One persistent record for everything above a single conversation: who I am,
 * which conversations exist, pending requests, contacts and settings. Message
 * history itself lives in the per-room store (store.js) keyed by room id.
 *
 * Multi-tab testing: two tabs share localStorage, which would make them the
 * same person. `?id=<suffix>` namespaces the whole record so one browser can
 * host two independent identities for demos and tests.
 */

const url = new URL(window.location.href)
const SUFFIX = url.searchParams.get('id') ? `:${url.searchParams.get('id')}` : ''
const KEY = `spotme:app:v1${SUFFIX}`

/** Storage key namespace for per-room message stores (kept in sync). */
export const ROOM_PREFIX = `spotme:room${SUFFIX}:`

const DEFAULT_SETTINGS = {
  rangeM: 500,          // discovery slider 5..500
  showOnMap: true,      // the mandatory map on/off toggle (visibility = safety)
  demoMode: true,       // demo people so the app is alive when testing alone
  readAloud: false,     // TTS on received messages
  enterSends: true,
  lastSeen: 'everyone', // 'everyone' | 'contacts' | 'nobody' (cooperative)
  appBlur: true,        // blur the app-switcher preview
  sound: true,          // alert tone on an incoming message
  vibrate: true,        // haptic alongside the tone, where the device has one
  notifSeenTs: 0        // last time Notifications was closed — the bell badge
                        // only counts activity newer than this
}

/**
 * Erase everything this browser holds for this identity slot.
 *
 * Lives here because this module owns the key names, and a half-wipe is worse
 * than none: a surviving room store against a fresh profile id resurrects
 * conversations the new profile was never part of.
 *
 * Scoped to one `?id=` slot so resetting one test identity leaves the other
 * intact. Room keys for other slots carry an extra `:` segment after the
 * prefix, which is what distinguishes them — room ids are bare hex.
 */
export function wipeDevice () {
  const doomed = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith('spotme:')) continue
    if (key === KEY || key === 'spotme:me' || key === 'spotme:demo-seeded') { doomed.push(key); continue }
    if (key.startsWith(ROOM_PREFIX) && !key.slice(ROOM_PREFIX.length).includes(':')) doomed.push(key)
  }
  doomed.forEach((key) => localStorage.removeItem(key))
}

function randomHex (bytes = 8) {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

function load () {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const s = JSON.parse(raw)
      return {
        profile: s.profile || null,
        convos: s.convos || {},
        requests: s.requests || {},
        contacts: s.contacts || {},
        blocked: s.blocked || {},
        settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) }
      }
    }
  } catch { localStorage.removeItem(KEY) }
  return {
    profile: null,
    convos: {},
    requests: {},
    contacts: {},
    blocked: {},
    settings: { ...DEFAULT_SETTINGS }
  }
}

function createDb () {
  const state = load()
  const subscribers = new Set()
  let openRoomId = null   // thread currently on screen — its messages never count as unread

  function save () {
    try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* private mode */ }
  }

  function notify () { for (const fn of subscribers) fn() }
  function commit () { save(); notify() }

  return {
    /* ------------------------------------------------------------ profile */
    /* profile: {id, name, username?, lang, avatar, translit, autoTranslate} — username is the registry-claimed @handle; setProfile spreads patches, so it needs no structural change here. */
    ready: () => Boolean(state.profile?.name),
    profile: () => state.profile,

    setProfile (patch) {
      state.profile = {
        id: state.profile?.id || randomHex(8),
        name: '',
        lang: 'en',
        avatar: null,
        translit: true,
        autoTranslate: true,
        // Proof this device owns its username claim. Local-only: it is never
        // put in an announcement or a request (both list their fields
        // explicitly) and the registry stores only its digest.
        claimSecret: randomHex(16),
        ...state.profile,
        ...patch
      }
      commit()
      return state.profile
    },

    /* -------------------------------------------------------------- convos */
    convos: () => Object.values(state.convos)
      .sort((a, b) => (b.last?.ts || b.created) - (a.last?.ts || a.created)),

    convo: (roomId) => state.convos[roomId] || null,

    /**
     * convo: { roomId, secret, kind:'dm'|'group'|'demo', mode:'meet'|'nearby'|'bluetooth',
     *          peer:{id,name,avatar,lang}, title, created, archived, unread,
     *          last:{text,ts,fromMe}, pending,
     *          msgTtl }  — disappearing-message mode in seconds (0/absent = off);
     *                      set by 'timer' control messages from either side.
     */
    upsertConvo (convo) {
      const existing = state.convos[convo.roomId] || {}
      state.convos[convo.roomId] = {
        created: Date.now(), archived: false, unread: 0, last: null, pending: false,
        ...existing, ...convo
      }
      commit()
      return state.convos[convo.roomId]
    },

    removeConvo (roomId) {
      delete state.convos[roomId]
      try { localStorage.removeItem(ROOM_PREFIX + roomId) } catch { /* ok */ }
      commit()
    },

    setArchived (roomId, archived) {
      if (!state.convos[roomId]) return
      state.convos[roomId].archived = archived
      commit()
    },

    /** Register the latest message: preview text, ordering, unread counting. */
    bump (roomId, { text, ts, fromMe }) {
      const convo = state.convos[roomId]
      if (!convo) return
      convo.last = { text: String(text).slice(0, 120), ts: ts || Date.now(), fromMe: Boolean(fromMe) }
      // Only a message FROM the peer proves they accepted — my own sends must
      // not clear the pending gate.
      if (!fromMe) convo.pending = false
      if (!fromMe && roomId !== openRoomId) convo.unread = (convo.unread || 0) + 1
      commit()
    },

    /* Alerts consult this too: a message for the thread you are already
     * reading must not ding, exactly as it does not count as unread. */
    openRoom: () => openRoomId,
    setOpenRoom (roomId) {
      openRoomId = roomId
      if (roomId && state.convos[roomId]?.unread) {
        state.convos[roomId].unread = 0
        commit()
      }
    },

    clearUnread (roomId) {
      if (state.convos[roomId]?.unread) {
        state.convos[roomId].unread = 0
        commit()
      }
    },

    totalUnread: () => Object.values(state.convos)
      .reduce((sum, c) => sum + (c.archived ? 0 : (c.unread || 0)), 0),

    /* ------------------------------------------------------------ requests */
    requests: () => Object.values(state.requests).sort((a, b) => b.ts - a.ts),

    /** request: { fromId, name, avatar, lang, text, roomId, secret, mode, ts } */
    addRequest (req) {
      if (!req?.fromId || state.blocked[req.fromId]) return false
      // A repeat request from the same person replaces, never stacks.
      state.requests[req.fromId] = { ts: Date.now(), ...req }
      commit()
      return true
    },

    removeRequest (fromId) {
      delete state.requests[fromId]
      commit()
    },

    /* ------------------------------------------------------------ contacts */
    contacts: () => Object.values(state.contacts)
      .sort((a, b) => a.name.localeCompare(b.name)),

    addContact (c) {
      if (!c?.id) return
      state.contacts[c.id] = { added: Date.now(), ...state.contacts[c.id], ...c }
      commit()
    },

    removeContact (id) { delete state.contacts[id]; commit() },

    /* -------------------------------------------------------------- blocks */
    block (id, name) {
      state.blocked[id] = { id, name: name || '', ts: Date.now() }
      delete state.requests[id]
      commit()
    },
    unblock (id) { delete state.blocked[id]; commit() },
    isBlocked: (id) => Boolean(state.blocked[id]),
    blocked: () => Object.values(state.blocked),

    /* ------------------------------------------------------------ settings */
    settings: () => state.settings,
    setSettings (patch) {
      state.settings = { ...state.settings, ...patch }
      commit()
    },

    /* ----------------------------------------------------------------- sub */
    subscribe (fn) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    }
  }
}

export const db = createDb()
export { randomHex }

// Debug/test handle, same spirit as window.__rooms / window.__lobby.
if (typeof window !== 'undefined') window.__db = db
