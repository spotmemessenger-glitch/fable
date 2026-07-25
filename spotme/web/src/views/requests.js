/**
 * Spot Me — Friend requests screen (#/requests). The bottom-bar slot that
 * used to hold Groups: every pending request in one place, newest first,
 * Accept before Reject, with the mode it arrived through.
 */
import './requests.css'
import { db } from '../lib/db.js'
import { lobby } from '../lib/discovery.js'
import { rooms } from '../lib/rooms.js'
import { el, clear, avatar, fmtDay } from '../lib/ui.js'

const MODE_LABEL = { meet: 'General', nearby: 'Nearby', bluetooth: 'Bluetooth' }

export function render (root, ctx) {
  root.classList.add('v-requests')

  const listEl = el('div', { class: 'scroll-y rlist' })
  root.appendChild(el('div', { class: 'rhead' }, [
    el('h1', { text: 'Requests' }),
    el('p', { class: 'rsub', text: 'People who want to chat with you. Accepting adds them to Contacts.' })
  ]))
  root.appendChild(listEl)

  function accept (request) {
    lobby.accept(request)
    rooms.ensure(request.roomId)
    ctx.toast(`${request.name} added to Contacts`)
    ctx.openThread(request.roomId)
  }

  function draw () {
    clear(listEl)
    const requests = db.requests()
    if (!requests.length) {
      listEl.appendChild(el('div', { class: 'rempty' }, [
        el('div', { class: 'ric', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><circle cx="8.4" cy="9" r="3.1"/><circle cx="16.6" cy="10.2" r="2.4"/><path d="M2.6 19.4a5.8 5.8 0 0111.6 0"/><path d="M15 19.4a4.6 4.6 0 016.4-3.6"/></svg>' }),
        el('b', { text: 'No requests right now' }),
        el('span', { text: 'When someone waves at you in Discovery or finds your username, it lands here — and the bar icon turns red.' })
      ]))
      return
    }
    requests.forEach((request, i) => {
      listEl.appendChild(el('div', {
        class: 'rrow',
        style: `animation-delay:${Math.min(i, 8) * 30}ms`
      }, [
        avatar(request, 52, { dot: lobby.peers().some((p) => p.id === request.fromId) }),
        el('div', { class: 'rmid' }, [
          el('div', { class: 'rl1' }, [
            el('b', { text: request.name }),
            el('span', { class: 'rchip', text: MODE_LABEL[request.mode] || 'Chat' }),
            el('span', { class: 'rtime', text: fmtDay(request.ts) })
          ]),
          request.text ? el('div', { class: 'rtxt', text: request.text }) : null,
          el('div', { class: 'racts' }, [
            el('button', { class: 'pill ok', type: 'button', text: 'Accept', onclick: () => accept(request) }),
            el('button', { class: 'pill no', type: 'button', text: 'Reject', onclick: () => lobby.decline(request) })
          ])
        ])
      ]))
    })
  }

  const unsubDb = db.subscribe(draw)
  const unsubLobby = lobby.subscribe(draw)
  draw()

  return function cleanup () {
    unsubDb()
    unsubLobby()
    root.classList.remove('v-requests')
  }
}
