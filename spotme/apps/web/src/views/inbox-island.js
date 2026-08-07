/**
 * Slice 6 — the Inbox flag branch, in exactly one place.
 *
 * `spotme.ui.inbox` (default OFF) is read HERE and nowhere else; the legacy
 * view carries a one-line call to `reactInbox()` and is otherwise unmodified
 * (ADR-035 §(f) #1, #2). With the flag off this returns null immediately —
 * no dynamic import runs, no app module loads — and the caller renders the
 * legacy view. That is the whole of §(g) tier-1 rollback.
 *
 * PERSISTED SHAPES stay app-side: every mutation below calls the SAME db/rooms
 * functions the legacy view calls, and the one write that spells a shape
 * (createGroup) spells the exact legacy convo shape — so flag-off always lands
 * on a store the legacy code can read (§(g) tier 3). The chat engine
 * (lib/rooms.js) is REUSED through this port, never rewritten.
 */
import { uiFlag, mountIsland, unmountIsland } from '../lib/island.js'

/**
 * @param {HTMLElement} root
 * @param {{ nav(p:string):void, openThread(id:string):void, toast(m:string):void }} ctx
 * @returns {null | (() => void)} null when the flag is off (render legacy);
 *          otherwise the view cleanup function.
 */
export function reactInbox (root, ctx) {
  if (!uiFlag('inbox')) return null
  mount(root, ctx)
  return () => { void unmountIsland() }
}

async function mount (root, ctx) {
  try {
    // Loaded only on the opted-in path: the flag-off cost of this module is zero.
    const [{ db, randomHex }, { lobby }, { reach }, { rooms }, { fmtDay }, { API_BASE }] =
      await Promise.all([
        import('../lib/db.js'),
        import('../lib/discovery.js'),
        import('../lib/reach.js'),
        import('../lib/rooms.js'),
        import('../lib/ui.js'),
        import('../lib/api.js')
      ])

    const tabOf = (convo) => {
      if (convo.mode === 'nearby') return 'nearby'
      if (convo.mode === 'bluetooth') return 'bt'
      return 'chats'
    }
    const convoName = (convo) => convo.title || convo.peer?.name || 'Chat'

    /* Snapshot cache, invalidated on any db/lobby notify (useSyncExternalStore
     * needs a stable object between notifies). */
    let snap = null
    const listeners = new Set()
    const invalidate = () => { snap = null; for (const fn of listeners) fn() }

    function buildSnapshot () {
      const online = new Set(lobby.peers().map((p) => p.id))
      const me = db.profile() || {}
      return {
        me: { name: me.name || 'Me', avatarUrl: me.avatar || null },
        rows: db.convos().map((convo) => ({
          id: convo.roomId,
          name: convoName(convo),
          avatarUrl: convo.peer?.avatar || null,
          preview: convo.last ? `${convo.last.fromMe ? 'You: ' : ''}${convo.last.text}` : 'No messages yet',
          timeLabel: fmtDay(convo.last?.ts || convo.created),
          unread: convo.unread || 0,
          online: convo.kind === 'demo' || (convo.peer?.id != null && online.has(convo.peer.id)),
          archived: Boolean(convo.archived),
          tab: tabOf(convo),
          group: convo.kind === 'group',
          blockable: convo.peer?.id != null
        }))
      }
    }

    function exportLine (message) {
      const when = new Date(message.ts).toLocaleString()
      const who = message.name || 'Unknown'
      let body = message.text || ''
      if (message.kind === 'image') body = '[photo]'
      else if (message.kind === 'voice') body = `[voice note ${message.dur || 0}s]`
      else if (message.kind === 'file') body = `[file] ${message.fileName || ''}`.trim()
      else if (message.kind === 'location') body = '[location]'
      return `[${when}] ${who}: ${body}`
    }

    const port = {
      subscribe (fn) {
        listeners.add(fn)
        const offDb = db.subscribe(invalidate)
        const offLobby = lobby.subscribe(invalidate)
        return () => { listeners.delete(fn); offDb(); offLobby() }
      },
      snapshot () {
        if (!snap) snap = buildSnapshot()
        return snap
      },

      openThread: (id) => ctx.openThread(id),
      nav: (p) => ctx.nav(p),
      toast: (m) => ctx.toast(m),

      setArchived: (id, archived) => db.setArchived(id, archived),
      deleteConvo (id) {
        rooms.leave(id)
        db.removeConvo(id)
      },
      blockPeer (id) {
        const convo = db.convos().find((c) => c.roomId === id)
        if (!convo?.peer?.id) return
        db.block(convo.peer.id, convoName(convo))
        rooms.leave(id)
        db.removeConvo(id)
        ctx.toast(`${convoName(convo)} blocked`)
      },
      exportChat (id) {
        try {
          const convo = db.convos().find((c) => c.roomId === id)
          const conn = rooms.ensure(id)
          const messages = conn ? conn.store.list() : []
          if (!messages.length) { ctx.toast('Nothing to export yet'); return }
          const blob = new Blob([messages.map(exportLine).join('\n') + '\n'], { type: 'text/plain' })
          const url = URL.createObjectURL(blob)
          const safe = (convo ? convoName(convo) : 'chat').replace(/[^\w\- ]+/g, '').trim() || 'chat'
          const link = document.createElement('a')
          link.href = url
          link.download = `${safe}.txt`
          document.body.appendChild(link)
          link.click()
          link.remove()
          setTimeout(() => URL.revokeObjectURL(url), 2000)
        } catch { ctx.toast('Could not export this chat') }
      },
      markAllRead () {
        for (const convo of db.convos()) db.clearUnread(convo.roomId)
      },
      createGroup (name) {
        try {
          const roomId = randomHex(8)
          const secret = randomHex(16)
          /* The exact convo shape legacy views/inbox.js writes — spelled here,
           * app-side, so the package can never diverge from it. */
          db.upsertConvo({
            roomId,
            secret,
            kind: 'group',
            mode: 'meet',
            title: name,
            peer: { id: null, name, avatar: null, lang: 'en' }
          })
          rooms.ensure(roomId)
          return roomId
        } catch { return null }
      },

      async searchUsers (uname) {
        try {
          const res = await fetch(`${API_BASE}/api/username?q=${encodeURIComponent(uname)}`)
          if (!res.ok) throw new Error(`registry ${res.status}`)
          const data = await res.json()
          const myId = db.profile()?.id
          const online = new Set(lobby.peers().map((p) => p.id))
          return (Array.isArray(data?.results) ? data.results : [])
            .filter((m) => m?.username && m.id !== myId)
            .map((m) => ({
              id: m.id, username: m.username, name: m.name || '', online: online.has(m.id)
            }))
        } catch { return [] }
      },
      existingDm (userId) {
        const convo = db.convos().find((c) => c.kind === 'dm' && c.peer?.id === userId)
        return convo ? convo.roomId : null
      },
      startChat (match, text) {
        // Match on username FIRST: the registry id goes stale on reinstall
        // (same rule, and comment, as the legacy view).
        const live = lobby.peers().find((p) => match.username && p.username === match.username) ||
          lobby.peers().find((p) => p.id === match.id)
        const peer = (live ? { ...live, username: match.username } : null) ||
          { id: match.id, name: match.name || match.username, username: match.username, avatar: null, lang: 'en' }
        try {
          return reach.reach(peer, text, 'meet')
        } catch { return null }
      }
    }

    await mountIsland('inbox', root, (mod) => mod.__mountInbox(port))
  } catch {
    const note = document.createElement('p')
    note.className = 'empty'
    note.textContent = 'Chats could not load.'
    root.appendChild(note)
  }
}
