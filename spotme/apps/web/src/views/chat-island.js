/**
 * Chat — the final-slice flag branch, session 1, in exactly one place.
 *
 * `spotme.ui.chat` (default OFF) is read HERE and nowhere else; the legacy
 * view carries a one-line call to `reactChat()` and is otherwise unmodified
 * (ADR-035 §(f) #1, #2). With the flag off this returns null immediately —
 * no dynamic import runs — and the caller renders the legacy view. That is
 * the whole of §(g) tier 1.
 *
 * SESSION 1 SCOPE: message list + composer core (text send, day dividers,
 * ticks, typing, retry). Media, sheets, calls, view-once and every
 * crypto-facing surface still render ONLY in the legacy view — a flag-on
 * device gets a reduced chat, which is why the flag stays owner-off.
 *
 * PERSISTED SHAPES stay app-side and UNCHANGED: every mutation below calls
 * the SAME lib/rooms.js functions the legacy view calls (sendMessage,
 * retryMessage, markRead, typing) — the chat engine is REUSED, never
 * rewritten, and nothing here writes a key the legacy code reads in any new
 * shape (§(g) tier 3). The row grammar this adapter produces is pinned
 * against the legacy stack by test/chat-characterization.test.js.
 */
import { uiFlag, mountIsland, unmountIsland } from '../lib/island.js'

/**
 * @param {HTMLElement} root
 * @param {{ nav(p:string):void, toast(m:string):void }} ctx
 * @param {string} roomId
 * @returns {null | (() => void)} null when the flag is off (render legacy).
 */
export function reactChat (root, ctx, roomId) {
  if (!uiFlag('chat')) return null
  let teardown = () => { void unmountIsland() }
  mount(root, ctx, roomId).then((extra) => { if (extra) teardown = extra })
  return () => teardown()
}

/** Stub labels for kinds session 1 does not render — same grammar as the
 *  engine's preview (chat-characterization pins it there). */
function stubLabel (m) {
  switch (m.kind) {
    case 'image': return m.viewOnce ? 'Private photo' : 'Photo'
    case 'video': return 'Video'
    case 'voice': return `Voice note (${m.dur || 0}s)`
    case 'file': return m.fileName || 'File'
    case 'location': return m.live ? 'Live location' : 'Location'
    default: return 'Message'
  }
}

async function mount (root, ctx, roomId) {
  try {
    // Loaded only on the opted-in path: flag-off cost of this module is zero.
    const [{ db }, { rooms }, { fmtTime, fmtDay }] = await Promise.all([
      import('../lib/db.js'),
      import('../lib/rooms.js'),
      import('../lib/ui.js')
    ])

    const convo = db.convo(roomId)
    const conn = convo && rooms.ensure(roomId)
    if (!conn) {
      ctx.toast('Conversation not found')
      ctx.nav('#/chat')
      return null
    }
    const myId = db.profile().id
    const group = convo.kind === 'group'

    const dayLabel = (ts) =>
      new Date(ts).toDateString() === new Date().toDateString() ? 'Today' : fmtDay(ts)

    function rowOf (m) {
      const mine = m.from === myId
      const isText = !m.kind || m.kind === 'text'
      const orig = m.replyTo ? conn.store.list().find((x) => x.id === m.replyTo) : null
      return {
        id: m.id,
        mine,
        kind: m.kind === 'system' ? 'system' : (isText ? 'text' : 'stub'),
        text: m.kind === 'system'
          ? (m.sys === 'timer' ? (m.secs ? '⏱ Timer messages on' : '⏱ Timer messages off') : '')
          : (isText ? m.text : stubLabel(m)),
        name: mine ? 'You' : (m.name || convo.peer?.name || ''),
        showName: group,
        timeLabel: fmtTime(m.ts),
        dayKey: new Date(m.ts).toDateString(),
        dayLabel: dayLabel(m.ts),
        // The pinned legacy derivation: failed wins; else readUpTo >= ts.
        status: m.failed ? 'failed' : (conn.readUpTo >= m.ts ? 'read' : 'sent'),
        edited: Boolean(m.editedAt),
        replyPreview: orig
          ? {
              name: orig.from === myId ? 'You' : (orig.name || ''),
              text: (!orig.kind || orig.kind === 'text') ? orig.text : stubLabel(orig)
            }
          : null
      }
    }

    /* Snapshot cache, invalidated on any conn/db notify (useSyncExternalStore
     * needs a stable object between notifies). */
    let snap = null
    const listeners = new Set()
    const invalidate = () => { snap = null; for (const fn of listeners) fn() }

    function buildSnapshot () {
      const current = db.convo(roomId) || convo
      const typing = conn.typing && conn.typing.until > Date.now() ? conn.typing : null
      let presenceLabel = ''
      if (conn.peerCount > 0) presenceLabel = 'Online'
      else if (current.peerSeen) presenceLabel = `Last seen ${fmtDay(current.peerSeen)}`
      return {
        header: {
          name: current.title || current.peer?.name || 'Chat',
          presenceLabel,
          avatarUrl: current.peer?.avatar || null
        },
        rows: conn.store.list().map(rowOf),
        typingLabel: typing ? `${typing.name || 'Someone'} is typing…` : ''
      }
    }

    const port = {
      subscribe (fn) {
        listeners.add(fn)
        const offConn = conn.on(invalidate)
        const offDb = db.subscribe(invalidate)
        return () => { listeners.delete(fn); offConn(); offDb() }
      },
      snapshot () {
        if (!snap) snap = buildSnapshot()
        return snap
      },

      sendText: (text) => { rooms.sendMessage(roomId, { text }); invalidate() },
      retry: (id) => { rooms.retryMessage(roomId, id); invalidate() },
      markRead: () => rooms.markRead(roomId),
      setTyping: (on) => rooms.typing(roomId, on),

      back: () => ctx.nav('#/chat'),
      toast: (m) => ctx.toast(m)
    }

    const host = document.createElement('div')
    host.className = 'island-host'
    root.appendChild(host)
    await mountIsland('chat', host, (mod) => mod.__mountChat(port))
    return () => { void unmountIsland() }
  } catch {
    ctx.toast('This screen could not load — turn the preview flag off to restore the classic chat')
    return null
  }
}
