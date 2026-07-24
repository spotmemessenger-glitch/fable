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

export function createStore (roomId) {
  const key = STORAGE_PREFIX + roomId

  const messages = new Map()          // id -> message
  const reactions = new Map()         // targetId -> Map(from -> emoji)
  const profiles = new Map()          // peerId -> {name, lang}
  const subscribers = new Set()

  load()

  function load () {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return
      const saved = JSON.parse(raw)
      for (const message of saved.messages || []) messages.set(message.id, message)
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

  function save () {
    try {
      const ordered = list()
      localStorage.setItem(key, JSON.stringify({
        messages: ordered.slice(-MAX_STORED).map(stripDerived),
        reactions: Object.fromEntries(
          Array.from(reactions, ([target, map]) => [target, Object.fromEntries(map)])
        ),
        profiles: Object.fromEntries(profiles)
      }))
    } catch {
      // Quota exceeded, or Safari private mode where writes throw. The room
      // still works in memory for this session.
    }
  }

  /** Reactions are folded in at read time, so they must not be persisted twice. */
  function stripDerived (message) {
    const { reactions: _ignored, ...rest } = message
    return rest
  }

  function notify () {
    for (const subscriber of subscribers) subscriber()
  }

  function add (message) {
    if (!message?.id || typeof message.text !== 'string') return false
    if (messages.has(message.id)) return false
    messages.set(message.id, message)
    save()
    notify()
    return true
  }

  /**
   * Merge backlog from a peer. Returns how many were new, so the caller can
   * skip re-rendering when a redundant copy arrives from a second peer.
   */
  function mergeHistory (incoming) {
    let added = 0
    for (const message of incoming) {
      if (!message?.id || messages.has(message.id)) continue
      if (typeof message.text !== 'string') continue
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
    localStorage.removeItem(key)
    notify()
  }

  return {
    add,
    mergeHistory,
    addReaction,
    addProfile,
    list,
    profiles: () => profiles,
    subscribe,
    clear,
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
