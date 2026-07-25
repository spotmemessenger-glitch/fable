/**
 * Spot Me — Notifications screen (#/notifications). The one place every kind
 * of activity lands: chat requests from any section (with a where-from chip
 * and inline Accept/Reject), conversations carrying fresh unread, and active
 * people nearby right now. Every section head shows a live count; "See all"
 * jumps to the full screen. The shell owns the bottom nav — its bell badge is
 * the same three numbers as one count.
 */
import './notifications.css'
import { db } from '../lib/db.js'
import { lobby, distanceM, fmtDistance } from '../lib/discovery.js'
import { rooms } from '../lib/rooms.js'
import { notifyState, enableNotify } from '../lib/notify.js'
import { el, clear, avatar, fmtDay } from '../lib/ui.js'

const REQUEST_ROWS = 4           // request rows shown before "See all"
const NEARBY_ROWS = 6            // active-nearby rows shown before "See all"

/** Where a request came from — same wording as the Requests screen. */
const MODE_LABEL = { meet: 'General', nearby: 'Nearby', bluetooth: 'Bluetooth' }

const ICON = {
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18.2 8.9a6.2 6.2 0 00-12.4 0c0 5.7-2.2 7.3-2.2 7.3h16.8s-2.2-1.6-2.2-7.3"/><path d="M13.9 19.7a2.2 2.2 0 01-3.8 0"/></svg>'
}

const convoName = (convo) => convo.title || convo.peer?.name || 'Chat'

/** Non-archived conversations with fresh unread, newest activity first. */
function newChats () {
  return db.convos()
    .filter((convo) => !convo.archived && (convo.unread || 0) > 0)
    .sort((a, b) => (b.last?.ts || b.created || 0) - (a.last?.ts || a.created || 0))
}

export function render (root, ctx) {
  root.classList.add('v-notif')

  root.appendChild(el('div', { class: 'nhead' }, [
    el('h1', { text: 'Notifications' })
  ]))
  const bodyEl = el('div', { class: 'scroll-y nbody' })
  root.appendChild(bodyEl)

  function acceptRequest (request) {
    try {
      lobby.accept(request)
      rooms.ensure(request.roomId)
      ctx.openThread(request.roomId)
    } catch { ctx.toast('Could not accept that request') }
  }

  function declineRequest (request) {
    try { lobby.decline(request) } catch { ctx.toast('Could not reject that request') }
  }

  function sayHi (peer) {
    try {
      lobby.request(peer, 'Nearby chat request', 'nearby')
      ctx.toast(`Request sent to ${peer.name || 'them'}`)
    } catch { ctx.toast('Could not send that request') }
  }

  function sectionHead (key, label, count, navPath) {
    return el('div', { class: 'nsHead' }, [
      el('span', { class: 'nsChip', 'data-sec': key }, [
        el('span', { text: label }),
        el('span', { class: 'nsCt', text: count > 99 ? '99+' : String(count) })
      ]),
      el('button', {
        class: 'nsAll', type: 'button', html: 'See all ' + ICON.chevron,
        onclick: () => ctx.nav(navPath)
      })
    ])
  }

  function buildRequestRow (request, online, index) {
    return el('div', { class: 'nreq', style: `animation-delay:${Math.min(index, 8) * 32}ms` }, [
      avatar(request, 46, { dot: online.has(request.fromId) }),
      el('div', { class: 'nw' }, [
        el('div', { class: 'nrq1' }, [
          el('b', { text: request.name }),
          el('span', { class: 'nsrc', 'data-mode': request.mode || 'meet', text: MODE_LABEL[request.mode] || 'General' })
        ]),
        el('span', { text: request.text || 'wants to chat' })
      ]),
      el('div', { class: 'nacts' }, [
        el('button', { class: 'pill ok', type: 'button', text: 'Accept', onclick: () => acceptRequest(request) }),
        el('button', { class: 'pill no', type: 'button', text: 'Reject', onclick: () => declineRequest(request) })
      ])
    ])
  }

  function buildChatRow (convo, online, index) {
    const name = convoName(convo)
    const isOnline = convo.kind === 'demo' ||
      (convo.peer?.id != null && online.has(convo.peer.id))
    const unread = convo.unread || 0
    return el('button', {
      class: 'nchat', type: 'button',
      style: `animation-delay:${Math.min(index, 8) * 32}ms`,
      onclick: () => ctx.openThread(convo.roomId)
    }, [
      avatar(convo.peer || { name }, 46, { dot: isOnline }),
      el('div', { class: 'nw' }, [
        el('div', { class: 'nl1' }, [
          el('b', { text: name }),
          convo.kind === 'demo' ? el('span', { class: 'ndemo', text: 'demo' }) : null,
          el('span', { class: 'ntm', text: fmtDay(convo.last?.ts || convo.created) })
        ]),
        el('span', {
          class: 'npv',
          text: convo.last ? `${convo.last.fromMe ? 'You: ' : ''}${convo.last.text}` : 'No messages yet'
        })
      ]),
      el('span', { class: 'nbdg', text: unread > 99 ? '99+' : String(unread) })
    ])
  }

  function buildNearbyRow (peer, index) {
    const me = lobby.myPosition()
    const away = (me?.lat != null && peer.lat != null)
      ? `Active now · ${fmtDistance(distanceM(me, peer))} away`
      : 'Active now'
    return el('div', { class: 'nreq nnear', style: `animation-delay:${Math.min(index, 8) * 32}ms` }, [
      avatar(peer, 46, { dot: true }),
      el('div', { class: 'nw' }, [
        el('b', { text: peer.name || 'Someone' }),
        el('span', { text: away })
      ]),
      el('div', { class: 'nacts' }, [
        el('button', { class: 'pill ok', type: 'button', text: 'Say hi', onclick: () => sayHi(peer) })
      ])
    ])
  }

  function draw () {
    clear(bodyEl)
    const requests = db.requests()
    const chats = newChats()
    const nearby = lobby.strangers()

    // One-tap opt-in for device alerts — shown until the user decides.
    if (notifyState() === 'default') {
      bodyEl.appendChild(el('button', {
        class: 'nenable', type: 'button',
        onclick: async () => { await enableNotify(); draw() }
      }, [
        el('span', { class: 'nic', html: ICON.bell }),
        el('span', { class: 'nw' }, [
          el('b', { text: 'Turn on device notifications' }),
          el('span', { text: 'Requests, new messages and people nearby — alerted even from a background tab.' })
        ])
      ]))
    }

    if (!requests.length && !chats.length && !nearby.length) {
      bodyEl.appendChild(el('div', { class: 'nempty' }, [
        el('div', { class: 'nic', html: ICON.bell }),
        el('b', { text: 'You are all caught up' }),
        el('span', { text: 'Chat requests, fresh messages and active people nearby land here the moment they arrive.' })
      ]))
      return
    }

    const online = new Set(lobby.peers().map((p) => p.id))

    if (requests.length) {
      const section = el('div', { class: 'nsec' },
        [sectionHead('req', 'Requests', requests.length, '#/requests')])
      requests.slice(0, REQUEST_ROWS)
        .forEach((request, i) => section.appendChild(buildRequestRow(request, online, i)))
      bodyEl.appendChild(section)
    }

    if (chats.length) {
      const section = el('div', { class: 'nsec' },
        [sectionHead('chats', 'New chats', chats.length, '#/chat')])
      chats.forEach((convo, i) => section.appendChild(buildChatRow(convo, online, i)))
      bodyEl.appendChild(section)
    }

    if (nearby.length) {
      const section = el('div', { class: 'nsec' },
        [sectionHead('near', 'Active nearby', nearby.length, '#/discovery')])
      nearby.slice(0, NEARBY_ROWS)
        .forEach((peer, i) => section.appendChild(buildNearbyRow(peer, i)))
      bodyEl.appendChild(section)
    }
  }

  const unsubDb = db.subscribe(draw)
  const unsubLobby = lobby.subscribe(draw)
  draw()

  return function cleanup () {
    unsubDb()
    unsubLobby()
    // Leaving the screen acknowledges everything shown — the bell badge only
    // counts activity newer than this moment. The screen itself keeps listing
    // all sections in full; unsubscribe first so this commit cannot redraw.
    db.setSettings({ notifSeenTs: Date.now() })
    root.classList.remove('v-notif')
  }
}
