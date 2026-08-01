/**
 * Spot Me — app-level state.
 *
 * One persistent record for everything above a single conversation: who I am,
 * which conversations exist, contacts and settings. Message history itself
 * lives in the per-room store (store.js) keyed by room id.
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
 *
 * TWO PREFIXES, NOT ONE. This filter used to match `spotme:` only, and the
 * transport names its keys with a DOT — `spotme.server.tokens`,
 * `spotme.cursor.<profileId>.<roomId>` (socket-transport.js:37,43). So "clear
 * all data" left the server access AND refresh tokens on the device: after a
 * wipe the browser could still authenticate to the backend as the identity the
 * user had just erased. It also left the replay cursors, which name every room
 * the user took part in and how far they read. Both are now removed.
 *
 * `spotme.transport` is deliberately kept: it is a debug opt-out
 * (`'p2p'` restores Trystero), not user data, and silently reverting it turns
 * a wipe into a transport change nobody asked for.
 *
 * Still true after this fix, and worth saying plainly: a wipe is LOCAL. It
 * deletes nothing from the server, and it cannot revoke the refresh token
 * server-side because there is no endpoint for that yet.
 */
export function wipeDevice () {
  const profileId = db.profile()?.id
  // No profile means no way to tell this slot's cursors from another's — and a
  // wipe with no identity should err toward deleting more, not less.
  const cursorPrefix = profileId ? `spotme.cursor.${profileId}.` : 'spotme.cursor.'
  const doomed = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key) continue
    if (key === 'spotme.server.tokens' || key.startsWith(cursorPrefix)) { doomed.push(key); continue }
    if (!key.startsWith('spotme:')) continue
    if (key === KEY || key === 'spotme:me' || key === 'spotme:demo-seeded') { doomed.push(key); continue }
    // Translated message text, keyed BY the original message text
    // (lib/translate.js CACHE_KEY). Message content, so it goes with the rest.
    if (key.startsWith('spotme:tcache:')) { doomed.push(key); continue }
    if (key.startsWith(ROOM_PREFIX) && !key.slice(ROOM_PREFIX.length).includes(':')) doomed.push(key)
  }
  doomed.forEach((key) => localStorage.removeItem(key))

  /* THE IDENTITY KEY IS NOT IN localStorage, AND IT IS THE ONE THING A WIPE MOST
   * HAS TO REMOVE. The loop above walks localStorage only, so "Clear all data"
   * left the X25519 private key sitting in IndexedDB. The next launch minted a
   * NEW random account id and then published that SAME old key against it —
   * anyone who recorded the old public key could link the erased identity to the
   * fresh one, and the key that opens the server's retained ciphertext for the
   * supposedly-erased conversations was still on the device.
   *
   * Deleting the database is not enough on its own: identity-store caches the
   * record in a module variable, so without `forgetIdentity()` the key stays
   * live in memory for the rest of the page and gets written straight back. */
  // Imported lazily so db.js stays a leaf module: it is imported by nearly
  // every view, and a static import of the crypto tree would pull api.js and
  // e2e-v2.js in behind it for every one of them.
  import('./crypto/identity-store.js')
    .then((m) => m.forgetIdentity?.())
    .catch(() => { /* crypto never loaded on this device; nothing cached */ })
  try { indexedDB.deleteDatabase('spotme-e2e') } catch { /* private mode, or no IDB at all */ }

  /* AND the identity-pin database, which is a SEPARATE one (see ADR-005 §4 for
   * why it has to be). It holds, per peer: their user id, their public key, and
   * a timestamped history of every time that key changed. That is a record of
   * who this device talked to and when — exactly the thing "Clear all data"
   * exists to remove, and exactly as invisible as the media leak the block
   * below was added for. A1 created this database; A2 is what first writes to
   * it, so this is the change that makes leaving it behind a real leak rather
   * than an empty one. */
  try { indexedDB.deleteDatabase('spotme-identity-pins') } catch { /* as above */ }

  /* Media lives in IndexedDB, not localStorage, so a prefix sweep cannot reach
   * it. Without this line "Clear all data" would leave every photo and voice
   * note this device ever received on disk — a worse leak than the one the
   * button exists to fix, and an invisible one. Imported lazily and never
   * awaited so db.js keeps no load-time dependency on a browser API that the
   * packaged WebView, private mode, or the Node tests may not provide. */
  void import('./blobstore.js').then((blobs) => blobs.clearAll()).catch(() => {})
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
        contacts: s.contacts || {},
        blocked: s.blocked || {},
        settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) }
      }
    }
  } catch { localStorage.removeItem(KEY) }
  return {
    profile: null,
    convos: {},
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
     *          last:{text,ts,fromMe}, initiated, delivered,
     *          msgTtl }  — disappearing-message mode in seconds (0/absent = off);
     *                      set by 'timer' control messages from either side.
     *                      initiated/delivered are reach.js's own bookkeeping
     *                      for whether the opening hello still needs resending —
     *                      chats are live the instant either side reaches out,
     *                      there is no separate accept step.
     */
    upsertConvo (convo) {
      const existing = state.convos[convo.roomId] || {}
      state.convos[convo.roomId] = {
        created: Date.now(), archived: false, unread: 0, last: null,
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
