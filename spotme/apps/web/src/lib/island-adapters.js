/**
 * Slice-2 island adapters — Contacts, Notifications, Stories.
 *
 * Each adapter builds a PORT over the same lib code the legacy view uses
 * (db, lobby, reach, rooms, notify, push) and mounts the React surface via
 * the slice-1 island host. Behaviour parity comes from sharing the logic,
 * not copying it. Privacy: the nearby distance is formatted HERE with the
 * same helpers as the legacy view — raw coordinates never cross the port.
 *
 * §(g) tier 3: the ONLY storage write on these paths is the notifications
 * teardown's `db.setSettings({ notifSeenTs })` — the exact key and shape the
 * legacy view writes. Nothing new is persisted.
 */
import { db, randomHex } from './db.js'
import { lobby, distanceM, fmtDistance } from './discovery.js'
import { reach } from './reach.js'
import { rooms } from './rooms.js'
import { notifyState, enableNotify } from './notify.js'
import { subscribePush } from './push.js'
import { langName } from './translate.js'
import { actionSheet, fmtDay } from './ui.js'
import { mountIsland, unmountIsland } from './island.js'

const isDemo = (id) => typeof id === 'string' && id.startsWith('demo-')

/** Cache a computed snapshot; invalidate on any db/lobby notify. */
function makeStore (compute) {
  let snap = null
  const listeners = new Set()
  const invalidate = () => { snap = null; listeners.forEach((fn) => fn()) }
  return {
    subscribe (fn) {
      listeners.add(fn)
      const unsubs = [db.subscribe(invalidate), lobby.subscribe(invalidate)]
      return () => { listeners.delete(fn); unsubs.forEach((u) => u()) }
    },
    snapshot () { return (snap ??= compute()) }
  }
}

const meView = () => {
  const profile = db.profile() || {}
  return { name: profile.name || 'Me', avatarUrl: profile.avatar || null }
}

function mount (slice, root, port) {
  const host = document.createElement('div')
  host.className = 'island-host'
  root.appendChild(host)
  const picks = {
    contacts: (mod) => mod.__mountContacts(port),
    notifications: (mod) => mod.__mountNotifications(port),
    stories: (mod) => mod.__mountStories(port)
  }
  mountIsland(slice, host, picks[slice]).catch(() => {
    host.textContent = 'This screen could not load. Turn the preview flag off to restore the classic view.'
  })
}

/* ------------------------------------------------------------- contacts */

export function contactsIsland (root, ctx) {
  const store = makeStore(() => ({
    me: meView(),
    contacts: db.contacts()
      .filter((c) => !db.isBlocked(c.id) && !isDemo(c.id))
      .map((c) => ({
        id: c.id,
        name: c.name,
        avatarUrl: c.avatar || null,
        online: lobby.peers().some((p) => p.id === c.id),
        langLabel: langName(c.lang || 'en')
      }))
  }))

  const port = {
    ...store,
    openContact (id) {
      const contact = db.contacts().find((c) => c.id === id)
      if (!contact) return
      const existing = db.convos().find((c) =>
        (c.kind === 'dm' || c.kind === 'demo') && c.peer?.id === id)
      if (existing) { ctx.openThread(existing.roomId); return }
      const live = lobby.peers().find((p) => p.id === id)
      if (live) {
        actionSheet([{
          label: 'Send chat request',
          fn () {
            try { ctx.openThread(reach.reach(live, 'Hi again!', 'meet')) } catch { ctx.toast('Could not send the request') }
          }
        }], contact.name)
        return
      }
      ctx.toast('They are offline right now — request them from Discovery when they are online.')
    },
    block (id) {
      const contact = db.contacts().find((c) => c.id === id)
      db.block(id, contact?.name)
      ctx.toast(`${contact?.name || 'Contact'} blocked`)
    },
    remove (id) { db.removeContact(id); ctx.toast('Contact removed') },
    async invite () {
      try {
        const roomId = randomHex(8)
        const secret = randomHex(16)
        db.upsertConvo({
          roomId,
          secret,
          kind: 'dm',
          mode: 'meet',
          peer: { id: null, name: 'Invited chat', avatar: null, lang: 'en' },
          title: 'Invited chat',
          last: { text: 'Invite link created', ts: Date.now(), fromMe: true }
        })
        rooms.ensure(roomId)
        const url = `${location.origin}${location.pathname}#r=${roomId}&k=${secret}`
        if (navigator.share) {
          try { await navigator.share({ title: 'Spot Me', text: 'Chat with me on Spot Me', url }) } catch (err) {
            if (!err || err.name !== 'AbortError') {
              await navigator.clipboard.writeText(url).then(() => ctx.toast('Invite link copied'), () => ctx.toast('Could not share the link'))
            }
          }
        } else {
          await navigator.clipboard.writeText(url).then(() => ctx.toast('Invite link copied'), () => ctx.toast('Could not share the link'))
        }
        ctx.openThread(roomId)
      } catch { ctx.toast('Could not create the invite') }
    },
    openDiscovery () { ctx.nav('#/discovery') }
  }

  mount('contacts', root, port)
  return () => { void unmountIsland() }
}

/* -------------------------------------------------------- notifications */

export function notificationsIsland (root, ctx) {
  const store = makeStore(() => {
    const online = new Set(lobby.peers().map((p) => p.id))
    const me = lobby.myPosition()
    return {
      enablePrompt: notifyState() === 'default',
      chats: db.convos()
        .filter((c) => !c.archived && (c.unread || 0) > 0)
        .sort((a, b) => (b.last?.ts || b.created || 0) - (a.last?.ts || a.created || 0))
        .map((c) => ({
          roomId: c.roomId,
          name: c.title || c.peer?.name || 'Chat',
          avatarUrl: c.peer?.avatar || null,
          demo: c.kind === 'demo',
          online: c.kind === 'demo' || (c.peer?.id != null && online.has(c.peer.id)),
          unread: c.unread || 0,
          timeLabel: fmtDay(c.last?.ts || c.created),
          preview: c.last ? `${c.last.fromMe ? 'You: ' : ''}${c.last.text}` : 'No messages yet'
        })),
      nearby: lobby.strangers().slice(0, 6).map((p) => ({
        id: p.id,
        name: p.name || 'Someone',
        avatarUrl: p.avatar || null,
        awayLabel: (me?.lat != null && p.lat != null)
          ? `Active now · ${fmtDistance(distanceM(me, p))} away`
          : 'Active now'
      }))
    }
  })

  const port = {
    ...store,
    openThread: (roomId) => ctx.openThread(roomId),
    sayHi (peerId) {
      const peer = lobby.strangers().find((p) => p.id === peerId)
      if (!peer) return
      try { ctx.openThread(reach.reach(peer, 'Hi! Nearby on Spot Me.', 'nearby')) } catch { ctx.toast('Could not start that chat') }
    },
    async enableAlerts () {
      const result = await enableNotify()
      if (result === 'granted') await subscribePush().catch(() => {})
    },
    seeAllChats: () => ctx.nav('#/chat'),
    seeAllNearby: () => ctx.nav('#/discovery')
  }

  mount('notifications', root, port)
  return () => {
    void unmountIsland()
    // Same acknowledgement, same key, same shape as the legacy cleanup.
    db.setSettings({ notifSeenTs: Date.now() })
  }
}

/* -------------------------------------------------------------- stories */

export function storiesIsland (root, ctx) {
  const INK_RINGS = 2
  const store = makeStore(() => ({
    me: meView(),
    people: db.contacts().map((c, i) => ({
      id: c.id,
      name: c.name,
      avatarUrl: c.avatar || null,
      seen: i >= INK_RINGS
    }))
  }))

  const port = {
    ...store,
    openProfile: () => ctx.nav('#/settings'),
    openChats: () => ctx.nav('#/chat'),
    myStory: () => ctx.toast('Posting a story arrives with the native app'),
    openPerson (id) {
      const person = db.contacts().find((c) => c.id === id)
      const convo = db.convos().find((c) => c.peer?.id === id)
      if (convo) ctx.openThread(convo.roomId)
      else ctx.toast(`No chat with ${person?.name || 'them'} yet — find them in Discovery`)
    }
  }

  mount('stories', root, port)
  return () => { void unmountIsland() }
}
