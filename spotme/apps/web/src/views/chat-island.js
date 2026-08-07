/**
 * Chat — the final-slice flag branch, in exactly one place.
 *
 * `spotme.ui.chat` (default OFF) is read HERE and nowhere else; the legacy
 * view carries a one-line call to `reactChat()` and is otherwise unmodified
 * (ADR-035 §(f) #1, #2). With the flag off this returns null immediately —
 * no dynamic import runs — and the caller renders the legacy view. That is
 * the whole of §(g) tier 1.
 *
 * SESSION 1: message list + composer core. SESSION 2: media rows (photo,
 * view-once locked tile, voice, file, location), the attach + message
 * sheets, reactions, reply composition. Calls, translation composer modes,
 * live location sharing, group management and every crypto-facing surface
 * still render ONLY in the legacy view — the flag stays owner-off.
 *
 * PERSISTED SHAPES stay app-side and UNCHANGED: the port built in
 * chat-island-port.js calls the SAME lib/rooms.js functions the legacy view
 * calls — the chat engine is REUSED, never rewritten (§(g) tier 3). The row
 * grammar is pinned by test/chat-characterization.test.js; the view-once
 * burn semantics by test/chat-viewonce-react.test.js.
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

async function mount (root, ctx, roomId) {
  try {
    // Loaded only on the opted-in path: flag-off cost of this module is zero.
    const [{ db }, { rooms }, { fmtTime, fmtDay }, { buildChatPort }, { browserMediaUI }] =
      await Promise.all([
        import('../lib/db.js'),
        import('../lib/rooms.js'),
        import('../lib/ui.js'),
        import('./chat-island-port.js'),
        import('./chat-island-media.js')
      ])

    const port = buildChatPort({ db, rooms, fmtTime, fmtDay }, ctx, roomId, browserMediaUI(root))
    if (!port) {
      ctx.toast('Conversation not found')
      ctx.nav('#/chat')
      return null
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
