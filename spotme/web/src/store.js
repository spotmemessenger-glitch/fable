/**
 * Spot Me web — conversation state.
 *
 * Holds messages, reactions and peer profiles, deduplicates them, and persists
 * to localStorage so a refresh does not wipe the conversation.
 *
 * ---------------------------------------------------------------------------
 * WHY DEDUPLICATION IS NOT OPTIONAL
 *
 * There is no server ordering messages. On join, EVERY peer already in the room
 * offers backlog, so a two-peer room hands the joiner two overlapping copies,
 * and those overlap again with messages arriving live. Without keying by id,
 * the transcript visibly duplicates within seconds of a third person joining.
 *
 * Ordering is by timestamp with the message id as tiebreak. Clocks across
 * devices are not synchronised, so this is best-effort, not the deterministic
 * merge Autobase gives the native app. Two phones seconds apart can legitimately
 * disagree about order — an accepted limitation of the web transport.
 * ------------------------------------------------------------------------- */

const STORAGE_PREFIX = 'spotme:room:'

/** Bounded so a long-lived room cannot fill localStorage and start throwing. */
const MAX_STORED = 500

/** Writes are coalesced over this window — see save(). */
const SAVE_DEBOUNCE_MS = 250

/**
 * @param roomId    conversation id, used to build the storage key
 * @param prefix    storage-key prefix
 * @param options   `selfId` — id (or getter) of this device's user, so quota
 *                  shedding can tell the user's own recordings from everyone
 *                  else's; `onShed` — called when media had to be dropped from
 *                  the persisted copy, so somebody can say so out loud.
 */
export function createStore (roomId, prefix = STORAGE_PREFIX, options = {}) {
  const key = prefix + roomId
  const { selfId = null, onShed = null } = options
  const mine = (message) => {
    const me = typeof selfId === 'function' ? selfId() : selfId
    return Boolean(me) && message.from === me
  }

  const messages = new Map()          // id -> message
  const reactions = new Map()         // targetId -> Map(from -> emoji)
  const profiles = new Map()          // peerId -> {name, lang}
  // Ids that were deleted here (tombstones). Without these, a peer's history
  // backlog resurrects view-once photos and deleted messages on every
  // reconnect — the ids are absent from the map, so mergeHistory would
  // happily re-add them. Bounded, persisted alongside the messages.
  const tombstones = new Set()
  const TOMBSTONE_MAX = 1000
  const subscribers = new Set()
  let saveTimer = null
  let dirty = false

  load()

  /* A debounced write must not be able to lose the tail of a conversation
   * because the tab went away first. pagehide covers iOS (where unload never
   * fires) and visibilitychange covers a backgrounded tab that is then killed. */
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush()
      })
    }
  }

  function load () {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return
      const saved = JSON.parse(raw)
      for (const id of saved.tombstones || []) tombstones.add(id)
      for (const message of saved.messages || []) {
        if (!tombstones.has(message.id)) messages.set(message.id, message)
      }
      for (const [target, entries] of Object.entries(saved.reactions || {})) {
        reactions.set(target, new Map(Object.entries(entries)))
      }
      for (const [peer, profile] of Object.entries(saved.profiles || {})) {
        profiles.set(peer, profile)
      }
    } catch {
      // Corrupt or truncated storage should never stop the app booting; an
      // empty room is a far better outcome than a white screen.
      localStorage.removeItem(key)
    }
  }

  /**
   * Persist, eventually.
   *
   * Every add, patch, reaction and profile sync used to re-stringify the whole
   * conversation synchronously, and a single attachment fires several patches:
   * measured send latency grew 279ms -> 901ms over twenty voice notes in one
   * room, monotonically, because the JSON kept getting bigger. Coalescing the
   * burst costs one timer and nothing else.
   *
   * The window is short and every way a page can go away flushes it, so the
   * exposure is a hard crash inside 250ms of a write — strictly better than
   * the old behaviour, where the same crash lost the write anyway while also
   * blocking the main thread on the way in.
   */
  function save () {
    dirty = true
    if (saveTimer) return
    saveTimer = setTimeout(() => { saveTimer = null; flush() }, SAVE_DEBOUNCE_MS)
  }

  function flush () {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    if (!dirty) return
    dirty = false
    writeNow()
  }

  function writeNow () {
    const ordered = list().slice(-MAX_STORED)
    const envelope = (messages) => JSON.stringify({
      messages,
      reactions: Object.fromEntries(
        Array.from(reactions, ([target, map]) => [target, Object.fromEntries(map)])
      ),
      profiles: Object.fromEntries(profiles),
      tombstones: Array.from(tombstones).slice(-TOMBSTONE_MAX)
    })

    try {
      localStorage.setItem(key, envelope(ordered.map(stripDerived)))
      return
    } catch {
      // Out of quota — almost always one video. Fall through and shed it.
    }

    /* One 40 MB video base64s to ~53 MB against a quota of five to ten, so the
     * write threw and the catch swallowed it: the ENTIRE conversation then
     * stopped persisting, silently, and stayed broken. Losing one video's bytes
     * is a fair trade; losing the conversation is not. Shed the heaviest media
     * first and keep shedding until it fits, so small photos survive even when
     * a video does not.
     *
     * INCOMING BEFORE OUTGOING. Heaviest-first alone was written for videos,
     * and it was right for them — but a voice note is now the heaviest thing in
     * an ordinary chat, so the rule started eating the user's own recordings
     * first. That is the worst possible thing to drop: for everything they
     * received, the sender still has a copy, but for something they recorded,
     * this device and the server log are all there is, and "Voice note — tap to
     * load" appearing under your own message reads as data loss. Their media
     * goes first, heaviest of theirs first; ours is touched only when nothing
     * of theirs is left. */
    const byWeight = ordered
      .map((m, i) => ({ i, own: mine(m) ? 1 : 0, size: typeof m.data === 'string' ? m.data.length : 0 }))
      .filter((x) => x.size > 0)
      .sort((a, b) => (a.own - b.own) || (b.size - a.size))

    const dropped = new Set()
    let ownDropped = 0
    for (const { i, own } of byWeight) {
      dropped.add(i)
      ownDropped += own
      try {
        localStorage.setItem(key, envelope(
          ordered.map((m, idx) => dropped.has(idx) ? shedMedia(m) : stripDerived(m))
        ))
        announceShed(dropped.size, ownDropped)
        return
      } catch {
        // Still too big. Shed the next heaviest.
      }
    }

    try {
      // Nothing left to shed: text alone. If even that fails the room is
      // memory-only for this session, which is the old behaviour.
      localStorage.setItem(key, envelope(ordered.map(shedMedia)))
      announceShed(byWeight.length, byWeight.filter((x) => x.own).length)
    } catch { /* private mode, or a quota this cannot fit */ }
  }

  /* The shed only ever touched the SERIALISED copy, so the tab kept showing
   * the audio it had already dropped from disk and the user found out on the
   * next reload, days later, with no idea why. Say it when it happens — and
   * only when it gets worse, so a chat parked at the quota does not nag. */
  let shedAnnounced = 0
  function announceShed (count, own) {
    if (!onShed || count <= shedAnnounced) { shedAnnounced = count; return }
    shedAnnounced = count
    try { onShed({ count, own }) } catch { /* never let a listener break a write */ }
  }

  /**
   * Reactions are folded in at read time, so they must not be persisted twice.
   *
   * A VIEW-ONCE PHOTO'S BYTES NEVER REACH THE DISK. They used to: `add()`
   * wrote the assembled data URL straight through to localStorage with no
   * branch for viewOnce, so the full-resolution photo was readable out of
   * `JSON.parse(localStorage['spotme:room:…']).messages` from the moment it
   * arrived — before it was ever opened, silently, surviving reloads, with the
   * sender still shown "not opened yet". Losing them on reload is the correct
   * behaviour for a photo that is supposed to exist once; the message is kept
   * as a detached envelope so the mask still renders and the bytes can be
   * fetched (once, from the server, which now enforces that) on open.
   */
  function stripDerived (message) {
    const { reactions: _ignored, ...rest } = message
    if (rest.viewOnce && typeof rest.data === 'string') return shedMedia(rest)
    return rest
  }

  /**
   * The message without its payload, marked the same way a lazily-transferred
   * attachment is. That is not a cosmetic choice: `detached` already means
   * "the bytes live on a peer, tap to fetch them", and the machinery to go get
   * them exists. So shedding a video to save the conversation costs a tap
   * later rather than losing the video.
   *
   * The mime type is carried across because it is otherwise only recoverable
   * from the data URL prefix that is being dropped.
   */
  function shedMedia (message) {
    const { reactions: _ignored, data, ...rest } = message
    if (typeof data !== 'string') return rest
    return {
      ...rest,
      data: null,
      detached: true,
      mime: message.mime || data.slice(5, data.indexOf(';'))
    }
  }

  function notify () {
    for (const subscriber of subscribers) subscriber()
  }

  function add (message) {
    if (!message?.id) return false
    // Attachment kinds carry an empty caption; text is always a string.
    if (typeof message.text !== 'string') {
      if (message.kind && message.kind !== 'text') message = { ...message, text: '' }
      else return false
    }
    if (messages.has(message.id) || tombstones.has(message.id)) return false
    messages.set(message.id, message)
    save()
    notify()
    return true
  }

  /**
   * Delete without residue — no "message was deleted" placeholder, per the
   * product decision ("unlike WhatsApp"). Cooperative across peers: our UI
   * honours every tombstone, a modified client could not be forced to.
   */
  /** Merge fields into an existing message (e.g. lazily fetched bytes). */
  function patch (id, fields) {
    const existing = messages.get(id)
    if (!existing) return false
    messages.set(id, { ...existing, ...fields })
    save()
    notify()
    return true
  }

  function remove (id) {
    // Tombstone even when we never held the message — a 'del' can arrive
    // before the backlog copy does, and must still win.
    tombstones.add(id)
    const existed = messages.delete(id)
    reactions.delete(id)
    save()
    if (existed) notify()
    return existed
  }

  /**
   * Merge backlog from a peer. Returns how many were new, so the caller can
   * skip re-rendering when a redundant copy arrives from a second peer.
   */
  function mergeHistory (incoming) {
    let added = 0
    for (let message of incoming) {
      if (!message?.id || messages.has(message.id) || tombstones.has(message.id)) continue
      if (typeof message.text !== 'string') {
        if (message.kind && message.kind !== 'text') message = { ...message, text: '' }
        else continue
      }
      messages.set(message.id, message)
      added += 1
    }
    if (added > 0) {
      save()
      notify()
    }
    return added
  }

  /**
   * One reaction per person per message — a second tap replaces the first
   * rather than stacking, which is what people expect and also stops a peer
   * flooding a message with unbounded entries.
   */
  function addReaction ({ target, emoji, from }) {
    if (!target || !emoji || !from) return
    if (!reactions.has(target)) reactions.set(target, new Map())
    reactions.get(target).set(from, emoji)
    save()
    notify()
  }

  function addProfile (peerId, profile) {
    if (!peerId || !profile?.name) return
    profiles.set(peerId, { name: profile.name, lang: profile.lang || 'en' })
    save()
    notify()
  }

  /** Messages in display order, with reactions folded in. */
  function list () {
    return Array.from(messages.values())
      .sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : 1))
      .map((message) => ({
        ...message,
        reactions: Array.from(reactions.get(message.id) || [], ([from, emoji]) => ({ from, emoji }))
      }))
  }

  function subscribe (fn) {
    subscribers.add(fn)
    return () => subscribers.delete(fn)
  }

  function clear () {
    messages.clear()
    reactions.clear()
    profiles.clear()
    // A pending debounced write would otherwise resurrect what was just wiped.
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    dirty = false
    localStorage.removeItem(key)
    notify()
  }

  return {
    add,
    patch,
    remove,
    mergeHistory,
    addReaction,
    addProfile,
    list,
    profiles: () => profiles,
    subscribe,
    clear,
    /** Force the pending write out now (tests, and anything about to navigate). */
    flush,
    get size () { return messages.size }
  }
}

/**
 * Local identity, stable across reloads.
 *
 * Deliberately NOT the 24-word recovery phrase of the native app — that needs
 * the Hypercore log to be worth anything. This is a browser-local handle only:
 * clear site data and it is gone, with no way back.
 */
const IDENTITY_KEY = 'spotme:me'

export function loadIdentity () {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    localStorage.removeItem(IDENTITY_KEY)
  }
  return null
}

export function saveIdentity (identity) {
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity))
  } catch {
    // Private browsing. The name simply will not survive a reload.
  }
}
