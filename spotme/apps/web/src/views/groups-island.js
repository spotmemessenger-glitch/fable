/**
 * Slice 3 — the Groups flag branch, in exactly one place.
 *
 * `spotme.ui.groups` (default OFF) is read HERE and nowhere else; the legacy
 * views each carry a one-line call to `reactGroups()` and are otherwise
 * unmodified (ADR-035 §(f) #1, #2). With the flag off this returns null
 * immediately — no dynamic import runs, no app module loads — and the caller
 * renders the legacy view. That is the whole of §(g) tier-1 rollback.
 *
 * PERSISTED SHAPES stay app-side: the adapters below hand the island the SAME
 * db functions and the SAME convo shape the legacy views write, so flag-off
 * always lands on a store the legacy code can read (§(g) tier 3).
 */
import { uiFlag, mountIsland, unmountIsland } from '../lib/island.js'

/**
 * @param {HTMLElement} root
 * @param {{ nav(p:string):void, openThread(id:string):void, toast(m:string):void }} ctx
 * @param {'list'|'manage'} screen
 * @param {string} [groupId]
 * @returns {null | (() => void)} null when the flag is off (render legacy);
 *          otherwise the view cleanup function.
 */
export function reactGroups (root, ctx, screen, groupId) {
  if (!uiFlag('groups')) return null
  mount(root, ctx, screen, groupId)
  return () => { void unmountIsland() }
}

async function mount (root, ctx, screen, groupId) {
  try {
    // Loaded only on the opted-in path, mirroring the island host's own
    // dynamic-import rule: the flag-off cost of this module is zero.
    const [{ groupsApi }, perms, { db, randomHex }, { rooms }, { searchUsers }] = await Promise.all([
      import('../lib/groups-api.js'),
      import('../lib/group-perms.js'),
      import('../lib/db.js'),
      import('../lib/rooms.js'),
      import('../lib/api.js')
    ])

    const deps = {
      api: groupsApi,
      /* lib/group-perms.js, reused verbatim — the module IS the port. */
      perms,
      local: {
        convos: () => db.convos(),
        /* The exact convo shape views/groups.js and views/group-new.js write.
         * Spelled here, app-side, so the package can never diverge from it. */
        upsertGroupConvo: ({ roomId, secret, name, groupId: gid }) => db.upsertConvo({
          roomId,
          secret,
          kind: 'group',
          mode: 'meet',
          title: name,
          groupId: gid,
          peer: { id: null, name, avatar: null, lang: 'en' }
        }),
        removeConvo: (roomId) => db.removeConvo(roomId),
        setArchived: (roomId, archived) => db.setArchived(roomId, archived),
        subscribe: (cb) => db.subscribe(cb),
        newId: () => randomHex(16)
      },
      rooms: {
        ensure: (roomId) => rooms.ensure(roomId),
        leave: (roomId) => { try { rooms.leave(roomId) } catch { /* never connected */ } }
      },
      host: {
        nav: ctx.nav,
        openThread: ctx.openThread,
        toast: ctx.toast,
        inviteUrl: (convo, name) =>
          `${location.origin}${location.pathname}#r=${convo.roomId}&k=${convo.secret}` +
          `&g=${encodeURIComponent(name || 'Group')}`,
        share: (url, name) => shareLink(url, name, ctx.toast)
      },
      people: { search: (q) => searchUsers(q) }
    }

    await mountIsland('groups', root, (mod) => mod.__mountGroups({ deps, screen, groupId }))
  } catch {
    const note = document.createElement('p')
    note.className = 'g-sub'
    note.textContent = 'Groups could not load.'
    root.appendChild(note)
  }
}

/** navigator.share when available, clipboard otherwise. Never throws. */
async function shareLink (url, name, toast) {
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Spot Me', text: `Join ${name || 'our group'} on Spot Me`, url })
      return
    } catch (err) {
      if (err && err.name === 'AbortError') return
    }
  }
  try {
    await navigator.clipboard.writeText(url)
    toast('Invite link copied')
  } catch {
    toast('Could not share the link')
  }
}
